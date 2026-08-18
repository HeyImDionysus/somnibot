import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => ({ write: vi.fn().mockResolvedValue(undefined) }));
const automation = vi.hoisted(() => ({
  rules: Array.from<unknown>([]),
  allowFire: vi.fn(),
  claim: vi.fn(),
}));

vi.mock('../services/audit.js', () => ({ writeAuditLog: audit.write }));
vi.mock('../features/automations/automation-loader.js', () => ({
  AutomationLoader: class {
    load = vi.fn().mockResolvedValue(undefined);
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    getForTrigger = vi.fn(() => automation.rules);
    getAll = vi.fn(() => automation.rules);
  },
}));
vi.mock('../features/automations/rate-limiter.js', () => ({
  AutomationRateLimiter: class {
    allowFire = automation.allowFire;
    allowCustom = vi.fn().mockResolvedValue(true);
  },
}));
vi.mock('../features/automations/execution-logger.js', () => ({
  ExecutionLogger: class {
    isOccurrenceConsumed = vi.fn().mockResolvedValue(false);
    claim = automation.claim;
  },
}));
vi.mock('../features/automations/action-resume-runner.js', () => ({
  AutomationActionResumeRunner: class {},
}));
vi.mock('../features/automations/mass-action-hold.js', () => ({
  MassActionHoldService: class {},
}));
vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
    addFields() { return this; }
  },
  Collection: class extends Map {},
}));

import { AutomationEngine } from '../features/automations/automation-engine.js';
import { invalidateLevelCaches, processMessageXp } from '../features/levels/xp-tracker.js';

const RULE = {
  id: 'rule-1',
  name: 'Welcome rule',
  description: null,
  enabled: true,
  triggerType: 'message.sent',
  triggerConfig: {},
  conditions: [],
  actions: [{ type: 'send_message', config: { content: 'hello' } }],
  scopeTargetUserIds: [],
  scopeTargetChannelIds: [],
  scopeExcludeUserIds: [],
  scopeExcludeChannelIds: [],
  rateLimitPerUser: null,
  rateLimitWindowSeconds: null,
  previewHash: null,
};

function messageEvent(messageId: string) {
  return {
    type: 'message.sent',
    guildId: 'guild-1',
    timestamp: 1,
    data: {
      discordId: '12345678901234567',
      username: 'member',
      channelId: 'channel-1',
      messageId,
      content: 'hello',
    },
  } as const;
}

function discordMessage(messageId: string) {
  return {
    id: messageId,
    channel: { id: 'channel-1' },
    author: { id: '12345678901234567', bot: false },
    member: {
      id: '12345678901234567',
      displayName: 'member',
      roles: { cache: new Map() },
    },
  };
}

function xpMessage(messageId: string) {
  return {
    id: messageId,
    channel: { id: 'channel-1' },
    author: { id: '12345678901234567', bot: false },
    member: null,
  };
}

function levelSupabase(rpcResults: Array<{ data: Record<string, number> | null; error: { message: string } | null }>) {
  const config = {
    levels_enabled: true,
    xp_min: 25,
    xp_max: 25,
    xp_cooldown_seconds: 0,
    xp_channel_mode: 'blacklist',
    xp_channel_list: [],
    no_xp_role_id: null,
  };
  return {
    from: vi.fn((table: string) => {
      const result = table === 'guild_config'
        ? { data: config, error: null }
        : { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'order', 'limit']) {
        chain[method] = vi.fn(() => chain);
      }
      chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
      chain['then'] = (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve);
      return chain;
    }),
    rpc: vi.fn(async () => rpcResults.shift() ?? { data: null, error: { message: 'missing fixture' } }),
  };
}

describe('core retry audit branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateLevelCaches();
    automation.rules.splice(0, automation.rules.length, RULE);
    automation.allowFire.mockRejectedValue(new Error('Valkey unavailable'));
    automation.claim.mockResolvedValue({ claimed: true, rowId: 'execution-1' });
  });

  it('records one stable automation.rate_limiter_down occurrence while suppressing actions', async () => {
    const member = discordMessage('message-1').member;
    const guild = {
      id: 'guild-1',
      channels: { cache: new Map() },
      members: { cache: new Map([[member.id, member]]) },
    };
    const eventBus = { emit: vi.fn() };
    const engine = new AutomationEngine(guild as never, {} as never, {} as never, eventBus as never);

    await engine.processMessageEvent(messageEvent('message-1'), discordMessage('message-1') as never);
    await engine.processMessageEvent(messageEvent('message-1'), discordMessage('message-1') as never);
    await engine.processMessageEvent(messageEvent('message-2'), discordMessage('message-2') as never);

    await vi.waitFor(() => expect(audit.write).toHaveBeenCalledTimes(3));
    expect(automation.claim).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      guildId: 'guild-1',
      actorType: 'automation',
      actorId: 'rule-1',
      action: 'automation.rate_limiter_down',
      category: 'automations',
      targetType: 'member',
      targetId: '12345678901234567',
      success: false,
      errorMessage: 'Valkey unavailable',
    }));
    const first = audit.write.mock.calls[0]?.[1];
    const repeated = audit.write.mock.calls[1]?.[1];
    const later = audit.write.mock.calls[2]?.[1];
    expect(first?.occurrenceKey).toBe(repeated?.occurrenceKey);
    expect(later?.occurrenceKey).not.toBe(first?.occurrenceKey);
  });

  it('records levels.xp_write_retried by the XP message occurrence without changing the failed write result', async () => {
    const supabase = levelSupabase([
      { data: null, error: { message: 'transient write fault' } },
      { data: null, error: { message: 'transient write fault' } },
      { data: null, error: { message: 'transient write fault' } },
    ]);
    const valkey = { set: vi.fn() };

    const first = await processMessageXp(xpMessage('xp-message-1') as never, supabase as never, valkey as never, 'guild-xp');
    const repeated = await processMessageXp(xpMessage('xp-message-1') as never, supabase as never, valkey as never, 'guild-xp');
    await processMessageXp(xpMessage('xp-message-2') as never, supabase as never, valkey as never, 'guild-xp');

    expect(first).toEqual({ granted: false, newXp: 0, oldLevel: 0, newLevel: 0, leveledUp: false });
    const xpAudits = audit.write.mock.calls.map((call) => call[1]);
    expect(xpAudits).toHaveLength(3);
    expect(xpAudits[0]).toEqual(expect.objectContaining({
      guildId: 'guild-xp',
      actorType: 'system',
      actorId: 'levels-xp-tracker',
      action: 'levels.xp_write_retried',
      category: 'levels',
      targetType: 'member',
      targetId: '12345678901234567',
      success: false,
      errorMessage: 'transient write fault',
    }));
    expect(xpAudits[0]?.occurrenceKey).toBe(xpAudits[1]?.occurrenceKey);
    expect(xpAudits[2]?.occurrenceKey).not.toBe(xpAudits[0]?.occurrenceKey);
  });
});
