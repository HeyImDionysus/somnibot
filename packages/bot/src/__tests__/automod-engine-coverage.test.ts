/**
 * AutoMod Engine — Full coverage tests
 *
 * Imports the REAL processMessage & invalidateRulesCache functions
 * and mocks only external boundaries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => mockLog,
}));

vi.mock('./automod-actions.js', () => ({
  executeAutoModAction: vi.fn().mockResolvedValue(undefined),
}));

import { processMessage, invalidateRulesCache } from '../features/moderation/automod-engine.js';

// ── Helpers ───────────────────────────────────────────────

function makeClient(rules: unknown[] = [], overrides: Record<string, unknown> = {}) {
  const valkey = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    scan: vi.fn().mockResolvedValue(['0', []]),
  };

  const chain: Record<string, unknown> = {};
  ['select', 'eq', 'limit'].forEach((m) => { chain[m] = vi.fn().mockReturnValue(chain); });
  chain.then = (fn: (v: unknown) => void) => Promise.resolve({ data: rules, error: null }).then(fn);

  const supabase = {
    from: vi.fn().mockReturnValue(chain),
  };

  return {
    valkey,
    supabase,
    // Auto-mod audits on the batched event rail, so every enforcement branch
    // (including delete, which used to write directly) needs the bus.
    eventBus: { emit: vi.fn() },
    fetchInvite: vi.fn().mockResolvedValue({ guild: { id: 'g1' } }),
    ...overrides,
  };
}

function makeMessage(content: string, overrides: Record<string, unknown> = {}) {
  return {
    content,
    guild: { id: 'g1' },
    member: {
      roles: { cache: new Map() },
      permissions: {
        has: vi.fn().mockReturnValue(false),
      },
    },
    author: { bot: false, id: 'u1' },
    channel: { id: 'ch1' },
    mentions: {
      users: { size: 0 },
      roles: { size: 0 },
    },
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeRule(type: string, config: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule1',
    guild_id: 'g1',
    type,
    enabled: true,
    config,
    action: 'delete',
    exempt_channels: [] as string[],
    exempt_roles: [] as string[],
    priority: 0,
    ...overrides,
  };
}

describe('automod-engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── processMessage ──────────────────────────────────────

  describe('processMessage', () => {
    const modConfig = {
      escalationChain: [],
      infractionExpiryDays: 30,
      modLogChannelId: null,
      automodEnabled: true,
      automodMode: 'enforce' as const,
    };

    it('returns false when no guild', async () => {
      const msg = makeMessage('hello', { guild: null });
      const result = await processMessage(makeClient() as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    it('returns false when no member', async () => {
      const msg = makeMessage('hello', { member: null });
      const result = await processMessage(makeClient() as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    it('returns false for bot messages', async () => {
      const msg = makeMessage('hello', { author: { bot: true, id: 'bot1' } });
      const result = await processMessage(makeClient() as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    it('returns false when no rules', async () => {
      const client = makeClient([]);
      const msg = makeMessage('hello');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    it('skips exempt channels', async () => {
      const rule = makeRule('word_filter', { words: ['bad'], matchMode: 'exact', caseSensitive: false }, { exempt_channels: ['ch1'] });
      const client = makeClient([rule]);
      const msg = makeMessage('bad word');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    it('skips members with ManageMessages permission', async () => {
      const rule = makeRule('word_filter', { words: ['bad'], matchMode: 'exact', caseSensitive: false });
      const client = makeClient([rule]);
      const msg = makeMessage('bad word', {
        member: {
          roles: { cache: new Map() },
          permissions: { has: vi.fn().mockReturnValue(true) },
        },
      });
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    it('skips members with exempt roles', async () => {
      const roleCache = new Map([['mod-role', true]]);
      const rule = makeRule('word_filter', { words: ['bad'], matchMode: 'exact', caseSensitive: false }, { exempt_roles: ['mod-role'] });
      const client = makeClient([rule]);
      const msg = makeMessage('bad word', {
        member: {
          roles: { cache: roleCache },
          permissions: { has: vi.fn().mockReturnValue(false) },
        },
      });
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    // ── Word filter ───────────────────────────────────────

    it('detects exact word match', async () => {
      const rule = makeRule('word_filter', { words: ['badword'], matchMode: 'exact', caseSensitive: false });
      const client = makeClient([rule]);
      const msg = makeMessage('this is a badword here');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
    });

    it('detects wildcard word match', async () => {
      const rule = makeRule('word_filter', { words: ['bad*'], matchMode: 'wildcard', caseSensitive: false });
      const client = makeClient([rule]);
      const msg = makeMessage('that is badstuff');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
    });

    it('detects regex word match', async () => {
      const rule = makeRule('word_filter', { words: ['b[ae]d'], matchMode: 'regex', caseSensitive: false });
      const client = makeClient([rule]);
      const msg = makeMessage('this is bad');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
    });

    it('rejects unsafe regex patterns', async () => {
      const rule = makeRule('word_filter', { words: ['(a+)+'], matchMode: 'regex', caseSensitive: false });
      const client = makeClient([rule]);
      const msg = makeMessage('aaaaaa');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    it('handles case-sensitive mode', async () => {
      const rule = makeRule('word_filter', { words: ['BadWord'], matchMode: 'exact', caseSensitive: true });
      const client = makeClient([rule]);
      const msg = makeMessage('this is a BadWord here');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
    });

    it('handles empty word list', async () => {
      const rule = makeRule('word_filter', { words: [], matchMode: 'exact', caseSensitive: false });
      const client = makeClient([rule]);
      const msg = makeMessage('anything');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    // ── Link filter ───────────────────────────────────────

    it('detects blocked domain links', async () => {
      const rule = makeRule('link_filter', { mode: 'blacklist', domains: ['evil.com'] });
      const client = makeClient([rule]);
      const msg = makeMessage('check this https://evil.com/page');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
    });

    it('allows whitelisted domain links', async () => {
      const rule = makeRule('link_filter', { mode: 'whitelist', domains: ['youtube.com', 'discord.com'] });
      const client = makeClient([rule]);
      const msg = makeMessage('check https://youtube.com/watch');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    it('blocks non-whitelisted domains', async () => {
      const rule = makeRule('link_filter', { mode: 'whitelist', domains: ['youtube.com'] });
      const client = makeClient([rule]);
      const msg = makeMessage('check https://evil.com/page');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
    });

    it('ignores messages without links', async () => {
      const rule = makeRule('link_filter', { mode: 'blacklist', domains: ['evil.com'] });
      const client = makeClient([rule]);
      const msg = makeMessage('no links here');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    // ── Invite filter ─────────────────────────────────────

    it('detects Discord invite links', async () => {
      const rule = makeRule('invite_filter', { allowOwnServer: false });
      const client = makeClient([rule]);
      const msg = makeMessage('join discord.gg/abc123');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
    });

    it('allows own server invites when configured', async () => {
      const rule = makeRule('invite_filter', { allowOwnServer: true });
      const client = makeClient([rule]);
      client.fetchInvite.mockResolvedValue({ guild: { id: 'g1' } });
      const msg = makeMessage('join https://discord.gg/abc123');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    it('blocks external server invites when allowOwnServer is true', async () => {
      const rule = makeRule('invite_filter', { allowOwnServer: true });
      const client = makeClient([rule]);
      client.fetchInvite.mockResolvedValue({ guild: { id: 'otherGuild' } });
      const msg = makeMessage('join https://discord.gg/ext123');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
    });

    // ── Spam filter ───────────────────────────────────────

    it('does not trigger on first message', async () => {
      const rule = makeRule('spam_filter', { maxMessages: 5, intervalSeconds: 5 });
      const client = makeClient([rule]);
      const msg = makeMessage('hello');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    it('triggers when exceeding message limit', async () => {
      const rule = makeRule('spam_filter', { maxMessages: 3, intervalSeconds: 5 });
      const client = makeClient([rule]);
      client.valkey.incr.mockResolvedValue(4); // 4th message
      const msg = makeMessage('spam');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
    });

    // ── Duplicate filter ──────────────────────────────────

    it('does not trigger on first occurrence', async () => {
      const rule = makeRule('duplicate_filter', { threshold: 3, intervalSeconds: 30 });
      const client = makeClient([rule]);
      const msg = makeMessage('repeated message');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    it('triggers on too many duplicates', async () => {
      const rule = makeRule('duplicate_filter', { threshold: 3, intervalSeconds: 30 });
      const client = makeClient([rule]);
      client.valkey.incr.mockResolvedValue(3);
      const msg = makeMessage('repeated message');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
    });

    // ── Caps filter ───────────────────────────────────────

    it('detects excessive caps', async () => {
      const rule = makeRule('caps_filter', { maxPercent: 70, minLength: 5 });
      const client = makeClient([rule]);
      const msg = makeMessage('THIS IS ALL CAPS MESSAGE');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
    });

    it('allows short messages with caps', async () => {
      const rule = makeRule('caps_filter', { maxPercent: 70, minLength: 20 });
      const client = makeClient([rule]);
      const msg = makeMessage('OK');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    it('allows normal casing', async () => {
      const rule = makeRule('caps_filter', { maxPercent: 70, minLength: 5 });
      const client = makeClient([rule]);
      const msg = makeMessage('This is a normal message with proper casing');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    it('handles non-letter content', async () => {
      const rule = makeRule('caps_filter', { maxPercent: 70, minLength: 5 });
      const client = makeClient([rule]);
      const msg = makeMessage('123456789012345');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    // ── Mention spam ──────────────────────────────────────

    it('detects mention spam', async () => {
      const rule = makeRule('mention_spam', { maxMentions: 3 });
      const client = makeClient([rule]);
      const msg = makeMessage('@a @b @c @d @e', {
        mentions: { users: { size: 5 }, roles: { size: 0 } },
      });
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
    });

    it('allows normal mention count', async () => {
      const rule = makeRule('mention_spam', { maxMentions: 5 });
      const client = makeClient([rule]);
      const msg = makeMessage('@a @b', {
        mentions: { users: { size: 2 }, roles: { size: 0 } },
      });
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    // ── Newline spam ──────────────────────────────────────

    it('detects newline spam', async () => {
      const rule = makeRule('newline_spam', { maxNewlines: 5 });
      const client = makeClient([rule]);
      const msg = makeMessage('a\n\n\n\n\n\n\n\n\n\n\nb');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
    });

    it('allows normal newlines', async () => {
      const rule = makeRule('newline_spam', { maxNewlines: 10 });
      const client = makeClient([rule]);
      const msg = makeMessage('line 1\nline 2\nline 3');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    // ── Unknown rule type ─────────────────────────────────

    it('skips unknown rule types', async () => {
      const rule = makeRule('future_type', {});
      const client = makeClient([rule]);
      const msg = makeMessage('anything');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(false);
    });

    // ── Cached rules ──────────────────────────────────────

    it('uses cached rules from Valkey', async () => {
      const rules = [makeRule('word_filter', { words: ['cached'], matchMode: 'exact', caseSensitive: false })];
      const client = makeClient([]);
      client.valkey.get.mockResolvedValue(JSON.stringify(rules));
      const msg = makeMessage('this is cached content');
      const result = await processMessage(client as any, msg as any, modConfig);
      expect(result).toBe(true);
      // Should NOT have called supabase.from('automod_rules') since cache hit
      // (It may call supabase.from('audit_logs') via executeAutoModAction)
      const automodRuleCalls = client.supabase.from.mock.calls.filter(
        (c: string[]) => c[0] === 'automod_rules'
      );
      expect(automodRuleCalls).toHaveLength(0);
    });
  });

  // ── invalidateRulesCache ────────────────────────────────

  describe('invalidateRulesCache', () => {
    it('deletes specific guild cache', async () => {
      const client = makeClient();
      await invalidateRulesCache(client as any, 'g1');
      expect(client.valkey.del).toHaveBeenCalledWith('automod:rules:g1');
    });

    it('scans and deletes all guild caches when no guildId', async () => {
      const client = makeClient();
      client.valkey.scan.mockResolvedValueOnce(['0', ['automod:rules:g1', 'automod:rules:g2']]);
      await invalidateRulesCache(client as any);
      expect(client.valkey.scan).toHaveBeenCalled();
      expect(client.valkey.del).toHaveBeenCalledWith('automod:rules:g1', 'automod:rules:g2');
    });

    it('handles empty scan result', async () => {
      const client = makeClient();
      await invalidateRulesCache(client as any);
      // Should complete without error
    });
  });

  // ── word-filter per-message budget (PR #269 review) ─────

  describe('word-filter budget enforcement between words', () => {
    const modConfig = {
      escalationChain: [],
      infractionExpiryDays: 30,
      modLogChannelId: null,
      automodEnabled: true,
      automodMode: 'enforce' as const,
    };

    it('bails out of the word loop when the per-message budget is exceeded — no match, no punishment', async () => {
      // Injected clock (Date.now call order): deadline computed at t=0
      // (→ 500), between-rules check at t=1, word 1 checked at t=2 (within
      // budget — evaluates a fast non-matching regex), word 2 checked at
      // t=600 → over deadline → bail. Words 2 and 3 WOULD match the content,
      // proving the bail (not a failed match) stopped the loop.
      const times = [0, 1, 2, 600];
      let call = 0;
      const nowSpy = vi
        .spyOn(Date, 'now')
        .mockImplementation(() => times[Math.min(call++, times.length - 1)]!);
      try {
        const rule = makeRule('word_filter', {
          words: ['zzz\\d+', 'bad', 'content'],
          matchMode: 'regex',
          caseSensitive: false,
        });
        const msg = makeMessage('this is bad content');
        const result = await processMessage(makeClient([rule]) as any, msg as any, modConfig);

        // Fails toward "no match": the user is not punished on a budget bail.
        expect(result).toBe(false);
        expect(msg.delete).not.toHaveBeenCalled();

        // Logged exactly once, reporting how many words were skipped.
        const bailWarns = mockLog.warn.mock.calls.filter((c) =>
          String(c[0]).includes('word-filter budget exceeded'),
        );
        expect(bailWarns).toHaveLength(1);
        expect(String(bailWarns[0]![0])).toContain('skipped 2 remaining word(s)');
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('evaluates all words normally when the budget is not exceeded', async () => {
      const rule = makeRule('word_filter', {
        words: ['zzz\\d+', 'bad'],
        matchMode: 'regex',
        caseSensitive: false,
      });
      const msg = makeMessage('this is bad content');
      const result = await processMessage(makeClient([rule]) as any, msg as any, modConfig);
      expect(result).toBe(true);
    });
  });
});
