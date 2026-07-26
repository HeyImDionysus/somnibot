/**
 * AchievementsManager — coverage tests.
 *
 * Imports the REAL AchievementsManager class and mocks only external
 * boundaries (Discord.js, Supabase).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    fields: Array<{ name: string; value: string }> = [];
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setColor(c: number) { this.data.color = c; return this; }
    setFooter(f: { text: string }) { this.data.footer = f; return this; }
    addFields(...fields: Array<{ name: string; value: string }>) {
      this.fields.push(...fields);
      return this;
    }
  },
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { AchievementsManager, registerAchievementsManager, invalidateAchievementsCache } from '../features/achievements/achievements-manager.js';

// ── Helpers ───────────────────────────────────────────────

function chainable(resolveValue: unknown = null) {
  const chain: Record<string, any> = {};
  const methods = ['from', 'select', 'eq', 'order', 'limit', 'single', 'insert', 'update', 'rpc'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (resolve: (v: any) => void) => resolve({ data: resolveValue, error: null, count: 0 });
  (chain as any)[Symbol.toStringTag] = 'Promise';
  return chain;
}

function makeSupabase(overrides: Record<string, any> = {}) {
  const rpcResult = overrides.rpcResult ?? { error: null };
  const sb: Record<string, any> = {
    from: vi.fn().mockImplementation((_table: string) => {
      const chain: Record<string, any> = {};
      const methods = ['select', 'eq', 'order', 'limit', 'single', 'insert', 'update', 'maybeSingle'];
      for (const m of methods) {
        chain[m] = vi.fn().mockReturnValue(chain);
      }
      // Default resolve
      chain.then = (resolve: (v: any) => void) => resolve({ data: overrides[_table] ?? null, error: null, count: overrides[`${_table}_count`] ?? 0 });
      (chain as any)[Symbol.toStringTag] = 'Promise';
      return chain;
    }),
    rpc: vi.fn().mockResolvedValue(rpcResult),
  };
  return sb;
}

function makeInteraction(overrides: Record<string, any> = {}) {
  return {
    guildId: overrides.guildId ?? 'g1',
    user: { id: overrides.userId ?? 'u1' },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    options: {
      getString: vi.fn().mockReturnValue(overrides.getString ?? null),
      getUser: vi.fn().mockReturnValue(overrides.getUser ?? null),
      getInteger: vi.fn().mockReturnValue(overrides.getInteger ?? null),
    },
  };
}

// ── Tests ────────────────────────────────────────────────

describe('AchievementsManager', () => {
  let mgr: AchievementsManager;
  let supabase: ReturnType<typeof makeSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    supabase = makeSupabase();
    mgr = new AchievementsManager(supabase as any);
  });

  describe('constructor & cache', () => {
    it('creates an instance', () => {
      expect(mgr).toBeInstanceOf(AchievementsManager);
    });

    it('clearCache clears the config cache', () => {
      mgr.clearCache();
      // No error
    });
  });

  describe('registerAchievementsManager / invalidateAchievementsCache', () => {
    it('registers and invalidates without error', () => {
      registerAchievementsManager(mgr, 'test-guild-id');
      invalidateAchievementsCache();
    });

    it('invalidateAchievementsCache with null manager', () => {
      registerAchievementsManager(null as any, 'test-guild-id');
      invalidateAchievementsCache(); // should not throw
    });
  });

  describe('viewBadges', () => {
    it('shows achievements with some unlocked', async () => {
      const defs = [
        { id: 'a1', name: 'First Win', badge_emoji: '🏆', description: 'Win once', hidden: false },
        { id: 'a2', name: 'Secret', badge_emoji: '❓', description: 'Hidden', hidden: true },
        { id: 'a3', name: 'Rich', badge_emoji: '💰', description: 'Get rich', hidden: false },
      ];
      const userAch = [{ achievement_id: 'a1' }];

      supabase = makeSupabase({
        economy_achievement_defs: defs,
        economy_user_achievements: userAch,
      });
      mgr = new AchievementsManager(supabase as any);

      const interaction = makeInteraction();
      await mgr.viewBadges(interaction as any);

      expect(interaction.reply).toHaveBeenCalledOnce();
      const call = interaction.reply.mock.calls[0][0];
      expect(call.embeds).toHaveLength(1);
    });

    it('shows empty message when no achievements defined', async () => {
      supabase = makeSupabase({
        economy_achievement_defs: [],
        economy_user_achievements: [],
      });
      mgr = new AchievementsManager(supabase as any);

      const interaction = makeInteraction();
      await mgr.viewBadges(interaction as any);
      expect(interaction.reply).toHaveBeenCalledOnce();
    });

    it('handles null data gracefully', async () => {
      supabase = makeSupabase({});
      mgr = new AchievementsManager(supabase as any);

      const interaction = makeInteraction();
      await mgr.viewBadges(interaction as any);
      expect(interaction.reply).toHaveBeenCalledOnce();
    });
  });

  describe('checkAndUnlock', () => {
    it('returns null when achievements disabled', async () => {
      supabase = makeSupabase({
        guild_config: { economy_achievements_enabled: false },
      });
      mgr = new AchievementsManager(supabase as any);

      const result = await mgr.checkAndUnlock('g1', 'u1', 'messages_sent', 100);
      expect(result).toBeNull();
    });

    it('unlocks achievement when condition met', async () => {
      // First call: getConfig
      const fromMock = vi.fn();
      const sb: Record<string, any> = {
        from: fromMock,
        rpc: vi.fn().mockResolvedValue({ error: null }),
      };

      let configCalled = false;

      fromMock.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'order', 'limit', 'single', 'insert', 'upsert', 'update', 'maybeSingle'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }

        if (table === 'guild_config' && !configCalled) {
          configCalled = true;
          chain.then = (resolve: (v: any) => void) => resolve({
            data: { economy_achievements_enabled: true },
            error: null,
          });
        } else if (table === 'economy_achievement_defs') {
          chain.then = (resolve: (v: any) => void) => resolve({
            data: [{ id: 'a1', condition_type: 'messages_sent', condition_value: 50, reward_currency: 100, name: 'Chatterbox' }],
            error: null,
          });
        } else if (table === 'economy_user_achievements') {
          // Idempotent upsert inserted a new row → returns it.
          chain.then = (resolve: (v: any) => void) => resolve({ data: [{ id: 'ua1' }], error: null });
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        (chain as any)[Symbol.toStringTag] = 'Promise';
        return chain;
      });

      mgr = new AchievementsManager(sb as any);
      const result = await mgr.checkAndUnlock('g1', 'u1', 'messages_sent', 100);
      expect(result).toBe('Chatterbox');
    });

    it('returns null when value below threshold', async () => {
      const fromMock = vi.fn();
      const sb: Record<string, any> = {
        from: fromMock,
        rpc: vi.fn().mockResolvedValue({ error: null }),
      };

      fromMock.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'order', 'limit', 'single', 'insert', 'update', 'maybeSingle'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }

        if (table === 'guild_config') {
          chain.then = (resolve: (v: any) => void) => resolve({
            data: { economy_achievements_enabled: true },
            error: null,
          });
        } else if (table === 'economy_achievement_defs') {
          chain.then = (resolve: (v: any) => void) => resolve({
            data: [{ id: 'a1', condition_type: 'messages_sent', condition_value: 500, reward_currency: 0, name: 'Mega Chat' }],
            error: null,
          });
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        (chain as any)[Symbol.toStringTag] = 'Promise';
        return chain;
      });

      mgr = new AchievementsManager(sb as any);
      const result = await mgr.checkAndUnlock('g1', 'u1', 'messages_sent', 10);
      expect(result).toBeNull();
    });

    it('skips already unlocked achievements', async () => {
      const fromMock = vi.fn();
      const sb: Record<string, any> = {
        from: fromMock,
        rpc: vi.fn().mockResolvedValue({ error: null }),
      };

      fromMock.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'order', 'limit', 'single', 'insert', 'upsert', 'update', 'maybeSingle'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }

        if (table === 'guild_config') {
          chain.then = (resolve: (v: any) => void) => resolve({
            data: { economy_achievements_enabled: true },
            error: null,
          });
        } else if (table === 'economy_achievement_defs') {
          chain.then = (resolve: (v: any) => void) => resolve({
            data: [{ id: 'a1', condition_type: 'messages_sent', condition_value: 50, reward_currency: 0, name: 'Chat' }],
            error: null,
          });
        } else if (table === 'economy_user_achievements') {
          // Already unlocked → ON CONFLICT DO NOTHING returns no row.
          chain.then = (resolve: (v: any) => void) => resolve({ data: [], error: null });
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        (chain as any)[Symbol.toStringTag] = 'Promise';
        return chain;
      });

      mgr = new AchievementsManager(sb as any);
      const result = await mgr.checkAndUnlock('g1', 'u1', 'messages_sent', 100);
      expect(result).toBeNull();
    });

    it('handles rpc reward error gracefully', async () => {
      const fromMock = vi.fn();
      const sb: Record<string, any> = {
        from: fromMock,
        rpc: vi.fn().mockResolvedValue({ error: { message: 'rpc failed' } }),
      };

      fromMock.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'order', 'limit', 'single', 'insert', 'upsert', 'update', 'maybeSingle'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }

        if (table === 'guild_config') {
          chain.then = (resolve: (v: any) => void) => resolve({
            data: { economy_achievements_enabled: true },
            error: null,
          });
        } else if (table === 'economy_achievement_defs') {
          chain.then = (resolve: (v: any) => void) => resolve({
            data: [{ id: 'a1', condition_type: 'level', condition_value: 5, reward_currency: 500, name: 'Level Up' }],
            error: null,
          });
        } else if (table === 'economy_user_achievements') {
          // Newly inserted → reward is attempted (and its RPC error is swallowed).
          chain.then = (resolve: (v: any) => void) => resolve({ data: [{ id: 'ua1' }], error: null });
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        (chain as any)[Symbol.toStringTag] = 'Promise';
        return chain;
      });

      mgr = new AchievementsManager(sb as any);
      const result = await mgr.checkAndUnlock('g1', 'u1', 'level', 10);
      // Still returns the achievement name even if reward fails
      expect(result).toBe('Level Up');
    });

    it('uses config cache for repeated calls', async () => {
      const fromMock = vi.fn();
      const sb: Record<string, any> = {
        from: fromMock,
        rpc: vi.fn().mockResolvedValue({ error: null }),
      };

      fromMock.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'order', 'limit', 'single', 'insert', 'update', 'maybeSingle'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }

        if (table === 'guild_config') {
          chain.then = (resolve: (v: any) => void) => resolve({
            data: { economy_achievements_enabled: false },
            error: null,
          });
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        (chain as any)[Symbol.toStringTag] = 'Promise';
        return chain;
      });

      mgr = new AchievementsManager(sb as any);
      // First call fetches from DB
      await mgr.checkAndUnlock('g1', 'u1', 'test', 1);
      // Second call should use cache
      await mgr.checkAndUnlock('g1', 'u1', 'test', 2);
      // Config table should only be queried once
      const configCalls = fromMock.mock.calls.filter((c: any[]) => c[0] === 'guild_config');
      expect(configCalls).toHaveLength(1);
    });
  });

  describe('prestige', () => {
    it('rejects when prestige disabled', async () => {
      const fromMock = vi.fn();
      const sb: Record<string, any> = {
        from: fromMock,
        rpc: vi.fn().mockResolvedValue({ error: null }),
      };

      fromMock.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'order', 'limit', 'single', 'insert', 'update', 'maybeSingle'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }
        if (table === 'guild_config') {
          chain.then = (resolve: (v: any) => void) => resolve({
            data: { economy_prestige_enabled: false },
            error: null,
          });
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        (chain as any)[Symbol.toStringTag] = 'Promise';
        return chain;
      });

      mgr = new AchievementsManager(sb as any);
      mgr.clearCache(); // clear from earlier tests
      const interaction = makeInteraction();
      await mgr.prestige(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('not enabled'),
        ephemeral: true,
      }));
    });

    // prestige now delegates the requirement checks + reset + bump to the atomic
    // economy_prestige_apply RPC; each case mocks getConfig (guild_config)
    // enabled and the RPC's returned status.
    function prestigeSb(rpcData: unknown) {
      const rpc = vi.fn().mockResolvedValue({ data: rpcData, error: null });
      const fromMock = vi.fn().mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        for (const m of ['select', 'eq', 'order', 'limit', 'single', 'insert', 'update', 'maybeSingle']) chain[m] = vi.fn().mockReturnValue(chain);
        chain.then = (resolve: (v: any) => void) => resolve(table === 'guild_config'
          ? { data: { economy_prestige_enabled: true, economy_prestige_min_level: 50, economy_prestige_min_net_worth: 1000000, economy_prestige_multiplier_pct: 10, economy_prestige_max_level: 10 }, error: null }
          : { data: null, error: null });
        (chain as any)[Symbol.toStringTag] = 'Promise';
        return chain;
      });
      return { from: fromMock, rpc };
    }

    it('rejects when user level too low', async () => {
      mgr = new AchievementsManager(prestigeSb({ status: 'level_too_low', replayed: false, level: 10 }) as any);
      const interaction = makeInteraction();
      await mgr.prestige(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('level'), ephemeral: true }));
    });

    it('rejects when net worth too low', async () => {
      mgr = new AchievementsManager(prestigeSb({ status: 'net_worth_too_low', replayed: false, net_worth: 150 }) as any);
      const interaction = makeInteraction();
      await mgr.prestige(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('net worth'), ephemeral: true }));
    });

    it('successfully prestiges via the atomic RPC', async () => {
      mgr = new AchievementsManager(prestigeSb({ status: 'prestiged', replayed: false, new_level: 1, new_multiplier: 10 }) as any);
      const interaction = makeInteraction();
      await mgr.prestige(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
    });

    it('is idempotent: a replayed prestige reports success without a second bump', async () => {
      mgr = new AchievementsManager(prestigeSb({ status: 'prestiged', replayed: true, new_level: 3, new_multiplier: 30 }) as any);
      const interaction = makeInteraction();
      await mgr.prestige(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
    });

    it('prestiges an existing record (RPC bumps level + multiplier)', async () => {
      // The RPC handles reading the existing record and bumping it; here it
      // returns the post-bump level 3 / multiplier 45.
      mgr = new AchievementsManager(prestigeSb({ status: 'prestiged', replayed: false, new_level: 3, new_multiplier: 45 }) as any);
      const interaction = makeInteraction();
      await mgr.prestige(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
    });

    it('passes the configured max level and refuses a capped member without a further bump', async () => {
      const sb = prestigeSb({ status: 'prestige_capped', replayed: false, level: 10, max_level: 10 });
      mgr = new AchievementsManager(sb as any);
      const interaction = makeInteraction();
      await mgr.prestige(interaction as any);

      // The cap is threaded into the atomic RPC.
      expect(sb.rpc).toHaveBeenCalledWith('economy_prestige_apply', expect.objectContaining({ p_max_level: 10 }));
      // A capped member gets an ephemeral refusal (no prestige embed).
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('maximum prestige level'),
        ephemeral: true,
      }));
    });
  });
});
