/**
 * Coverage tests — Moderation subsystem
 * Tests: infraction-service, mod-log, automod-engine, escalation, commands, purge
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared mocks ────────────────────────────────────────────
vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, warning: 0xfee75c, error: 0xed4245 },
  DEFAULT_ESCALATION_CHAIN: [
    { threshold: 3, action: 'mute', durationMinutes: 60, dmMember: true },
    { threshold: 5, action: 'kick', dmMember: true },
    { threshold: 7, action: 'ban', dmMember: true },
  ],
}));

vi.mock('discord.js', () => {
  class SlashCommandBuilder {
    name = ''; desc = '';
    setName(n: string) { this.name = n; return this; }
    setDescription(d: string) { this.desc = d; return this; }
    setDefaultMemberPermissions() { return this; }
    addUserOption(fn: Function) { fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({}) }) }) }); return this; }
    addStringOption(fn: Function) { fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({}), setMinLength: () => ({}) }) }) }); return this; }
    addIntegerOption(fn: Function) { fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({ addChoices: (..._a: any[]) => ({}) }), setMinValue: () => ({ setMaxValue: () => ({}) }) }) }) }); return this; }
    addBooleanOption(fn: Function) { fn({ setName: () => ({ setDescription: () => ({}) }) }); return this; }
  }
  class EmbedBuilder {
    data: any = {};
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
    setThumbnail() { return this; }
    setTimestamp() { return this; }
    addFields(..._f: any[]) { return this; }
  }
  return { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits: { ModerateMembers: 1n, KickMembers: 2n, BanMembers: 4n, ManageMessages: 8n } };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock('../features/moderation/automod-actions.js', () => ({
  executeAutoModAction: vi.fn(async () => {}),
}));

// ── Supabase mock helper ────────────────────────────────────
function makeChain(result: any = { data: null, error: null, count: 0 }) {
  const chain: any = {};
  const methods = ['from', 'select', 'insert', 'update', 'delete',
    'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'in', 'is', 'not',
    'order', 'limit', 'single', 'maybeSingle', 'match', 'contains',
    'overlaps', 'filter', 'or', 'ilike', 'like', 'textSearch'];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  // Terminal methods return data
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  // Make it thenable
  (chain as any)[Symbol.toStringTag] = 'Promise';
  return chain;
}

function makeSupa(result?: any) {
  const chain = makeChain(result);
  return { from: vi.fn(() => chain), _chain: chain };
}

// ═════════════════════════════════════════════════════════════
// infraction-service.ts
// ═════════════════════════════════════════════════════════════
describe('infraction-service', () => {
  let svc: typeof import('../features/moderation/infraction-service.js');

  beforeEach(async () => {
    vi.resetModules();
    svc = await import('../features/moderation/infraction-service.js');
  });

  it('createInfraction inserts and returns record', async () => {
    const record = { id: 'inf1', guild_id: 'g1', member_id: 'm1', type: 'warn', active: true };
    const supa = makeSupa({ data: record, error: null });
    const res = await svc.createInfraction(supa as any, {
      guildId: 'g1', memberId: 'm1', moderatorId: 'mod1', type: 'warn', reason: 'test',
    });
    expect(res).toEqual(record);
    expect(supa.from).toHaveBeenCalledWith('infractions');
  });

  it('createInfraction returns null on error', async () => {
    const supa = makeSupa({ data: null, error: { message: 'db error' } });
    const res = await svc.createInfraction(supa as any, {
      guildId: 'g1', memberId: 'm1', moderatorId: 'mod1', type: 'warn', reason: 'test',
    });
    expect(res).toBeNull();
  });

  it('getActiveWarningCount returns count', async () => {
    const supa = makeSupa({ count: 3, error: null });
    const res = await svc.getActiveWarningCount(supa as any, 'g1', 'm1');
    expect(res).toBe(3);
  });

  it('getActiveWarningCount returns 0 on error', async () => {
    const supa = makeSupa({ count: null, error: { message: 'fail' } });
    const res = await svc.getActiveWarningCount(supa as any, 'g1', 'm1');
    expect(res).toBe(0);
  });

  it('getActiveInfractionCount returns count', async () => {
    const supa = makeSupa({ count: 5, error: null });
    const res = await svc.getActiveInfractionCount(supa as any, 'g1', 'm1');
    expect(res).toBe(5);
  });

  it('getActiveInfractionCount returns 0 on error', async () => {
    const supa = makeSupa({ count: null, error: { message: 'fail' } });
    const res = await svc.getActiveInfractionCount(supa as any, 'g1', 'm1');
    expect(res).toBe(0);
  });

  it('getMemberInfractions returns records', async () => {
    const records = [{ id: 'inf1' }, { id: 'inf2' }];
    const supa = makeSupa({ data: records, error: null });
    const res = await svc.getMemberInfractions(supa as any, 'g1', 'm1');
    expect(res).toEqual(records);
  });

  it('getMemberInfractions returns empty on error', async () => {
    const supa = makeSupa({ data: null, error: { message: 'fail' } });
    const res = await svc.getMemberInfractions(supa as any, 'g1', 'm1');
    expect(res).toEqual([]);
  });

  it('getMemberInfractions accepts custom limit', async () => {
    const supa = makeSupa({ data: [], error: null });
    await svc.getMemberInfractions(supa as any, 'g1', 'm1', 10);
    expect(supa._chain.limit).toHaveBeenCalledWith(10);
  });

  it('pardonInfraction returns true on success', async () => {
    const supa = makeSupa({ error: null });
    const res = await svc.pardonInfraction(supa as any, 'inf1', 'mod1', 'g1');
    expect(res).toBe(true);
  });

  it('pardonInfraction returns false on error', async () => {
    const supa = makeSupa({ error: { message: 'fail' } });
    const res = await svc.pardonInfraction(supa as any, 'inf1', 'mod1', 'g1');
    expect(res).toBe(false);
  });

  it('expireInfractions returns count', async () => {
    const supa = makeSupa({ data: [{ id: 'a' }, { id: 'b' }], error: null });
    const res = await svc.expireInfractions(supa as any, 'g1');
    expect(res).toBe(2);
  });

  it('expireInfractions returns 0 on error', async () => {
    const supa = makeSupa({ data: null, error: { message: 'fail' } });
    const res = await svc.expireInfractions(supa as any, 'g1');
    expect(res).toBe(0);
  });

  it('calculateExpiryDate returns future ISO string', () => {
    const result = svc.calculateExpiryDate(30);
    const d = new Date(result);
    expect(d.getTime()).toBeGreaterThan(Date.now());
    expect(d.getTime()).toBeLessThan(Date.now() + 31 * 86400000);
  });
});

// ═════════════════════════════════════════════════════════════
// mod-log.ts
// ═════════════════════════════════════════════════════════════
describe('mod-log', () => {
  let modLog: typeof import('../features/moderation/mod-log.js');

  beforeEach(async () => {
    vi.resetModules();
    modLog = await import('../features/moderation/mod-log.js');
  });

  function makeClient(channelExists = true) {
    const send = vi.fn(async () => {});
    return {
      channels: {
        cache: {
          get: vi.fn(() => channelExists ? { send } : undefined),
        },
      },
      _send: send,
    };
  }

  it('posts a warn entry', async () => {
    const client = makeClient();
    await modLog.postModLogEntry(client as any, {
      action: 'warn',
      member: { id: 'u1', user: { tag: 'User#0001', displayAvatarURL: () => 'https://cdn.example.com/avatar.png' } },
      moderator: 'Mod',
      reason: 'test reason',
      channelId: 'ch1',
    });
    expect(client._send).toHaveBeenCalled();
  });

  it('posts a mute entry with duration', async () => {
    const client = makeClient();
    await modLog.postModLogEntry(client as any, {
      action: 'mute',
      member: { id: 'u1', user: { tag: 'User#0001', displayAvatarURL: () => 'url' } },
      moderator: 'System (Auto-Mod)',
      reason: 'spam',
      duration: 120,
      activeWarnings: 3,
      nextEscalation: 'Kick at 5 warnings',
      channelId: 'ch1',
    });
    expect(client._send).toHaveBeenCalled();
  });

  it('posts kick entry', async () => {
    const client = makeClient();
    await modLog.postModLogEntry(client as any, {
      action: 'kick',
      member: { id: 'u1', user: { tag: 'User#0001', displayAvatarURL: () => 'url' } },
      moderator: 'Admin',
      reason: 'disruptive',
      channelId: 'ch1',
    });
    expect(client._send).toHaveBeenCalled();
  });

  it('posts ban entry', async () => {
    const client = makeClient();
    await modLog.postModLogEntry(client as any, {
      action: 'ban',
      member: { id: 'u1', user: { tag: 'User#0001', displayAvatarURL: () => 'url' } },
      moderator: 'System (Escalation)',
      reason: 'Escalation: 7 warnings',
      activeWarnings: 7,
      channelId: 'ch1',
    });
    expect(client._send).toHaveBeenCalled();
  });

  it('posts pardon entry', async () => {
    const client = makeClient();
    await modLog.postModLogEntry(client as any, {
      action: 'pardon',
      member: { id: 'u1', user: { tag: 'User#0001', displayAvatarURL: () => 'url' } },
      moderator: 'Mod',
      reason: 'appealed',
      channelId: 'ch1',
    });
    expect(client._send).toHaveBeenCalled();
  });

  it('posts delete entry with ruleType', async () => {
    const client = makeClient();
    await modLog.postModLogEntry(client as any, {
      action: 'delete',
      member: { id: 'u1', user: { tag: 'User#0001', displayAvatarURL: () => 'url' } },
      moderator: 'System (Auto-Mod)',
      reason: 'word filter',
      ruleType: 'word_filter',
      channelId: 'ch1',
    });
    expect(client._send).toHaveBeenCalled();
  });

  it('skips when no channelId', async () => {
    const client = makeClient();
    await modLog.postModLogEntry(client as any, {
      action: 'warn',
      member: { id: 'u1', user: { tag: 'User#0001', displayAvatarURL: () => 'url' } },
      moderator: 'Mod',
      reason: 'test',
      channelId: null,
    });
    expect(client._send).not.toHaveBeenCalled();
  });

  it('handles missing channel gracefully', async () => {
    const client = makeClient(false);
    await modLog.postModLogEntry(client as any, {
      action: 'warn',
      member: { id: 'u1', user: { tag: 'User#0001', displayAvatarURL: () => 'url' } },
      moderator: 'Mod',
      reason: 'test',
      channelId: 'ch_nonexistent',
    });
    expect(client._send).not.toHaveBeenCalled();
  });

  it('handles avatar error gracefully', async () => {
    const client = makeClient();
    await modLog.postModLogEntry(client as any, {
      action: 'warn',
      member: { id: 'u1', user: { tag: 'User#0001', displayAvatarURL: () => { throw new Error('no avatar'); } } },
      moderator: 'Mod',
      reason: 'test',
      channelId: 'ch1',
    });
    expect(client._send).toHaveBeenCalled();
  });

  it('handles send() throwing', async () => {
    const client = makeClient();
    client._send.mockRejectedValueOnce(new Error('send failed'));
    await modLog.postModLogEntry(client as any, {
      action: 'warn',
      member: { id: 'u1', user: { tag: 'User#0001', displayAvatarURL: () => 'url' } },
      moderator: 'Mod',
      reason: 'test',
      channelId: 'ch1',
    });
    // Should not throw
  });
});

// ═════════════════════════════════════════════════════════════
// automod-engine.ts
// ═════════════════════════════════════════════════════════════
describe('automod-engine', () => {
  let engine: typeof import('../features/moderation/automod-engine.js');

  beforeEach(async () => {
    vi.resetModules();
    engine = await import('../features/moderation/automod-engine.js');
  });

  function makeValkey(data: Record<string, string | number | null> = {}) {
    return {
      get: vi.fn(async (k: string) => data[k] ?? null),
      setex: vi.fn(async () => {}),
      del: vi.fn(async () => {}),
      incr: vi.fn(async () => 1),
      expire: vi.fn(async () => {}),
    };
  }

  function makeMsg(content: string, opts: any = {}) {
    return {
      content,
      guild: { id: 'g1' },
      member: {
        roles: { cache: { has: () => false } },
        permissions: { has: () => false },
      },
      author: { bot: false, id: 'u1' },
      channel: { id: 'ch1' },
      mentions: { users: { size: 0 }, roles: { size: 0 } },
      ...opts,
    };
  }

  function makeClient(rules: any[] = [], valkey?: any) {
    const supaChain = makeChain({ data: rules, error: null });
    return {
      supabase: { from: vi.fn(() => supaChain) },
      valkey: valkey ?? makeValkey(),
      eventBus: { emit: vi.fn() },
      channels: { cache: { get: vi.fn() } },
      fetchInvite: vi.fn(async () => ({ guild: { id: 'g1' } })),
    };
  }

  it('invalidateRulesCache deletes key', async () => {
    const valkey = makeValkey();
    const client = makeClient([], valkey);
    await engine.invalidateRulesCache(client as any);
    expect(valkey.del).toHaveBeenCalled();
  });

  it('processMessage returns false for bot messages', async () => {
    const client = makeClient();
    const msg = makeMsg('test', { author: { bot: true, id: 'bot1' } });
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false);
  });

  it('processMessage returns false when no guild', async () => {
    const client = makeClient();
    const msg = makeMsg('test', { guild: null });
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false);
  });

  it('processMessage returns false when no member', async () => {
    const client = makeClient();
    const msg = makeMsg('test', { member: null });
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false);
  });

  it('processMessage returns false when no rules', async () => {
    const client = makeClient([]);
    const msg = makeMsg('hello world');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false);
  });

  it('processMessage detects word filter violation (exact mode)', async () => {
    const rules = [{
      type: 'word_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { words: ['badword'], matchMode: 'exact', caseSensitive: false },
    }];
    const valkey = makeValkey();
    const client = makeClient(rules, valkey);
    const msg = makeMsg('this is a badword message');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(true);
  });

  it('processMessage detects word filter (wildcard mode)', async () => {
    const rules = [{
      type: 'word_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { words: ['bad*'], matchMode: 'wildcard', caseSensitive: false },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('this is badword');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(true);
  });

  it('processMessage detects word filter (regex mode)', async () => {
    const rules = [{
      type: 'word_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { words: ['b[ao]d'], matchMode: 'regex', caseSensitive: false },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('this is bad');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(true);
  });

  it('processMessage rejects unsafe regex', async () => {
    const rules = [{
      type: 'word_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { words: ['(a+)+'], matchMode: 'regex', caseSensitive: false },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('aaaaaa');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false); // rejected unsafe pattern
  });

  it('processMessage detects link filter (blacklist)', async () => {
    const rules = [{
      type: 'link_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { mode: 'blacklist', domains: ['evil.com'] },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('check https://evil.com/phish');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(true);
  });

  it('processMessage allows link filter (whitelist, allowed domain)', async () => {
    const rules = [{
      type: 'link_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { mode: 'whitelist', domains: ['discord.com'] },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('check https://discord.com/invite/abc');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false);
  });

  it('processMessage detects invite filter', async () => {
    const rules = [{
      type: 'invite_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { allowOwnServer: false },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('join https://discord.gg/abc123');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(true);
  });

  it('processMessage detects caps filter', async () => {
    const rules = [{
      type: 'caps_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { maxPercent: 70, minLength: 10 },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('THIS IS ALL CAPS AND VERY LOUD');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(true);
  });

  it('processMessage allows normal caps', async () => {
    const rules = [{
      type: 'caps_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { maxPercent: 70, minLength: 10 },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('This is a normal sentence with some words.');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false);
  });

  it('processMessage detects mention spam', async () => {
    const rules = [{
      type: 'mention_spam',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { maxMentions: 3 },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('@a @b @c @d', { mentions: { users: { size: 4 }, roles: { size: 0 } } });
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(true);
  });

  it('processMessage detects newline spam', async () => {
    const rules = [{
      type: 'newline_spam',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { maxNewlines: 5 },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('line\n\n\n\n\n\nline\nline\nline\nline');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(true);
  });

  it('processMessage skips exempt channel', async () => {
    const rules = [{
      type: 'word_filter',
      enabled: true,
      exempt_channels: ['ch1'],
      exempt_roles: [],
      config: { words: ['badword'], matchMode: 'exact', caseSensitive: false },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('badword');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false);
  });

  it('processMessage skips exempt role', async () => {
    const rules = [{
      type: 'word_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: ['role1'],
      config: { words: ['badword'], matchMode: 'exact', caseSensitive: false },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('badword', {
      member: {
        roles: { cache: { has: (id: string) => id === 'role1' } },
        permissions: { has: () => false },
      },
    });
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false);
  });

  it('processMessage skips moderators (ManageMessages)', async () => {
    const rules = [{
      type: 'word_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { words: ['badword'], matchMode: 'exact', caseSensitive: false },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('badword', {
      member: {
        roles: { cache: { has: () => false } },
        permissions: { has: (p: string) => p === 'ManageMessages' },
      },
    });
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false);
  });

  it('processMessage handles link filter with no URLs', async () => {
    const rules = [{
      type: 'link_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { mode: 'blacklist', domains: ['evil.com'] },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('no links here');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false);
  });

  it('processMessage link filter whitelist blocks non-listed domain', async () => {
    const rules = [{
      type: 'link_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { mode: 'whitelist', domains: ['safe.com'] },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('visit https://other.com/page');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(true);
  });

  it('processMessage spam filter tracks and triggers', async () => {
    const rules = [{
      type: 'spam_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { maxMessages: 3, intervalSeconds: 5 },
    }];
    const valkey = makeValkey();
    valkey.incr.mockResolvedValueOnce(4); // exceeds threshold
    const client = makeClient(rules, valkey);
    const msg = makeMsg('spam');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(true);
  });

  it('processMessage duplicate filter tracks and triggers', async () => {
    const rules = [{
      type: 'duplicate_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { threshold: 2, intervalSeconds: 30 },
    }];
    const valkey = makeValkey();
    valkey.incr.mockResolvedValueOnce(3); // exceeds threshold
    const client = makeClient(rules, valkey);
    const msg = makeMsg('repeated message');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(true);
  });

  it('processMessage case-sensitive word filter', async () => {
    const rules = [{
      type: 'word_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { words: ['BadWord'], matchMode: 'exact', caseSensitive: true },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('this is badword');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false); // case mismatch
  });

  it('processMessage handles unknown rule type', async () => {
    const rules = [{
      type: 'unknown_filter' as any,
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: {},
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('hello');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false);
  });

  it('caps filter skips short messages', async () => {
    const rules = [{
      type: 'caps_filter',
      enabled: true,
      exempt_channels: [],
      exempt_roles: [],
      config: { maxPercent: 70, minLength: 10 },
    }];
    const client = makeClient(rules, makeValkey());
    const msg = makeMsg('HI');
    const result = await engine.processMessage(client as any, msg as any, {
      escalationChain: [], infractionExpiryDays: 30, modLogChannelId: null,
    });
    expect(result).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// moderation/commands.ts — buildModerationCommands
// ═════════════════════════════════════════════════════════════
describe('moderation commands builders', () => {
  it('buildModerationCommands returns all 6 commands', async () => {
    const { buildModerationCommands } = await import('../features/moderation/commands.js');
    const cmds = buildModerationCommands();
    expect(cmds).toHaveProperty('warn');
    expect(cmds).toHaveProperty('mute');
    expect(cmds).toHaveProperty('kick');
    expect(cmds).toHaveProperty('ban');
    expect(cmds).toHaveProperty('pardon');
    expect(cmds).toHaveProperty('infractions');
  });
});

// ═════════════════════════════════════════════════════════════
// escalation.ts — executeEscalation
// ═════════════════════════════════════════════════════════════
describe('escalation — executeEscalation', () => {
  let esc: typeof import('../features/moderation/escalation.js');

  beforeEach(async () => {
    vi.resetModules();
    esc = await import('../features/moderation/escalation.js');
  });

  it('getEscalationAction returns null for empty chain', () => {
    expect(esc.getEscalationAction([], 5)).toBeNull();
  });

  it('getEscalationAction finds matching step', () => {
    const chain = [
      { threshold: 3, action: 'mute' as const, durationMinutes: 60, dmMember: true },
      { threshold: 5, action: 'kick' as const, dmMember: true },
      { threshold: 7, action: 'ban' as const, dmMember: false },
    ];
    expect(esc.getEscalationAction(chain, 3)?.action).toBe('mute');
    expect(esc.getEscalationAction(chain, 5)?.action).toBe('kick');
    expect(esc.getEscalationAction(chain, 10)?.action).toBe('ban');
  });

  it('getEscalationAction returns null when below all thresholds', () => {
    const chain = [
      { threshold: 3, action: 'mute' as const, durationMinutes: 60, dmMember: true },
    ];
    expect(esc.getEscalationAction(chain, 1)).toBeNull();
  });
});
