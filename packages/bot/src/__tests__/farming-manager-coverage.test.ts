/**
 * FarmingManager — Full coverage tests
 *
 * Imports the REAL FarmingManager and mocks only external boundaries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    setColor(c: number) { this.data.color = c; return this; }
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setThumbnail(t: string) { this.data.thumbnail = t; return this; }
    setFooter(f: unknown) { this.data.footer = f; return this; }
    setTimestamp() { return this; }
    addFields(...f: unknown[]) { this.data.fields = f; return this; }
  },
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../quests/quests-manager.js', () => ({
  getQuestsManager: () => ({
    trackProgress: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../utils/db-helpers.js', () => ({
  walletBalance: (w: { wallet?: number } | null) => w?.wallet ?? 0,
  joinProp: (obj: Record<string, unknown>, relation: string, prop: string) => {
    const nested = obj[relation] as Record<string, unknown> | undefined;
    return nested?.[prop] ?? null;
  },
  hasErrorCode: (err: unknown, code: string) => (err as { code?: string })?.code === code,
}));

import { FarmingManager } from '../features/farming/farming-manager.js';

// ── Helpers ───────────────────────────────────────────────

const defaultConfig = {
  economy_farming_enabled: true,
  economy_farm_grid_size: 9,
  economy_farming_wilt_enabled: true,
  economy_fertilizer_time_reduction_pct: 50,
};

const defaultCrops = [
  { id: 'c1', name: 'Wheat', emoji: '🌾', grow_seconds: 3600, wilt_seconds: 86400, sell_price: 50, seed_item_id: 'seed1', seeds_returned: 1 },
  { id: 'c2', name: 'Corn', emoji: '🌽', grow_seconds: 7200, wilt_seconds: 86400, sell_price: 100, seed_item_id: null, seeds_returned: 0 },
];

/**
 * Chainable mock that resolves to the given value.
 * Each method returns the chain so .select().eq().maybeSingle() works.
 */
function chainBuilder(resolveValue: { data?: unknown; error?: unknown } = { data: null }) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'order', 'limit', 'insert', 'update', 'upsert', 'delete', 'contains', 'in', 'is'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(resolveValue);
  chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);
  // Make the chain itself thenable so `const { data } = await supabase.from(...).select()...` works
  chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(resolveValue).then(resolve, reject);
  return chain;
}

function makeSupabase(tableHandlers: Record<string, () => ReturnType<typeof chainBuilder>> = {}) {
  const defaults: Record<string, () => ReturnType<typeof chainBuilder>> = {
    guild_config: () => chainBuilder({ data: defaultConfig }),
    economy_farm_plots: () => chainBuilder({ data: [] }),
    economy_crops: () => chainBuilder({ data: defaultCrops }),
    economy_wallets: () => chainBuilder({ data: { wallet: 1000 } }),
    economy_transactions: () => chainBuilder({ data: null, error: null }),
    economy_inventory: () => chainBuilder({ data: null }),
  };

  const merged = { ...defaults, ...tableHandlers };

  return {
    from: vi.fn((table: string) => {
      const h = merged[table];
      return h ? h() : chainBuilder();
    }),
    rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
  };
}

function makeValkey() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };
}

function makeGuild() {
  return { id: 'g1' };
}

function makePlot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    plot_index: 0,
    crop_id: null as string | null,
    planted_at: null as string | null,
    watered_at: null as string | null,
    fertilized: false,
    harvested: false,
    ...overrides,
  };
}

