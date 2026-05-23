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
import { executeAutoModAction } from './automod-actions.js';

const log = createLogger('AutoModEngine');

const RULES_CACHE_KEY = 'automod:rules';
const RULES_CACHE_TTL = 60; // seconds

// ── Spam tracking (Valkey-backed) ──

const SPAM_KEY_PREFIX = 'automod:spam:';
const DUP_KEY_PREFIX = 'automod:dup:';

/**
 * Load auto-mod rules from cache or database.
 */
async function loadRules(client: SomniClient, guildId: string): Promise<DbAutomodRule[]> {
  try {
    const cached = await client.valkey.get(RULES_CACHE_KEY);
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
    .eq('enabled', true);

  if (error) {
    log.error('Failed to load rules:', error.message);
    return [];
  }

  // Sort by priority descending — higher priority rules execute first
  const rules = ((data ?? []) as DbAutomodRule[]).sort(
    (a, b) => ((b as unknown as Record<string, number>).priority ?? 0) - ((a as unknown as Record<string, number>).priority ?? 0),
  );

  try {
    await client.valkey.setex(
      RULES_CACHE_KEY,
      RULES_CACHE_TTL,
      JSON.stringify(rules),
    );
  } catch {
    // Cache write failure — non-fatal
  }

  return rules;
}

/**
 * Invalidate the auto-mod rules cache.
 * Called when rules are updated via dashboard.
 */
export async function invalidateRulesCache(client: SomniClient): Promise<void> {
  try {
    await client.valkey.del(RULES_CACHE_KEY);
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
export async function processMessage(
  client: SomniClient,
  message: Message,
  modConfig: {
    escalationChain: EscalationStep[];
    infractionExpiryDays: number;
    modLogChannelId: string | null;
  },
): Promise<boolean> {
  // Quick bail-outs
  if (!message.guild || !message.member) return false;
  if (message.author.bot) return false;
  const rules = await loadRules(client, message.guild.id);
  if (rules.length === 0) return false;

  const member = message.member;
  const channelId = message.channel.id;

  for (const rule of rules) {
    if (isExempt(member, rule, channelId)) continue;

    const violation = await checkRule(client, message, rule);
    if (violation) {
      await executeAutoModAction(client, message, rule, violation, modConfig);
      return true;
    }
  }

  return false;
}

/**
 * Check a single rule against a message.
 * Returns the violation description, or null if no violation.
 */
async function checkRule(
  client: SomniClient,
  message: Message,
  rule: DbAutomodRule,
): Promise<string | null> {
  switch (rule.type) {
    case 'word_filter':
      return checkWordFilter(message.content, rule.config as unknown as WordFilterConfig);
    case 'link_filter':
      return checkLinkFilter(message.content, rule.config as unknown as LinkFilterConfig);
    case 'invite_filter':
      return await checkInviteFilter(client, message.content, rule.config as unknown as InviteFilterConfig, message.guild?.id);
    case 'spam_filter':
      return await checkSpamFilter(client, message, rule.config as unknown as SpamFilterConfig);
    case 'duplicate_filter':
      return await checkDuplicateFilter(client, message, rule.config as unknown as DuplicateFilterConfig);
    case 'caps_filter':
      return checkCapsFilter(message.content, rule.config as unknown as CapsFilterConfig);
    case 'mention_spam':
      return checkMentionSpam(message, rule.config as unknown as MentionSpamConfig);
    case 'newline_spam':
      return checkNewlineSpam(message.content, rule.config as unknown as NewlineSpamConfig);
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
): string | null {
  if (!config.words || config.words.length === 0) return null;

  const text = config.caseSensitive ? content : content.toLowerCase();

  for (const word of config.words) {
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

          // Run the match with a timeout guard: if regex.test takes >50ms,
          // treat it as a timeout and skip this pattern.
          const start = Date.now();
          const matched = regex.test(content);
          if (Date.now() - start > 50) {
            log.warn(`Regex pattern "${word}" took >50ms — skipping for safety`);
            break;
          }

          if (matched) {
            return `Matched regex filter: "${word}"`;
          }
        } catch {
          // Invalid regex — skip
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

async function checkInviteFilter(
  client: SomniClient,
  content: string,
  config: InviteFilterConfig,
  guildId?: string,
): Promise<string | null> {
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
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.guildId === guildId) continue; // own server — allow
      return 'Discord invite link detected (external server)';
    }

    // Resolve the invite via Discord API
    try {
      const invite = await client.fetchInvite(code);
      const inviteGuildId = invite.guild?.id ?? null;

      // Cache the result
      _inviteGuildCache.set(code, {
        guildId: inviteGuildId,
        expiresAt: Date.now() + INVITE_CACHE_TTL,
      });

      if (inviteGuildId === guildId) continue; // own server — allow
      return 'Discord invite link detected (external server)';
    } catch {
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
 * Simple hash for dedup tracking.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}
