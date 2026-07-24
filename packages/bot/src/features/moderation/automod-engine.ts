/**
 * Auto-Mod Engine — Message scanning pipeline.
 *
 * Scans every message against enabled auto-mod rules.
 * Rules are cached in Valkey to avoid DB hits per message.
 *
 * Architecture doc §18.2
 */

import type { Message, GuildMember } from 'discord.js';
import type { SomniClient } from '../../client.js';
import type {
  DbAutomodRule,
  AutoModRuleType,
  WordFilterConfig,
  LinkFilterConfig,
  InviteFilterConfig,
  SpamFilterConfig,
  DuplicateFilterConfig,
  CapsFilterConfig,
  MentionSpamConfig,
  NewlineSpamConfig,
  EscalationStep,
} from '@somnibot/shared';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { executeAutoModAction } from './automod-actions.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('AutoModEngine');

const RULES_CACHE_PREFIX = 'automod:rules:';
const RULES_CACHE_TTL = 60; // seconds

// ── Spam tracking (Valkey-backed) ──

const SPAM_KEY_PREFIX = 'automod:spam:';
const DUP_KEY_PREFIX = 'automod:dup:';

/**
 * Load auto-mod rules from cache or database.
 */
async function loadRules(client: SomniClient, guildId: string): Promise<DbAutomodRule[]> {
  const cacheKey = `${RULES_CACHE_PREFIX}${guildId}`;

  try {
    const cached = await client.valkey.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as DbAutomodRule[];
    }
  } catch {
    // Cache miss — load from DB
  }

  const { data, error } = await client.supabase
    .from('automod_rules')
    .select('*')
    .eq('guild_id', guildId)
    .eq('enabled', true)
    .limit(1000);

  if (error) {
    log.error('Failed to load rules:', error.message);
    return [];
  }

  // Sort by priority descending — higher priority rules execute first
  const rules = ((data ?? []) as DbAutomodRule[]).sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );

  // V7 Audit §14.P3b — warn when a guild has an unusually large rule set.
  // High rule counts increase per-message evaluation time and may indicate
  // misconfiguration (e.g., auto-generated rules that should be consolidated).
  /* v8 ignore next 5 -- defensive warning; only fires with 100+ rules per guild */
  if (rules.length > 100) {
    log.warn(
      `Guild ${guildId} has ${rules.length} active automod rules (>100). ` +
      'Consider consolidating rules for better performance.',
    );
  }

  try {
    await client.valkey.setex(
      cacheKey,
      RULES_CACHE_TTL,
      JSON.stringify(rules),
    );
  } catch {
    // Cache write failure — non-fatal
  }

  return rules;
}

/**
 * Invalidate the auto-mod rules cache for a specific guild.
 * Called when rules are updated via dashboard.
 *
 * @param guildId - If omitted, a scan-based wildcard delete is attempted
 *                  as a fallback (e.g. during global config reloads).
 */