describe('FarmingManager', () => {
  let fm: FarmingManager;
  let supabase: ReturnType<typeof makeSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    supabase = makeSupabase();
    fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
  });

  // ── Config ──────────────────────────────────────────────

  describe('getConfig', () => {
    it('loads config from supabase', async () => {
      const cfg = await fm.getConfig();
      expect(cfg.economy_farming_enabled).toBe(true);
    });

    it('caches config on second call', async () => {
      await fm.getConfig();
      const c1 = supabase.from.mock.calls.length;
      await fm.getConfig();
      expect(supabase.from.mock.calls.length).toBe(c1);
    });

    it('uses defaults when no data', async () => {
      supabase = makeSupabase({
        guild_config: () => chainBuilder({ data: null }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const cfg = await fm.getConfig();
      expect(cfg.economy_farming_enabled).toBe(false);
      expect(cfg.economy_farm_grid_size).toBe(9);
    });
  });

  describe('invalidateConfig', () => {
    it('forces re-fetch', async () => {
      await fm.getConfig();
      fm.invalidateConfig();
      await fm.getConfig();
      const calls = supabase.from.mock.calls.filter((c: string[]) => c[0] === 'guild_config');
      expect(calls.length).toBe(2);
    });
  });

  // ── viewFarm ────────────────────────────────────────────

  describe('viewFarm', () => {
    it('returns disabled msg', async () => {
      supabase = makeSupabase({
        guild_config: () => chainBuilder({ data: { ...defaultConfig, economy_farming_enabled: false } }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.viewFarm('u1');
      expect(r.embed.data.description).toContain('not enabled');
    });

    it('shows empty farm', async () => {
      const r = await fm.viewFarm('u1');
      expect(r.embed.data.title).toBe('🌾 Your Farm');
    });

    it('shows growing crop', async () => {
      const recent = new Date(Date.now() - 300_000).toISOString();
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ crop_id: 'c1', planted_at: recent, watered_at: recent })],
        }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.viewFarm('u1');
      expect(r.embed.data.title).toBe('🌾 Your Farm');
      expect(r.embed.data.description).toContain('Wheat');
    });

    it('shows ready crop', async () => {
      const longAgo = new Date(Date.now() - 7_200_000).toISOString();
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ crop_id: 'c1', planted_at: longAgo, watered_at: longAgo })],
        }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.viewFarm('u1');
      expect(r.embed.data.description).toContain('Ready');
    });

    it('shows unwatered crop', async () => {
      const recent = new Date(Date.now() - 300_000).toISOString();
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ crop_id: 'c1', planted_at: recent, watered_at: null })],
        }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.viewFarm('u1');
      expect(r.embed.data.title).toBe('🌾 Your Farm');
    });
  });

  // ── plant ───────────────────────────────────────────────

  describe('plant', () => {
    it('returns disabled msg', async () => {
      supabase = makeSupabase({
        guild_config: () => chainBuilder({ data: { ...defaultConfig, economy_farming_enabled: false } }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.plant('u1', 'Wheat');
      expect(r.embed.data.description).toContain('not enabled');
    });

    it('fails for unknown crop', async () => {
      const r = await fm.plant('u1', 'BogusPlant');
      expect(r.embed.data.description).toContain('Unknown crop');
    });

    it('plants successfully (no seeds required)', async () => {
      const r = await fm.plant('u1', 'Corn');
      expect(r.embed.data.title).toContain('Planted');
    });

    it('fails when no empty plots', async () => {
      const plots = Array.from({ length: 9 }, (_, i) =>
        makePlot({ id: `p${i}`, plot_index: i, crop_id: 'c1', planted_at: new Date().toISOString(), watered_at: new Date().toISOString() })
      );
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({ data: plots }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.plant('u1', 'Corn');
      expect(r.embed.data.description).toContain('occupied');
    });

    it('fails when no seeds', async () => {
      // Wheat needs seed1, rpc returns false (no seed)
      supabase.rpc.mockResolvedValue({ data: false, error: null });
      const r = await fm.plant('u1', 'Wheat');
      expect(r.embed.data.description).toContain("don't have any");
    });

    it('plants with seeds consumed', async () => {
      supabase.rpc.mockResolvedValue({ data: true, error: null });
      const r = await fm.plant('u1', 'Wheat');
      expect(r.embed.data.title).toContain('Planted');
    });

    it('seeds default crops when none exist', async () => {
      let cropCall = 0;
      supabase = makeSupabase({
        economy_crops: () => {
          cropCall++;
          if (cropCall <= 1) return chainBuilder({ data: [] });
          return chainBuilder({ data: defaultCrops });
        },
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.plant('u1', 'Corn');
      expect(r.embed.data.title).toContain('Planted');
    });
  });

  // ── water ───────────────────────────────────────────────

  describe('water', () => {
    it('returns disabled msg', async () => {
      supabase = makeSupabase({
        guild_config: () => chainBuilder({ data: { ...defaultConfig, economy_farming_enabled: false } }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.water('u1');
      expect(r.embed.data.description).toContain('not enabled');
    });

    it('waters unwatered plots', async () => {
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ crop_id: 'c1', planted_at: new Date().toISOString(), watered_at: null })],
        }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.water('u1');
      expect(r.embed.data.title).toBe('💧 Watered!');
    });

    it('says already watered', async () => {
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ crop_id: 'c1', planted_at: new Date().toISOString(), watered_at: new Date().toISOString() })],
        }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.water('u1');
      expect(r.embed.data.description).toContain('already watered');
    });

    it('says no crops planted', async () => {
      const r = await fm.water('u1');
      expect(r.embed.data.description).toContain('no crops planted');
    });
  });

  // ── harvest ─────────────────────────────────────────────

  describe('harvest', () => {
    it('returns disabled msg', async () => {
      supabase = makeSupabase({
        guild_config: () => chainBuilder({ data: { ...defaultConfig, economy_farming_enabled: false } }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.harvest('u1');
      expect(r.embed.data.description).toContain('not enabled');
    });

    it('harvests ready crops and pays out', async () => {
      const longAgo = new Date(Date.now() - 7_200_000).toISOString();
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ crop_id: 'c1', planted_at: longAgo, watered_at: longAgo })],
        }),
        economy_crops: () => chainBuilder({ data: defaultCrops }),
        economy_wallets: () => chainBuilder({ data: { wallet: 1050 } }),
      });
      supabase.rpc.mockResolvedValue({ data: null, error: null });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.harvest('u1');
      expect(r.embed.data.title).toBe('🌾 Harvest Complete!');
      expect(r.embed.data.description).toContain('50');
    });

    it('no crops ready', async () => {
      // Recent plant = still growing
      const recent = new Date(Date.now() - 300_000).toISOString();
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ crop_id: 'c1', planted_at: recent, watered_at: recent })],
        }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.harvest('u1');
      expect(r.embed.data.description).toContain('No crops ready');
    });

    it('reverts harvest when wallet fails', async () => {
      const longAgo = new Date(Date.now() - 7_200_000).toISOString();
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ crop_id: 'c1', planted_at: longAgo, watered_at: longAgo })],
        }),
      });
      // Make addToWallet fail
      supabase.rpc.mockResolvedValue({ data: null, error: { message: 'fail' } });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.harvest('u1');
      expect(r.embed.data.description).toContain('failed');
    });

    it('handles seed return success', async () => {
      const longAgo = new Date(Date.now() - 7_200_000).toISOString();
      // Wheat returns 1 seed
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ crop_id: 'c1', planted_at: longAgo, watered_at: longAgo })],
        }),
        economy_wallets: () => chainBuilder({ data: { wallet: 1050 } }),
      });
      // rpc succeeds for both addToInventory and addToWallet
      supabase.rpc.mockResolvedValue({ data: null, error: null });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.harvest('u1');
      expect(r.embed.data.title).toBe('🌾 Harvest Complete!');
      // rpc should be called at least twice (addToInventory + addToWallet)
      expect(supabase.rpc.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('warns when seed return fails', async () => {
      const longAgo = new Date(Date.now() - 7_200_000).toISOString();
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ crop_id: 'c1', planted_at: longAgo, watered_at: longAgo })],
        }),
        economy_wallets: () => chainBuilder({ data: { wallet: 1050 } }),
      });
      // First rpc call (addToInventory seeds) fails, second (addToWallet) succeeds
      let rpcCall = 0;
      supabase.rpc.mockImplementation(async () => {
        rpcCall++;
        if (rpcCall === 1) return { data: null, error: { message: 'inv fail' } };
        return { data: null, error: null };
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.harvest('u1');
      expect(r.embed.data.description).toContain('Failed to return');
    });
  });

  // ── fertilize ───────────────────────────────────────────

  describe('fertilize', () => {
    it('returns disabled msg', async () => {
      supabase = makeSupabase({
        guild_config: () => chainBuilder({ data: { ...defaultConfig, economy_farming_enabled: false } }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.fertilize('u1', 1);
      expect(r.embed.data.description).toContain('not enabled');
    });

    it('rejects invalid plot (too low)', async () => {
      const r = await fm.fertilize('u1', 0);
      expect(r.embed.data.description).toContain('Invalid plot');
    });

    it('rejects invalid plot (too high)', async () => {
      const r = await fm.fertilize('u1', 100);
      expect(r.embed.data.description).toContain('Invalid plot');
    });

    it('fails when plot empty', async () => {
      const r = await fm.fertilize('u1', 1);
      expect(r.embed.data.description).toContain('empty');
    });

    it('fails when already fertilized', async () => {
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ plot_index: 0, crop_id: 'c1', planted_at: new Date().toISOString(), fertilized: true })],
        }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.fertilize('u1', 1);
      expect(r.embed.data.description).toContain('already fertilized');
    });

    it('fails when no fertilizer in inventory', async () => {
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ plot_index: 0, crop_id: 'c1', planted_at: new Date().toISOString() })],
        }),
        // inventory returns empty array (no items)
        economy_inventory: () => chainBuilder({ data: [] }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.fertilize('u1', 1);
      expect(r.embed.data.description).toContain("don't have any");
    });

    it('fails when no fertilizer item found', async () => {
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ plot_index: 0, crop_id: 'c1', planted_at: new Date().toISOString() })],
        }),
        economy_inventory: () => chainBuilder({ data: null }),
      });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.fertilize('u1', 1);
      expect(r.embed.data.description).toContain("don't have any");
    });

    it('fertilizes successfully', async () => {
      supabase = makeSupabase({
        economy_farm_plots: () => chainBuilder({
          data: [makePlot({ plot_index: 0, crop_id: 'c1', planted_at: new Date().toISOString() })],
        }),
        economy_inventory: () => chainBuilder({
          data: [{ item_id: 'fert1', economy_items: { name: 'Fertilizer' } }],
        }),
      });
      supabase.rpc.mockResolvedValue({ data: true, error: null });
      fm = new FarmingManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const r = await fm.fertilize('u1', 1);
      expect(r.embed.data.title).toContain('Fertilized');
    });
  });
});
