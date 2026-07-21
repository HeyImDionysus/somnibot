/**
 * AutoMod Engine — Full pipeline tests
 *
 * Tests every rule type checker (word filter, link filter, invite filter,
 * spam filter, duplicate filter, caps filter, mention spam, newline spam),
 * exemption logic, processMessage pipeline, and cache invalidation.
 * Both positive (violation triggered) and negative (no violation) paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('./automod-actions.js', () => ({
  executeAutoModAction: vi.fn(async () => {}),
}));

import { processMessage, invalidateRulesCache } from '../features/moderation/automod-engine.js';
import { MockCollection } from './helpers/discord-mocks.js';

function mockValkey() {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    setex: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    scan: vi.fn(async () => ['0', []]),
  } as any;
}

function supaChain(data: any[] = []) {
  const c: any = {};
  const methods = ['select','eq','neq','gte','lt','lte','limit','order','in','head'];
  for (const m of methods) c[m] = vi.fn((..._: any[]) => c);
  c.then = (resolve: any) => resolve({ data, error: null });
  return c;
}

function makeRule(overrides: Record<string, any> = {}): any {
  return {
    id: 'rule1',
    name: 'Test Rule',
    type: 'word_filter',
    enabled: true,
    action: 'delete',
    config: { words: ['badword'], matchMode: 'exact', caseSensitive: false },
    exempt_channels: [],
    exempt_roles: [],
    log_to_mod_channel: false,
    mute_duration_minutes: null,
    ...overrides,
  };
}

function makeMessage(content: string, overrides: Record<string, any> = {}): any {
  return {
    content,
    guild: { id: 'g1' },
    member: {
      id: 'u1',
      roles: { cache: new MockCollection() },
      permissions: { has: vi.fn(() => false) },
    },
    author: { id: 'u1', bot: false },
    channel: { id: 'ch1' },
    id: 'msg1',
    deletable: true,
    delete: vi.fn(async () => {}),
    mentions: {
      users: new MockCollection(),
      roles: new MockCollection(),
    },
    ...overrides,
  };
}

function makeClient(rules: any[] = [], valkeyOverrides: Record<string, any> = {}): any {
  const valkey = { ...mockValkey(), ...valkeyOverrides };
  return {
    supabase: { from: vi.fn(() => supaChain(rules)) },
    valkey,
    eventBus: { emit: vi.fn() },
    fetchInvite: vi.fn(async () => ({ guild: { id: 'g1' } })),
  };
}

const modConfig = {
  escalationChain: [],
  infractionExpiryDays: 30,
  modLogChannelId: null,
  automodEnabled: true,
  automodMode: 'enforce' as const,
};

describe('processMessage — bail-out conditions', () => {
  it('returns false for no guild', async () => {
    const client = makeClient();
    const msg = makeMessage('test', { guild: null });
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('returns false for no member', async () => {
    const client = makeClient();
    const msg = makeMessage('test', { member: null });
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('returns false for bot messages', async () => {
    const client = makeClient();
    const msg = makeMessage('badword', { author: { id: 'u1', bot: true } });
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('returns false when no rules exist', async () => {
    const client = makeClient([]);
    const msg = makeMessage('badword');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });
});

describe('processMessage — exemptions', () => {
  it('skips rule when channel is exempt', async () => {
    const rule = makeRule({ exempt_channels: ['ch1'] });
    const client = makeClient([rule]);
    const msg = makeMessage('badword');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('skips rule when member has exempt role', async () => {
    const rule = makeRule({ exempt_roles: ['mod-role'] });
    const client = makeClient([rule]);
    const roles = new MockCollection();
    roles.set('mod-role', { id: 'mod-role' });
    const msg = makeMessage('badword', {
      member: {
        id: 'u1',
        roles: { cache: roles },
        permissions: { has: vi.fn(() => false) },
      },
    });
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('skips rule when member has ManageMessages permission', async () => {
    const rule = makeRule();
    const client = makeClient([rule]);
    const msg = makeMessage('badword', {
      member: {
        id: 'u1',
        roles: { cache: new MockCollection() },
        permissions: { has: vi.fn((perm: string) => perm === 'ManageMessages') },
      },
    });
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('skips rule when member has Administrator permission', async () => {
    const rule = makeRule();
    const client = makeClient([rule]);
    const msg = makeMessage('badword', {
      member: {
        id: 'u1',
        roles: { cache: new MockCollection() },
        permissions: { has: vi.fn((perm: string) => perm === 'Administrator') },
      },
    });
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });
});

describe('word filter', () => {
  it('detects exact word match (case insensitive)', async () => {
    const rule = makeRule({ config: { words: ['badword'], matchMode: 'exact', caseSensitive: false } });
    const client = makeClient([rule]);
    const msg = makeMessage('This has a BADWORD in it');
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });

  it('does not trigger on partial word match in exact mode', async () => {
    const rule = makeRule({ config: { words: ['bad'], matchMode: 'exact', caseSensitive: false } });
    const client = makeClient([rule]);
    const msg = makeMessage('badge is fine');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('detects wildcard pattern match', async () => {
    const rule = makeRule({ config: { words: ['bad*'], matchMode: 'wildcard', caseSensitive: false } });
    const client = makeClient([rule]);
    const msg = makeMessage('This has badword in it');
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });

  it('detects regex pattern match', async () => {
    const rule = makeRule({ config: { words: ['b[aA]d\\w+'], matchMode: 'regex', caseSensitive: false } });
    const client = makeClient([rule]);
    const msg = makeMessage('This has badword in it');
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });

  it('skips invalid regex without crashing', async () => {
    const rule = makeRule({ config: { words: ['[invalid('], matchMode: 'regex', caseSensitive: false } });
    const client = makeClient([rule]);
    const msg = makeMessage('some text');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('rejects known catastrophic backtracking patterns', async () => {
    const rule = makeRule({ config: { words: ['(a+)+'], matchMode: 'regex', caseSensitive: false } });
    const client = makeClient([rule]);
    const msg = makeMessage('aaaaaaa');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('respects case sensitivity', async () => {
    const rule = makeRule({ config: { words: ['BadWord'], matchMode: 'exact', caseSensitive: true } });
    const client = makeClient([rule]);
    const msgLower = makeMessage('this has badword lowercase');
    expect(await processMessage(client, msgLower, modConfig)).toBe(false);

    const client2 = makeClient([rule]);
    const msgExact = makeMessage('this has BadWord exactly');
    expect(await processMessage(client2, msgExact, modConfig)).toBe(true);
  });

  it('handles empty words list', async () => {
    const rule = makeRule({ config: { words: [], matchMode: 'exact', caseSensitive: false } });
    const client = makeClient([rule]);
    const msg = makeMessage('anything');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });
});

describe('link filter', () => {
  it('blocks blacklisted domain', async () => {
    const rule = makeRule({
      type: 'link_filter',
      config: { mode: 'blacklist', domains: ['evil.com'] },
    });
    const client = makeClient([rule]);
    const msg = makeMessage('Check https://evil.com/phishing');
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });

  it('blocks subdomain of blacklisted domain', async () => {
    const rule = makeRule({
      type: 'link_filter',
      config: { mode: 'blacklist', domains: ['evil.com'] },
    });
    const client = makeClient([rule]);
    const msg = makeMessage('Check https://sub.evil.com/page');
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });

  it('allows non-blacklisted domain', async () => {
    const rule = makeRule({
      type: 'link_filter',
      config: { mode: 'blacklist', domains: ['evil.com'] },
    });
    const client = makeClient([rule]);
    const msg = makeMessage('Check https://google.com/safe');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('blocks non-whitelisted domain in whitelist mode', async () => {
    const rule = makeRule({
      type: 'link_filter',
      config: { mode: 'whitelist', domains: ['safe.com'] },
    });
    const client = makeClient([rule]);
    const msg = makeMessage('Check https://random.org/page');
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });

  it('allows whitelisted domain', async () => {
    const rule = makeRule({
      type: 'link_filter',
      config: { mode: 'whitelist', domains: ['safe.com'] },
    });
    const client = makeClient([rule]);
    const msg = makeMessage('Check https://safe.com/page');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('ignores messages with no links', async () => {
    const rule = makeRule({ type: 'link_filter', config: { mode: 'blacklist', domains: ['evil.com'] } });
    const client = makeClient([rule]);
    const msg = makeMessage('Just plain text, no links');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });
});

describe('caps filter', () => {
  it('triggers when caps exceed threshold', async () => {
    const rule = makeRule({
      type: 'caps_filter',
      config: { maxPercent: 70, minLength: 10 },
    });
    const client = makeClient([rule]);
    const msg = makeMessage('THIS IS ALL CAPS MESSAGE HERE');
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });

  it('skips short messages below minLength', async () => {
    const rule = makeRule({
      type: 'caps_filter',
      config: { maxPercent: 70, minLength: 10 },
    });
    const client = makeClient([rule]);
    const msg = makeMessage('HI');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('allows messages within caps threshold', async () => {
    const rule = makeRule({
      type: 'caps_filter',
      config: { maxPercent: 70, minLength: 10 },
    });
    const client = makeClient([rule]);
    const msg = makeMessage('This is a Normal sentence with SOME caps');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('handles messages with no letters', async () => {
    const rule = makeRule({
      type: 'caps_filter',
      config: { maxPercent: 70, minLength: 1 },
    });
    const client = makeClient([rule]);
    const msg = makeMessage('12345 !@#$% 67890');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });
});

describe('mention spam', () => {
  it('triggers when mentions exceed threshold', async () => {
    const rule = makeRule({
      type: 'mention_spam',
      config: { maxMentions: 3 },
    });
    const client = makeClient([rule]);
    const users = new MockCollection();
    users.set('u1', {}); users.set('u2', {}); users.set('u3', {}); users.set('u4', {});
    const msg = makeMessage('@a @b @c @d', { mentions: { users, roles: new MockCollection() } });
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });

  it('does not trigger when mentions are within limit', async () => {
    const rule = makeRule({
      type: 'mention_spam',
      config: { maxMentions: 5 },
    });
    const client = makeClient([rule]);
    const users = new MockCollection();
    users.set('u1', {});
    const msg = makeMessage('@a', { mentions: { users, roles: new MockCollection() } });
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('counts role mentions too', async () => {
    const rule = makeRule({
      type: 'mention_spam',
      config: { maxMentions: 2 },
    });
    const client = makeClient([rule]);
    const users = new MockCollection();
    users.set('u1', {});
    const roles = new MockCollection();
    roles.set('r1', {}); roles.set('r2', {});
    const msg = makeMessage('@user @role1 @role2', { mentions: { users, roles } });
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });
});

describe('newline spam', () => {
  it('triggers when newlines exceed threshold', async () => {
    const rule = makeRule({
      type: 'newline_spam',
      config: { maxNewlines: 3 },
    });
    const client = makeClient([rule]);
    const msg = makeMessage('line1\nline2\nline3\nline4\nline5');
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });

  it('does not trigger within threshold', async () => {
    const rule = makeRule({
      type: 'newline_spam',
      config: { maxNewlines: 15 },
    });
    const client = makeClient([rule]);
    const msg = makeMessage('line1\nline2');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });
});

describe('spam filter (Valkey-backed)', () => {
  it('triggers when message count exceeds maxMessages', async () => {
    const rule = makeRule({
      type: 'spam_filter',
      config: { maxMessages: 5, intervalSeconds: 5 },
    });
    const client = makeClient([rule], { incr: vi.fn(async () => 6) });
    const msg = makeMessage('spam');
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });

  it('does not trigger within message limit', async () => {
    const rule = makeRule({
      type: 'spam_filter',
      config: { maxMessages: 5, intervalSeconds: 5 },
    });
    const client = makeClient([rule], { incr: vi.fn(async () => 3), expire: vi.fn(async () => 1) });
    const msg = makeMessage('not spam');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('sets expiry on first message (incr returns 1)', async () => {
    const rule = makeRule({
      type: 'spam_filter',
      config: { maxMessages: 5, intervalSeconds: 10 },
    });
    const expireFn = vi.fn(async () => 1);
    const client = makeClient([rule], { incr: vi.fn(async () => 1), expire: expireFn });
    const msg = makeMessage('first msg');
    await processMessage(client, msg, modConfig);
    expect(expireFn).toHaveBeenCalledWith(expect.stringContaining('automod:spam:'), 10);
  });

  it('handles Valkey errors gracefully', async () => {
    const rule = makeRule({
      type: 'spam_filter',
      config: { maxMessages: 5, intervalSeconds: 5 },
    });
    const client = makeClient([rule], { incr: vi.fn(async () => { throw new Error('Valkey down'); }) });
    const msg = makeMessage('test');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });
});

describe('duplicate filter', () => {
  it('triggers when same message repeated beyond threshold', async () => {
    const rule = makeRule({
      type: 'duplicate_filter',
      config: { threshold: 3, intervalSeconds: 30 },
    });
    const client = makeClient([rule], { incr: vi.fn(async () => 3), expire: vi.fn(async () => 1) });
    const msg = makeMessage('same message');
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });

  it('does not trigger below threshold', async () => {
    const rule = makeRule({
      type: 'duplicate_filter',
      config: { threshold: 3, intervalSeconds: 30 },
    });
    const client = makeClient([rule], { incr: vi.fn(async () => 2), expire: vi.fn(async () => 1) });
    const msg = makeMessage('same message');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });
});

describe('invite filter', () => {
  it('blocks discord invite links', async () => {
    const rule = makeRule({
      type: 'invite_filter',
      config: { allowOwnServer: false },
    });
    const client = makeClient([rule]);
    const msg = makeMessage('Join https://discord.gg/abc123');
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });

  it('ignores messages without invite links', async () => {
    const rule = makeRule({
      type: 'invite_filter',
      config: { allowOwnServer: false },
    });
    const client = makeClient([rule]);
    const msg = makeMessage('No invites here');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('allows own server invite when allowOwnServer=true', async () => {
    const rule = makeRule({
      type: 'invite_filter',
      config: { allowOwnServer: true },
    });
    const client = makeClient([rule]);
    client.fetchInvite = vi.fn(async () => ({ guild: { id: 'g1' } }));
    const msg = makeMessage('Join https://discord.gg/ownserver');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });

  it('blocks external server invite when allowOwnServer=true', async () => {
    const rule = makeRule({
      type: 'invite_filter',
      config: { allowOwnServer: true },
    });
    const client = makeClient([rule]);
    client.fetchInvite = vi.fn(async () => ({ guild: { id: 'other-guild' } }));
    const msg = makeMessage('Join https://discord.gg/external');
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });

  it('blocks invite when API fails to resolve', async () => {
    const rule = makeRule({
      type: 'invite_filter',
      config: { allowOwnServer: true },
    });
    const client = makeClient([rule]);
    client.fetchInvite = vi.fn(async () => { throw new Error('Invalid invite'); });
    const msg = makeMessage('Join https://discord.gg/expired');
    expect(await processMessage(client, msg, modConfig)).toBe(true);
  });
});

describe('rules cache', () => {
  it('uses cached rules on second call', async () => {
    const rule = makeRule();
    const client = makeClient([rule], {
      get: vi.fn(async () => JSON.stringify([rule])),
    });
    const msg = makeMessage('badword');
    await processMessage(client, msg, modConfig);
    // Should not have queried supabase for rules (used cache)
    const fromCalls = client.supabase.from.mock.calls;
    const rulesQueries = fromCalls.filter((c: any[]) => c[0] === 'automod_rules');
    expect(rulesQueries).toHaveLength(0);
  });

  it('handles unknown rule type gracefully', async () => {
    const rule = makeRule({ type: 'nonexistent_filter' as any, config: {} });
    const client = makeClient([rule]);
    const msg = makeMessage('anything');
    expect(await processMessage(client, msg, modConfig)).toBe(false);
  });
});

describe('invalidateRulesCache', () => {
  it('deletes specific guild cache key', async () => {
    const client = makeClient();
    await invalidateRulesCache(client, 'g1');
    expect(client.valkey.del).toHaveBeenCalledWith('automod:rules:g1');
  });

  it('scans and deletes all guild caches when no guildId provided', async () => {
    const client = makeClient();
    client.valkey.scan = vi.fn(async () => ['0', ['automod:rules:g1', 'automod:rules:g2']]);
    await invalidateRulesCache(client);
    expect(client.valkey.scan).toHaveBeenCalled();
    expect(client.valkey.del).toHaveBeenCalledWith('automod:rules:g1', 'automod:rules:g2');
  });

  it('handles Valkey errors gracefully', async () => {
    const client = makeClient();
    client.valkey.del = vi.fn(async () => { throw new Error('Valkey down'); });
    await expect(invalidateRulesCache(client, 'g1')).resolves.not.toThrow();
  });
});