export async function invalidateRulesCache(client: SomniClient, guildId?: string): Promise<void> {
  try {
    if (guildId) {
      await client.valkey.del(`${RULES_CACHE_PREFIX}${guildId}`);
    } else {
      // Wildcard fallback: delete all guild-scoped automod rule caches.
      // Uses SCAN to avoid blocking Valkey with a KEYS command.
      let cursor = '0';
      do {
        const [nextCursor, keys] = await client.valkey.scan(cursor, 'MATCH', `${RULES_CACHE_PREFIX}*`, 'COUNT', '100');
        cursor = nextCursor;
        if (keys.length > 0) {
          await client.valkey.del(...keys);
        }
      } while (cursor !== '0');
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Check if a member is exempt from a rule.
 */
function isExempt(
  member: GuildMember,
  rule: DbAutomodRule,
  channelId: string,
): boolean {
  // Check exempt channels
  if (rule.exempt_channels.includes(channelId)) return true;

  // Check exempt roles
  for (const roleId of rule.exempt_roles) {
    if (member.roles.cache.has(roleId)) return true;
  }

  // Moderator+ are always exempt by default (check for MANAGE_MESSAGES or ADMINISTRATOR)
  if (member.permissions.has('ManageMessages') || member.permissions.has('Administrator')) {
    return true;
  }

  return false;
}

/**
 * Process a message through the auto-mod pipeline.
 *
 * Returns true if the message was handled (deleted/action taken).
 */
// V11 Re-Audit L-3: Per-message aggregate time budget.
// Individual regex evaluations are capped at 250ms each (see checkWordFilter),
// but N rules can still block the event loop for an unacceptable duration in
// aggregate. This deadline caps the total time spent checking ALL rules on a
// single message; a rule whose regexes hit their timeout burns budget and the
// remaining rules are skipped with a warning.
// PR #269 review (P2): the same deadline is also enforced BETWEEN WORDS
// inside checkWordFilter — config.words is owner-editable with no per-rule
// cap, so without the word-level check a single regex-mode rule with a few
// pathological entries could block for words.length × 250ms before the
// between-rules check ever ran.
// Catalog defaults for the owner-tunable evaluation budgets. Used as fallbacks
// when guild_config has no override (automod_message_budget_ms 100-2000 default
// 500, automod_regex_budget_ms 50-250 default 250).
const MESSAGE_RULE_BUDGET_MS = 500;
const REGEX_EVAL_BUDGET_MS = 250;

export async function processMessage(
  client: SomniClient,
  message: Message,
  modConfig: {
    escalationChain: EscalationStep[];
    infractionExpiryDays: number;
    modLogChannelId: string | null;
    automodEnabled: boolean;
    automodMode: 'observe' | 'enforce';
    automodMessageBudgetMs?: number;
    automodRegexBudgetMs?: number;
  },
): Promise<boolean> {
  // Quick bail-outs
  if (!message.guild || !message.member) return false;
  if (message.author.bot) return false;
  const rules = await loadRules(client, message.guild.id);
  if (rules.length === 0) return false;

  const member = message.member;
  const channelId = message.channel.id;
  // Owner-configurable per-message aggregate budget (falls back to the default).
  const messageBudgetMs = modConfig.automodMessageBudgetMs ?? MESSAGE_RULE_BUDGET_MS;
  const regexBudgetMs = modConfig.automodRegexBudgetMs ?? REGEX_EVAL_BUDGET_MS;
  const deadline = Date.now() + messageBudgetMs;

  for (const rule of rules) {
    // V11 Re-Audit L-3: Bail out if cumulative rule checking exceeds budget
    if (Date.now() > deadline) {
      log.warn(`Automod budget exhausted (${messageBudgetMs}ms) — skipped remaining rules for message ${message.id}`);
      break;
    }

    if (isExempt(member, rule, channelId)) continue;

    const violation = await checkRule(client, message, rule, deadline, regexBudgetMs);
    if (violation) {
      // Idempotency fence: a re-delivered messageCreate (Discord gateway RESUME)
      // must not double-enforce (second delete / second infraction row). Claim
      // the message id once via SET NX; a replay finds the key already set and is
      // a no-op. Keyed on message.id (not author), so distinct messages are never
      // suppressed. Fails open (enforces) when Valkey is unavailable rather than
      // silently dropping enforcement.
      try {
        const fresh = await client.valkey.set(
          `automod:handled:${message.guild.id}:${message.id}`,
          '1',
          'EX',
          900,
          'NX',
        );
        if (!fresh) return true;
      } catch {
        // Valkey error — proceed with enforcement (fail open).
      }
      await executeAutoModAction(client, message, rule, violation, modConfig);
      return true;
    }
  }

  return false;
}

/**
 * Check a single rule against a message.
 * Returns the violation description, or null if no violation.
 *
 * @param deadline - Wall-clock deadline (epoch ms) from processMessage's
 *                   per-message budget; enforced between words in
 *                   checkWordFilter (PR #269 review).
 */
async function checkRule(
  client: SomniClient,
  message: Message,
  rule: DbAutomodRule,
  deadline: number,
  regexBudgetMs: number,
): Promise<string | null> {
  switch (rule.type) {
    case 'word_filter':
      return checkWordFilter(message.content, rule.config as WordFilterConfig, deadline, regexBudgetMs);
    case 'link_filter':
      return checkLinkFilter(message.content, rule.config as LinkFilterConfig);
    case 'invite_filter':
      return await checkInviteFilter(client, message.content, rule.config as InviteFilterConfig, message.guild?.id);
    case 'spam_filter':
      return await checkSpamFilter(client, message, rule.config as SpamFilterConfig);
    case 'duplicate_filter':
      return await checkDuplicateFilter(client, message, rule.config as DuplicateFilterConfig);
    case 'caps_filter':
      return checkCapsFilter(message.content, rule.config as CapsFilterConfig);
    case 'mention_spam':
      return checkMentionSpam(message, rule.config as MentionSpamConfig);
    case 'newline_spam':
      return checkNewlineSpam(message.content, rule.config as NewlineSpamConfig);
    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════
// Rule Checkers
// ═══════════════════════════════════════════════════════════

/**
 * Word Filter — exact, wildcard, or regex matching.
 */
function checkWordFilter(
  content: string,
  config: WordFilterConfig,
  deadline: number,
  regexBudgetMs: number = REGEX_EVAL_BUDGET_MS,
): string | null {
  if (!config.words || config.words.length === 0) return null;

  const text = config.caseSensitive ? content : content.toLowerCase();

  for (const [index, word] of config.words.entries()) {
    // PR #269 review (P2): enforce the per-message budget BETWEEN WORDS, not
    // just between rules. In regex mode each pathological entry can burn a
    // full 250ms vm timeout while the loop marches on, and config.words is
    // owner-editable with no per-rule cap. Shares processMessage's wall-clock
    // deadline (MESSAGE_RULE_BUDGET_MS) and the same `Date.now() > deadline`
    // check. Fails toward "no match": a budget bail never punishes the user.
    if (Date.now() > deadline) {
      log.warn(
        `Automod word-filter budget exceeded (${MESSAGE_RULE_BUDGET_MS}ms) — ` +
        `skipped ${config.words.length - index} remaining word(s) in rule; treating as no match`,
      );
      return null;
    }

    const target = config.caseSensitive ? word : word.toLowerCase();

    switch (config.matchMode) {
      case 'exact': {
        // Word boundary match
        const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, config.caseSensitive ? '' : 'i');
        if (regex.test(content)) {
          return `Matched banned word: "${word}"`;
        }
        break;
      }
      case 'wildcard': {
        // Convert wildcards to regex: * → .*, ? → .
        const pattern = target
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.');
        const regex = new RegExp(pattern, config.caseSensitive ? '' : 'i');
        if (regex.test(content)) {
          return `Matched banned pattern: "${word}"`;
        }
        break;
      }
      case 'regex': {
        try {
          // Reject patterns with known catastrophic-backtracking shapes:
          // nested quantifiers like (a+)+, (.*)*, (\w+\s?)*, etc.
          if (/(\(.*[+*].*\))[+*]/.test(word) || /(\.\*){2,}/.test(word)) {
            log.warn(`Rejected unsafe regex pattern: "${word}"`);
            break;
          }

          const regex = new RegExp(word, config.caseSensitive ? '' : 'i');

          // V6 Audit H-5: Run regex in a sandboxed VM context with a hard
          // timeout. The previous approach checked elapsed time AFTER
          // regex.test() completed, which didn't protect against catastrophic
          // backtracking blocking the event loop. This matches the approach
          // used in automations/condition-evaluator.ts.
          //
          // SECURITY: node:vm is NOT a security sandbox (per Node.js docs).
          // We only use it for timeout enforcement — the evaluated expression
          // is a hardcoded string, never user input. microtaskMode ensures
          // microtasks scheduled inside the context are drained within the
          // same timeout boundary, preventing a class of timeout bypass.
          // TIMEOUT: 250ms. The original 50ms was an uncalibrated bound:
          // under heavy CPU contention (parallel test workers, busy host)
          // vm context setup + scheduling alone can exceed 50ms, so even
          // trivial patterns misclassified as timeouts — flaky tests, and in
          // production a loaded host could make legit rules silently fail to
          // match. Rules are guild-owner configured (dashboard writes are
          // requireGuildOwner-gated), known-catastrophic shapes are rejected
          // above, and input is sliced, so 250ms still firmly bounds
          // backtracking. Keep in sync with condition-evaluator.ts.
          const input = content.slice(0, 2000);
          const matched = runInNewContext(
            'regex.test(input)',
            { regex, input },
            { timeout: regexBudgetMs, microtaskMode: 'afterEvaluate' },
          );

          if (matched) {
            return `Matched regex filter: "${word}"`;
          }
        } catch (err) {
          // Timeout, invalid regex, or other error — skip
          if (err instanceof Error && err.message?.includes('timed out')) {
            log.warn(`Regex pattern "${word}" timed out after ${regexBudgetMs}ms — skipping for safety`);
          }
        }
        break;
      }
    }
  }

  return null;
}

/**
 * Link Filter — whitelist or blacklist mode.
 */
function checkLinkFilter(
  content: string,
  config: LinkFilterConfig,
): string | null {
  // Extract URLs from message
  const urlRegex = /https?:\/\/(?:[\w-]+\.)+[\w-]+(?:\/\S*)?/gi;
  const urls = content.match(urlRegex);
  if (!urls || urls.length === 0) return null;

  for (const url of urls) {
    let domain: string;
    try {
      domain = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }

    const domains = (config.domains ?? []).map((d) => d.toLowerCase());

    if (config.mode === 'whitelist') {
      // Only allow listed domains
      const allowed = domains.some((d) => domain === d || domain.endsWith(`.${d}`));
      if (!allowed) {
        return `Link from non-whitelisted domain: ${domain}`;
      }
    } else {
      // Block listed domains
      const blocked = domains.some((d) => domain === d || domain.endsWith(`.${d}`));
      if (blocked) {
        return `Link from blocked domain: ${domain}`;
      }
    }
  }

  return null;
}

/**
 * Invite Filter — block Discord invite links.
 */
// Cache for resolved invite codes → guild IDs (avoids repeat API calls)
const _inviteGuildCache = new Map<string, { guildId: string | null; expiresAt: number }>();
const INVITE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
/**
 * V11 Audit H-1 + M-1: Cap the invite cache to prevent unbounded growth.
 * Evicts oldest entries when the cap is reached, and prunes expired entries
 * lazily on each check to avoid retaining stale one-off invite lookups.
 */
const MAX_INVITE_CACHE_SIZE = 5_000;

async function checkInviteFilter(
  client: SomniClient,
  content: string,
  config: InviteFilterConfig,
  guildId?: string,
): Promise<string | null> {
  // V11 Audit M-1: Lazily prune expired entries on each filter call to avoid
  // retaining stale invite codes that are never checked again.
  const now = Date.now();
  for (const [code, entry] of _inviteGuildCache) {
    if (entry.expiresAt <= now) _inviteGuildCache.delete(code);
  }

  const inviteRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/(\S+)/gi;
  const matches = [...content.matchAll(inviteRegex)];

  if (matches.length === 0) return null;

  if (!config.allowOwnServer || !guildId) {
    // Block all invites
    return 'Discord invite link detected';
  }

  // allowOwnServer is enabled — resolve each invite to check its guild
  for (const match of matches) {
    const code = match[1]?.split(/[?\s]/)[0]; // strip query params / trailing spaces
    if (!code) continue;

    // Check cache first
    const cached = _inviteGuildCache.get(code);
    if (cached && cached.expiresAt > now) {
      if (cached.guildId === guildId) continue; // own server — allow
      return 'Discord invite link detected (external server)';
    }

    // Resolve the invite via Discord API
    try {
      const invite = await client.fetchInvite(code);
      const inviteGuildId = invite.guild?.id ?? null;

      // V11 Audit H-1: Evict oldest entry when cache exceeds cap.
      if (_inviteGuildCache.size >= MAX_INVITE_CACHE_SIZE) {
        const oldest = _inviteGuildCache.keys().next().value;
        if (oldest) _inviteGuildCache.delete(oldest);
      }

      // Cache the result
      _inviteGuildCache.set(code, {
        guildId: inviteGuildId,
        expiresAt: Date.now() + INVITE_CACHE_TTL,
      });

      if (inviteGuildId === guildId) continue; // own server — allow
      return 'Discord invite link detected (external server)';
    } catch {
      // V11 Audit H-1: Evict oldest entry when cache exceeds cap.
      if (_inviteGuildCache.size >= MAX_INVITE_CACHE_SIZE) {
        const oldest = _inviteGuildCache.keys().next().value;
        if (oldest) _inviteGuildCache.delete(oldest);
      }

      // Invalid or expired invite — flag it
      _inviteGuildCache.set(code, {
        guildId: null,
        expiresAt: Date.now() + INVITE_CACHE_TTL,
      });
      return 'Discord invite link detected';
    }
  }

  // All invites were for the current server
  return null;
}

/**
 * Spam Filter — rapid message sending (X messages in Y seconds).
 * Uses Valkey for tracking.
 */
async function checkSpamFilter(
  client: SomniClient,
  message: Message,
  config: SpamFilterConfig,
): Promise<string | null> {
  const maxMessages = config.maxMessages ?? 5;
  const intervalSeconds = config.intervalSeconds ?? 5;

  const key = `${SPAM_KEY_PREFIX}${message.guild!.id}:${message.author.id}`;

  try {
    const count = await client.valkey.incr(key);
    if (count === 1) {
      // First message — set expiry
      await client.valkey.expire(key, intervalSeconds);
    }

    if (count > maxMessages) {
      return `Spam filter triggered: ${count} messages in ${intervalSeconds}s (limit: ${maxMessages})`;
    }
  } catch {
    // Valkey error — skip this check
  }

  return null;
}

/**
 * Duplicate Filter — same message repeated.
 */
async function checkDuplicateFilter(
  client: SomniClient,
  message: Message,
  config: DuplicateFilterConfig,
): Promise<string | null> {
  const threshold = config.threshold ?? 3;
  const intervalSeconds = config.intervalSeconds ?? 30;

  // Hash the message content for the key
  const contentHash = simpleHash(message.content.toLowerCase().trim());
  const key = `${DUP_KEY_PREFIX}${message.guild!.id}:${message.author.id}:${contentHash}`;

  try {
    const count = await client.valkey.incr(key);
    if (count === 1) {
      await client.valkey.expire(key, intervalSeconds);
    }

    if (count >= threshold) {
      return `Duplicate message detected: sent ${count} times in ${intervalSeconds}s`;
    }
  } catch {
    // Valkey error — skip this check
  }

  return null;
}

/**
 * Caps Filter — excessive uppercase.
 */
function checkCapsFilter(
  content: string,
  config: CapsFilterConfig,
): string | null {
  const maxPercent = config.maxPercent ?? 70;
  const minLength = config.minLength ?? 10;

  if (content.length < minLength) return null;

  const letters = content.replace(/[^a-zA-Z]/g, '');
  if (letters.length === 0) return null;

  const upperCount = letters.replace(/[^A-Z]/g, '').length;
  const percent = (upperCount / letters.length) * 100;

  if (percent > maxPercent) {
    return `Excessive caps: ${Math.round(percent)}% uppercase (limit: ${maxPercent}%)`;
  }

  return null;
}

/**
 * Mention Spam — too many mentions in one message.
 */
function checkMentionSpam(
  message: Message,
  config: MentionSpamConfig,
): string | null {
  const maxMentions = config.maxMentions ?? 5;
  const totalMentions = message.mentions.users.size + message.mentions.roles.size;

  if (totalMentions > maxMentions) {
    return `Mention spam: ${totalMentions} mentions (limit: ${maxMentions})`;
  }

  return null;
}

/**
 * Newline Spam — excessive newlines (wall of text).
 */
function checkNewlineSpam(
  content: string,
  config: NewlineSpamConfig,
): string | null {
  const maxNewlines = config.maxNewlines ?? 15;
  const newlineCount = (content.match(/\n/g) || []).length;

  if (newlineCount > maxNewlines) {
    return `Newline spam: ${newlineCount} newlines (limit: ${maxNewlines})`;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

/**
 * V11 Audit L-1: SHA-256 based hash for dedup tracking.
 * Replaces the DJB-style 32-bit hash that had high collision risk.
 * 12 hex chars ≈ 48 bits of entropy — effectively collision-free
 * for duplicate-message detection across any realistic message volume.
 */
function simpleHash(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 12);
}
