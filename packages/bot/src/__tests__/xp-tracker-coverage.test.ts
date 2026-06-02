/**
 * levels/xp-tracker — coverage tests
 *
 * Tests loadLevelConfig, processMessageXp, grantVoiceXp, invalidateLevelCaches
 * with REAL imports for v8 coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({}));

vi.mock('@somnibot/shared', () => ({
  calculateLevel: vi.fn().mockImplementation((xp: number) => Math.floor(xp / 100)),
  randomXp: vi.fn().mockReturnValue(25),
  LEVEL_CONFIG: {
    DEFAULT_MIN_XP: 15,
    DEFAULT_MAX_XP: 25,
    DEFAULT_COOLDOWN_SECONDS: 60,
    DEFAULT_VOICE_XP_PER_INTERVAL: 10,
    DEFAULT_VOICE_INTERVAL_MINUTES: 5,
    XP_FORMULA: (lvl: number) => lvl * 100,
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  loadLevelConfig,
  processMessageXp,
  grantVoiceXp,
  invalidateLevelCaches,
} from '../features/levels/xp-tracker.js';

function chainBuilder(resolveValue: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'maybeSingle', 'upsert']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeSupabase(responses: Record<string, any> = {}) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (responses[table]) return chainBuilder(responses[table]);
      return chainBuilder();
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
}

class MockCollection<K, V> extends Map<K, V> {
  map(fn: (v: V) => any): any[] {
    return [...this.values()].map(fn);
  }
  filter(fn: (v: V) => boolean): MockCollection<K, V> {
    const result = new MockCollection<K, V>();
    for (const [k, v] of this) {
      if (fn(v)) result.set(k, v);
    }
    return result;
  }
}

function makeMessage(overrides: any = {}) {
  const roles = new MockCollection<string, any>();
  roles.set('role1', { id: 'role1' });
  return {
    channel: { id: 'ch1' },
    author: { id: 'u1', bot: false },
    member: {
      roles: { cache: roles },
    },
    ...overrides,
  };
}

function makeValkey() {
  const store = new Map<string, string>();
  return {
    set: vi.fn().mockImplementation(
      async (key: string, val: string, ...args: any[]) => {
        const hasNX = args.includes('NX');
        if (hasNX && store.has(key)) return null;
        store.set(key, val);
        return 'OK';
      },
    ),
    get: vi.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
    _store: store,
  };
}

describe('loadLevelConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateLevelCaches();
  });

  it('loads config from supabase with defaults', async () => {
    const supabase = makeSupabase({ guild_config: { data: null, error: null } });
    const config = await loadLevelConfig(supabase as any, 'g1');
    expect(config.levels_enabled).toBe(false);
    expect(config.xp_min).toBe(15);
    expect(config.xp_max).toBe(25);
    expect(config.xp_cooldown_seconds).toBe(60);
  });

  it('returns cached config on second call', async () => {
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: true, xp_min: 20, xp_max: 30 }, error: null },
    });
    await loadLevelConfig(supabase as any, 'g2');
    await loadLevelConfig(supabase as any, 'g2');
    // from() should only be called once since second call uses cache
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('loads actual values from DB', async () => {
    const supabase = makeSupabase({
      guild_config: {
        data: {
          levels_enabled: true,
          xp_min: 10,
          xp_max: 50,
          xp_cooldown_seconds: 30,
          voice_xp_enabled: true,
          xp_multiplier_mode: 'additive',
          xp_channel_mode: 'whitelist',
          xp_channel_list: ['ch1'],
          level_up_channel_id: 'ch2',
          level_up_message: 'GG {user}!',
          no_xp_role_id: 'muted',
        },
        error: null,
      },
    });
    const config = await loadLevelConfig(supabase as any, 'g3');
    expect(config.levels_enabled).toBe(true);
    expect(config.xp_min).toBe(10);
    expect(config.xp_max).toBe(50);
    expect(config.voice_xp_enabled).toBe(true);
    expect(config.xp_multiplier_mode).toBe('additive');
    expect(config.xp_channel_mode).toBe('whitelist');
    expect(config.xp_channel_list).toEqual(['ch1']);
  });
});

describe('processMessageXp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateLevelCaches();
  });

  it('returns false when levels disabled', async () => {
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: false }, error: null },
    });
    const result = await processMessageXp(makeMessage() as any, supabase as any, makeValkey() as any, 'g1');
    expect(result.granted).toBe(false);
  });

  it('returns false for blacklisted channel', async () => {
    const supabase = makeSupabase({
      guild_config: {
        data: { levels_enabled: true, xp_channel_mode: 'blacklist', xp_channel_list: ['ch1'] },
        error: null,
      },
    });
    const result = await processMessageXp(makeMessage() as any, supabase as any, makeValkey() as any, 'g1');
    expect(result.granted).toBe(false);
  });

  it('returns false for no-xp role', async () => {
    const supabase = makeSupabase({
      guild_config: {
        data: { levels_enabled: true, no_xp_role_id: 'role1', xp_channel_list: [] },
        error: null,
      },
    });
    const result = await processMessageXp(makeMessage() as any, supabase as any, makeValkey() as any, 'g1');
    expect(result.granted).toBe(false);
  });

  it('returns false on cooldown', async () => {
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: true, xp_channel_list: [], no_xp_role_id: null }, error: null },
      xp_multipliers: { data: [], error: null },
    });
    const valkey = makeValkey();
    valkey._store.set('xp:cooldown:g1:u1', '1'); // Already on cooldown
    const result = await processMessageXp(makeMessage() as any, supabase as any, valkey as any, 'g1');
    expect(result.granted).toBe(false);
  });

  it('grants XP successfully via RPC', async () => {
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: true, xp_channel_list: [], no_xp_role_id: null }, error: null },
      xp_multipliers: { data: [], error: null },
    });
    supabase.rpc.mockResolvedValue({
      data: { new_xp: 125, old_level: 1, new_level: 1 },
      error: null,
    });
    const valkey = makeValkey();
    const result = await processMessageXp(makeMessage() as any, supabase as any, valkey as any, 'g1');
    expect(result.granted).toBe(true);
    expect(result.newXp).toBe(125);
  });

  it('returns granted:false when RPC returns null (fail-fast, no fallback)', async () => {
    // V10 Audit §3: Non-atomic fallback was removed to prevent XP race conditions.
    // When the RPC is missing (null return), the function now fails fast.
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: true, xp_channel_list: [], no_xp_role_id: null }, error: null },
      xp_multipliers: { data: [], error: null },
    });
    supabase.rpc.mockResolvedValue({ data: null, error: null });
    const valkey = makeValkey();
    const result = await processMessageXp(makeMessage() as any, supabase as any, valkey as any, 'g1');
    expect(result.granted).toBe(false);
  });

  it('returns false on RPC error', async () => {
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: true, xp_channel_list: [], no_xp_role_id: null }, error: null },
      xp_multipliers: { data: [], error: null },
    });
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const valkey = makeValkey();
    const result = await processMessageXp(makeMessage() as any, supabase as any, valkey as any, 'g1');
    expect(result.granted).toBe(false);
  });

  it('detects level up', async () => {
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: true, xp_channel_list: [], no_xp_role_id: null }, error: null },
      xp_multipliers: { data: [], error: null },
    });
    supabase.rpc.mockResolvedValue({
      data: { new_xp: 200, old_level: 1, new_level: 2 },
      error: null,
    });
    const valkey = makeValkey();
    const result = await processMessageXp(makeMessage() as any, supabase as any, valkey as any, 'g1');
    expect(result.leveledUp).toBe(true);
    expect(result.newLevel).toBe(2);
  });

  it('applies XP multiplier (highest mode)', async () => {
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: true, xp_channel_list: [], no_xp_role_id: null, xp_multiplier_mode: 'highest' }, error: null },
      xp_multipliers: { data: [{ role_id: 'role1', multiplier: 2.0 }], error: null },
    });
    supabase.rpc.mockResolvedValue({
      data: { new_xp: 100, old_level: 0, new_level: 1 },
      error: null,
    });
    const valkey = makeValkey();
    const result = await processMessageXp(makeMessage() as any, supabase as any, valkey as any, 'g1');
    expect(result.granted).toBe(true);
    // XP should be 25 * 2.0 = 50 passed to RPC
    expect(supabase.rpc).toHaveBeenCalledWith('increment_member_xp', expect.objectContaining({
      p_xp_amount: 50,
    }));
  });

  it('works with whitelist channel mode', async () => {
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: true, xp_channel_mode: 'whitelist', xp_channel_list: ['ch1'], no_xp_role_id: null }, error: null },
      xp_multipliers: { data: [], error: null },
    });
    supabase.rpc.mockResolvedValue({
      data: { new_xp: 50, old_level: 0, new_level: 0 },
      error: null,
    });
    const valkey = makeValkey();
    const result = await processMessageXp(makeMessage() as any, supabase as any, valkey as any, 'g1');
    expect(result.granted).toBe(true);
  });
});

describe('grantVoiceXp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateLevelCaches();
  });

  it('returns false when voice XP disabled', async () => {
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: true, voice_xp_enabled: false }, error: null },
    });
    const result = await grantVoiceXp(supabase as any, makeValkey() as any, 'g1', 'u1', [], 10);
    expect(result.granted).toBe(false);
  });

  it('returns false when levels disabled', async () => {
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: false }, error: null },
    });
    const result = await grantVoiceXp(supabase as any, makeValkey() as any, 'g1', 'u1', [], 10);
    expect(result.granted).toBe(false);
  });

  it('returns false for no-xp role', async () => {
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: true, voice_xp_enabled: true, no_xp_role_id: 'muted' }, error: null },
    });
    const result = await grantVoiceXp(supabase as any, makeValkey() as any, 'g1', 'u1', ['muted'], 10);
    expect(result.granted).toBe(false);
  });

  it('grants voice XP via RPC', async () => {
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: true, voice_xp_enabled: true, no_xp_role_id: null }, error: null },
      xp_multipliers: { data: [], error: null },
    });
    supabase.rpc.mockResolvedValue({
      data: { new_xp: 60, old_level: 0, new_level: 0 },
      error: null,
    });
    const result = await grantVoiceXp(supabase as any, makeValkey() as any, 'g1', 'u1', [], 10);
    expect(result.granted).toBe(true);
    expect(result.newXp).toBe(60);
  });

  it('returns granted:false when RPC returns null (fail-fast, no fallback)', async () => {
    // V10 Audit §3: Non-atomic fallback was removed to prevent XP race conditions.
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: true, voice_xp_enabled: true, no_xp_role_id: null }, error: null },
      xp_multipliers: { data: [], error: null },
    });
    supabase.rpc.mockResolvedValue({ data: null, error: null });
    const result = await grantVoiceXp(supabase as any, makeValkey() as any, 'g1', 'u1', [], 10);
    expect(result.granted).toBe(false);
  });

  it('returns false on RPC error', async () => {
    const supabase = makeSupabase({
      guild_config: { data: { levels_enabled: true, voice_xp_enabled: true, no_xp_role_id: null }, error: null },
      xp_multipliers: { data: [], error: null },
    });
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'fail' } });
    const result = await grantVoiceXp(supabase as any, makeValkey() as any, 'g1', 'u1', [], 10);
    expect(result.granted).toBe(false);
  });
});

describe('invalidateLevelCaches', () => {
  it('invalidates specific guild caches', () => {
    invalidateLevelCaches('g1');
    // No throw = success
  });

  it('invalidates all caches', () => {
    invalidateLevelCaches();
  });
});
