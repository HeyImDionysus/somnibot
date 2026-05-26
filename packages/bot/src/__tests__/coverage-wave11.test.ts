/**
 * Wave 11 coverage: condition-evaluator and action-executor deep branch coverage
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  AUTOMATION_LIMITS: {
    MAX_AUTOMATIONS_PER_GUILD: 100,
    MAX_ACTIONS_PER_AUTOMATION: 10,
    MAX_CONDITIONS_PER_AUTOMATION: 5,
    MAX_DELAY_SECONDS: 3600,
    MAX_FIRES_PER_USER_PER_MINUTE: 5,
    DM_COOLDOWN_SECONDS: 300,
    ROLE_GRANT_DELAY_MS: 0, // Use 0 in tests to avoid waiting
    MAX_CHAIN_DEPTH: 3,
  },
}));
vi.mock('../../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean) { const c = new Collection<K,V>(); for (const [k,v] of this) if (fn(v)) c.set(k,v); return c; }
    find(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return v; }
    has(key: K) { return super.has(key); }
    get(key: K) { return super.get(key); }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
  }
  return {
    Collection,
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionFlagsBits: { ViewChannel: 1n },
  };
});

const { Collection } = await import('discord.js');

function chain(data: any = null, error: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head','overlaps','single','maybeSingle','rpc'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = undefined;
  return c;
}

function member(id = 'u1', roles: string[] = ['r1']) {
  const rolesCache = new Collection<string, any>();
  for (const r of roles) rolesCache.set(r, { id: r, name: `Role-${r}` });
  return {
    id, user: { id, username: 'User', bot: false },
    roles: {
      cache: rolesCache,
      add: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    send: vi.fn(async () => ({})),
    ban: vi.fn(async () => {}),
    kick: vi.fn(async () => {}),
    timeout: vi.fn(async () => {}),
    bannable: true,
    kickable: true,
    moderatable: true,
  } as any;
}

function guild(id = 'g1') {
  const channels = new Collection<string, any>();
  channels.set('ch1', {
    id: 'ch1', name: 'general', type: 0,
    send: vi.fn(async () => ({ id: 'msg1' })),
  });
  const roles = new Collection<string, any>();
  roles.set('r1', { id: 'r1', name: 'TestRole' });
  return {
    id, name: 'Test Guild',
    channels: { cache: channels, create: vi.fn(async (opts: any) => ({
      id: 'newch', ...opts,
      send: vi.fn(async () => ({})),
      delete: vi.fn(async () => {}),
      permissionOverwrites: { create: vi.fn(async () => {}) },
    })) },
    roles: { cache: roles },
  } as any;
}

// ═══════════════════════════════════════════════
// Condition Evaluator — all branches
// ═══════════════════════════════════════════════
describe('ConditionEvaluator', () => {
  it('empty conditions = true', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const result = await evaluateConditions([], {} as any);
    expect(result).toBe(true);
  });

  it('has_role pass', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const m = member('u1', ['r1', 'r2']);
    const result = await evaluateConditions(
      [{ type: 'has_role', config: { value: 'r1' } }],
      { member: m, guild: guild(), channelId: 'ch1', messageContent: null, supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(true);
  });

  it('has_role fail', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const m = member('u1', ['r1']);
    const result = await evaluateConditions(
      [{ type: 'has_role', config: { value: 'r999' } }],
      { member: m, guild: guild(), channelId: 'ch1', messageContent: null, supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(false);
  });

  it('has_role no member', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const result = await evaluateConditions(
      [{ type: 'has_role', config: { value: 'r1' } }],
      { member: null, guild: guild(), channelId: 'ch1', messageContent: null, supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(false);
  });

  it('missing_role pass', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const m = member('u1', ['r1']);
    const result = await evaluateConditions(
      [{ type: 'missing_role', config: { value: 'r999' } }],
      { member: m, guild: guild(), channelId: null, messageContent: null, supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(true);
  });

  it('min_level pass', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const supa = { from: vi.fn(() => chain({ level: 10 })) } as any;
    const result = await evaluateConditions(
      [{ type: 'min_level', config: { value: 5 } }],
      { member: member(), guild: guild(), channelId: null, messageContent: null, supabase: supa, guildId: 'g1' },
    );
    expect(result).toBe(true);
  });

  it('max_level pass', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const supa = { from: vi.fn(() => chain({ level: 3 })) } as any;
    const result = await evaluateConditions(
      [{ type: 'max_level', config: { value: 5 } }],
      { member: member(), guild: guild(), channelId: null, messageContent: null, supabase: supa, guildId: 'g1' },
    );
    expect(result).toBe(true);
  });

  it('in_channel pass', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const result = await evaluateConditions(
      [{ type: 'in_channel', config: { value: 'ch1' } }],
      { member: null, guild: guild(), channelId: 'ch1', messageContent: null, supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(true);
  });

  it('not_in_channel pass', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const result = await evaluateConditions(
      [{ type: 'not_in_channel', config: { value: 'ch999' } }],
      { member: null, guild: guild(), channelId: 'ch1', messageContent: null, supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(true);
  });

  it('message_contains pass', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const result = await evaluateConditions(
      [{ type: 'message_contains', config: { value: 'hello' } }],
      { member: null, guild: guild(), channelId: 'ch1', messageContent: 'Say Hello World!', supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(true);
  });

  it('message_contains fail on null', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const result = await evaluateConditions(
      [{ type: 'message_contains', config: { value: 'hello' } }],
      { member: null, guild: guild(), channelId: 'ch1', messageContent: null, supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(false);
  });

  it('message_matches_regex pass', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const result = await evaluateConditions(
      [{ type: 'message_matches_regex', config: { value: 'he..o' } }],
      { member: null, guild: guild(), channelId: 'ch1', messageContent: 'hello world', supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(true);
  });

  it('message_matches_regex too long', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const result = await evaluateConditions(
      [{ type: 'message_matches_regex', config: { value: 'a'.repeat(201) } }],
      { member: null, guild: guild(), channelId: 'ch1', messageContent: 'hello', supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(false);
  });

  it('is_returning_member pass', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const supa = { from: vi.fn(() => chain({ is_returning: true })) } as any;
    const result = await evaluateConditions(
      [{ type: 'is_returning_member', config: {} }],
      { member: member(), guild: guild(), channelId: null, messageContent: null, supabase: supa, guildId: 'g1' },
    );
    expect(result).toBe(true);
  });

  it('is_new_member pass', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const supa = { from: vi.fn(() => chain({ is_returning: false })) } as any;
    const result = await evaluateConditions(
      [{ type: 'is_new_member', config: {} }],
      { member: member(), guild: guild(), channelId: null, messageContent: null, supabase: supa, guildId: 'g1' },
    );
    expect(result).toBe(true);
  });

  it('time_window pass', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const result = await evaluateConditions(
      [{ type: 'time_window', config: { start_hour: 0, end_hour: 23 } }],
      { member: null, guild: guild(), channelId: null, messageContent: null, supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(true);
  });

  it('time_window with days', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    // Use all days so it always passes
    const result = await evaluateConditions(
      [{ type: 'time_window', config: { days: [0,1,2,3,4,5,6] } }],
      { member: null, guild: guild(), channelId: null, messageContent: null, supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(true);
  });

  it('user_is pass', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const result = await evaluateConditions(
      [{ type: 'user_is', config: { value: 'u1' } }],
      { member: member('u1'), guild: guild(), channelId: null, messageContent: null, supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(true);
  });

  it('unknown condition type', async () => {
    const { evaluateConditions } = await import('../features/automations/condition-evaluator.js');
    const result = await evaluateConditions(
      [{ type: 'unknown_type', config: {} }],
      { member: null, guild: guild(), channelId: null, messageContent: null, supabase: {} as any, guildId: 'g1' },
    );
    expect(result).toBe(true); // defaults to true
  });
});

// ═══════════════════════════════════════════════
// Action Executor — all action types
// ═══════════════════════════════════════════════
describe('ActionExecutor', () => {
  const rateLimiter = {
    allowFire: vi.fn(async () => true),
    allowDM: vi.fn(async () => true),
    allowCustom: vi.fn(async () => true),
  };

  function ctx(overrides: any = {}) {
    const g = guild();
    const m = member();
    const msg = {
      id: 'msg1',
      reply: vi.fn(async () => ({})),
      react: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      deletable: true,
      startThread: vi.fn(async () => ({})),
    } as any;
    return {
      guild: g, member: m, channelId: 'ch1', messageId: 'msg1',
      message: msg, supabase: { from: vi.fn(() => chain(null)), rpc: vi.fn(async () => ({ data: 1, error: null })) } as any,
      guildId: 'g1', rateLimiter, automationId: 'auto1',
      variables: { user: '<@u1>', channel: '#general' },
      ...overrides,
    } as any;
  }

  it('send_message success', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'send_message', config: { channel_id: 'ch1', message: 'Hello {user}!' } }],
      ctx(),
    );
    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('send_message no channel', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'send_message', config: { channel_id: 'missing', message: 'Hello' } }],
      ctx(),
    );
    expect(result.failed).toBe(1);
  });

  it('send_dm success', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'send_dm', config: { message: 'Hey {user}!' } }],
      ctx(),
    );
    expect(result.executed).toBe(1);
  });

  it('send_dm no member', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'send_dm', config: { message: 'Hey!' } }],
      ctx({ member: null }),
    );
    expect(result.failed).toBe(1);
  });

  it('send_dm rate limited', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const rl = { ...rateLimiter, allowDM: vi.fn(async () => false) };
    const result = await executeActions(
      [{ type: 'send_dm', config: { message: 'Hey!' } }],
      ctx({ rateLimiter: rl }),
    );
    expect(result.failed).toBe(1);
  });

  it('reply_to_message success', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'reply_to_message', config: { message: 'Thanks!' } }],
      ctx(),
    );
    expect(result.executed).toBe(1);
  });

  it('reply_to_message no message', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'reply_to_message', config: { message: 'Thanks!' } }],
      ctx({ message: null }),
    );
    expect(result.failed).toBe(1);
  });

  it('give_role success', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'give_role', config: { role_id: 'r1' } }],
      ctx(),
    );
    expect(result.executed).toBe(1);
  });

  it('give_role no role found', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'give_role', config: { role_id: 'r999' } }],
      ctx(),
    );
    expect(result.failed).toBe(1);
  });

  it('remove_role success', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'remove_role', config: { role_id: 'r1' } }],
      ctx(),
    );
    expect(result.executed).toBe(1);
  });

  it('add_reaction success', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'add_reaction', config: { emoji: '⭐' } }],
      ctx(),
    );
    expect(result.executed).toBe(1);
  });

  it('delete_message success', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'delete_message', config: {} }],
      ctx(),
    );
    expect(result.executed).toBe(1);
  });

  it('create_thread success', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'create_thread', config: { name: 'Discussion' } }],
      ctx(),
    );
    expect(result.executed).toBe(1);
  });

  it('wait_delay success', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'wait_delay', config: { seconds: 0 } }],
      ctx(),
    );
    expect(result.executed).toBe(1);
  });

  it('log_to_channel success', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'log_to_channel', config: { channel_id: 'ch1', message: 'Log: {user}' } }],
      ctx(),
    );
    expect(result.executed).toBe(1);
  });

  it('ban_member success', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'ban_member', config: { reason: 'Spam' } }],
      ctx(),
    );
    expect(result.executed).toBe(1);
  });

  it('ban_member not bannable', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const m = member();
    m.bannable = false;
    const result = await executeActions(
      [{ type: 'ban_member', config: {} }],
      ctx({ member: m }),
    );
    expect(result.failed).toBe(1);
  });

  it('kick_member success', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'kick_member', config: { reason: 'Bad behavior' } }],
      ctx(),
    );
    expect(result.executed).toBe(1);
  });

  it('mute_member success', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'mute_member', config: { duration_minutes: 10, reason: 'Spam' } }],
      ctx(),
    );
    expect(result.executed).toBe(1);
  });

  it('unknown action type', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const result = await executeActions(
      [{ type: 'unknown_action', config: {} }],
      ctx(),
    );
    expect(result.failed).toBe(1);
  });
});
