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

vi.mock('@somnibot/shared', () => ({
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
  chain[Symbol.toStringTag] = 'Promise';
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
      chain[Symbol.toStringTag] = 'Promise';
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
      registerAchievementsManager(mgr);
      invalidateAchievementsCache();
    });

    it('invalidateAchievementsCache with null manager', () => {
      registerAchievementsManager(null as any);
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

      // Track call count for different tables
      let configCalled = false;
      let defsCalled = false;
      let existingCalled = false;
      let insertCalled = false;

      fromMock.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'order', 'limit', 'single', 'insert', 'update', 'maybeSingle'];
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
          defsCalled = true;
          chain.then = (resolve: (v: any) => void) => resolve({
            data: [{ id: 'a1', condition_type: 'messages_sent', condition_value: 50, reward_currency: 100, name: 'Chatterbox' }],
            error: null,
          });
        } else if (table === 'economy_user_achievements' && !existingCalled) {
          existingCalled = true;
          // Check if already unlocked -> no
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        } else if (table === 'economy_user_achievements' && existingCalled && !insertCalled) {
          insertCalled = true;
          chain.then = (resolve: (v: any) => void) => resolve({ data: {}, error: null });
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        chain[Symbol.toStringTag] = 'Promise';
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
        chain[Symbol.toStringTag] = 'Promise';
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
            data: [{ id: 'a1', condition_type: 'messages_sent', condition_value: 50, reward_currency: 0, name: 'Chat' }],
            error: null,
          });
        } else if (table === 'economy_user_achievements') {
          // Already unlocked
          chain.then = (resolve: (v: any) => void) => resolve({ data: { id: 'existing' }, error: null });
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        chain[Symbol.toStringTag] = 'Promise';
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

      let checkCount = 0;
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
            data: [{ id: 'a1', condition_type: 'level', condition_value: 5, reward_currency: 500, name: 'Level Up' }],
            error: null,
          });
        } else if (table === 'economy_user_achievements') {
          checkCount++;
          if (checkCount === 1) {
            // Not unlocked yet
            chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
          } else {
            // Insert
            chain.then = (resolve: (v: any) => void) => resolve({ data: {}, error: null });
          }
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        chain[Symbol.toStringTag] = 'Promise';
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
        chain[Symbol.toStringTag] = 'Promise';
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
        chain[Symbol.toStringTag] = 'Promise';
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

    it('rejects when user level too low', async () => {
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
            data: { economy_prestige_enabled: true, economy_prestige_min_level: 50, economy_prestige_min_net_worth: 1000000 },
            error: null,
          });
        } else if (table === 'economy_wallets') {
          chain.then = (resolve: (v: any) => void) => resolve({ data: { wallet: 2000000, bank: 0 }, error: null });
        } else if (table === 'member_levels') {
          chain.then = (resolve: (v: any) => void) => resolve({ data: { level: 10 }, error: null });
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        chain[Symbol.toStringTag] = 'Promise';
        return chain;
      });

      mgr = new AchievementsManager(sb as any);
      const interaction = makeInteraction();
      await mgr.prestige(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('level'),
        ephemeral: true,
      }));
    });

    it('rejects when net worth too low', async () => {
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
            data: { economy_prestige_enabled: true, economy_prestige_min_level: 50, economy_prestige_min_net_worth: 1000000 },
            error: null,
          });
        } else if (table === 'economy_wallets') {
          chain.then = (resolve: (v: any) => void) => resolve({ data: { wallet: 100, bank: 50 }, error: null });
        } else if (table === 'member_levels') {
          chain.then = (resolve: (v: any) => void) => resolve({ data: { level: 60 }, error: null });
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        chain[Symbol.toStringTag] = 'Promise';
        return chain;
      });

      mgr = new AchievementsManager(sb as any);
      const interaction = makeInteraction();
      await mgr.prestige(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('net worth'),
        ephemeral: true,
      }));
    });

    it('successfully prestiges (new prestige record)', async () => {
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
            data: { economy_prestige_enabled: true, economy_prestige_min_level: 50, economy_prestige_min_net_worth: 1000000, economy_prestige_multiplier_pct: 10 },
            error: null,
          });
        } else if (table === 'economy_wallets') {
          chain.then = (resolve: (v: any) => void) => resolve({ data: { wallet: 500000, bank: 600000 }, error: null });
        } else if (table === 'member_levels') {
          chain.then = (resolve: (v: any) => void) => resolve({ data: { level: 55 }, error: null });
        } else if (table === 'economy_prestige') {
          // No existing prestige record
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        chain[Symbol.toStringTag] = 'Promise';
        return chain;
      });

      mgr = new AchievementsManager(sb as any);
      const interaction = makeInteraction();
      await mgr.prestige(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        embeds: expect.any(Array),
      }));
    });

    it('successfully prestiges with existing record', async () => {
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
            data: { economy_prestige_enabled: true, economy_prestige_min_level: 50, economy_prestige_min_net_worth: 1000000, economy_prestige_multiplier_pct: 15 },
            error: null,
          });
        } else if (table === 'economy_wallets') {
          chain.then = (resolve: (v: any) => void) => resolve({ data: { wallet: 800000, bank: 500000 }, error: null });
        } else if (table === 'member_levels') {
          chain.then = (resolve: (v: any) => void) => resolve({ data: { level: 60 }, error: null });
        } else if (table === 'economy_prestige') {
          chain.then = (resolve: (v: any) => void) => resolve({
            data: { id: 'p1', prestige_level: 2, total_resets: 2, multiplier_pct: 30 },
            error: null,
          });
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        chain[Symbol.toStringTag] = 'Promise';
        return chain;
      });

      mgr = new AchievementsManager(sb as any);
      const interaction = makeInteraction();
      await mgr.prestige(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        embeds: expect.any(Array),
      }));
    });
  });
});
