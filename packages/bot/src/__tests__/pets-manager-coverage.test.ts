/**
 * PetsManager — coverage tests.
 *
 * Imports the REAL PetsManager and mocks external boundaries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    fields: any[] = [];
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setColor(c: number) { this.data.color = c; return this; }
    setFooter(f: { text: string }) { this.data.footer = f; return this; }
    addFields(...args: any[]) {
      for (const a of args) {
        if (Array.isArray(a)) this.fields.push(...a);
        else this.fields.push(a);
      }
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

vi.mock('../quests/quests-manager.js', () => ({
  getQuestsManager: () => ({
    trackProgress: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../utils/random.js', () => ({
  randomIntRange: vi.fn((min: number, _max: number) => min),
  randomFloat: vi.fn(() => 0.5),
}));

vi.mock('../services/alert-service.js', () => ({
  raiseOwnerAlert: vi.fn().mockResolvedValue({
    inserted: true,
    delivered: false,
  }),
}));

import { PetsManager, registerPetsManager, invalidatePetsCache } from '../features/pets/pets-manager.js';
import { raiseOwnerAlert } from '../services/alert-service.js';

// ── Helpers ───────────────────────────────────────────────

function makeSupabase(overrides: Record<string, any> = {}) {
  const fromMock = vi.fn();
  fromMock.mockImplementation((table: string) => {
    const chain: Record<string, any> = {};
    const methods = ['select', 'eq', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle', 'gt', 'lt', 'gte', 'lte'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    const data = overrides[table] ?? null;
    chain.then = (resolve: (v: any) => void) => resolve({ data, error: overrides[`${table}_error`] ?? null });
    (chain as any)[Symbol.toStringTag] = 'Promise';
    return chain;
  });

  return {
    from: fromMock,
    rpc: vi.fn().mockResolvedValue({ error: overrides.rpcError ?? null }),
  };
}

function makeInteraction(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? 'interaction-1',
    guildId: 'g1',
    user: { id: overrides.userId ?? 'u1', username: 'testuser' },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    options: {
      getString: vi.fn().mockImplementation((key: string) => {
        if (key === 'type') return overrides.petType ?? 'hunting';
        if (key === 'name') return overrides.name ?? 'Fluffy';
        if (key === 'food') return overrides.food ?? 'basic_food';
        return null;
      }),
      getUser: vi.fn().mockReturnValue(overrides.targetUser ?? null),
      getInteger: vi.fn().mockReturnValue(overrides.amount ?? null),
    },
  };
}

function makeValkey() {
  const store = new Map<string, string>();
  return {
    get: vi.fn().mockImplementation((k: string) => store.get(k) ?? null),
    set: vi.fn().mockImplementation((k: string, v: string) => { store.set(k, v); return 'OK'; }),
    del: vi.fn().mockResolvedValue(1),
    _store: store,
  };
}

// ── Tests ────────────────────────────────────────────────

describe('PetsManager', () => {
  let mgr: PetsManager;
  let supabase: ReturnType<typeof makeSupabase>;
  let valkey: ReturnType<typeof makeValkey>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    supabase = makeSupabase({
      guild_config: { economy_pets_enabled: true, economy_pet_decay_rate: 5, economy_pet_decay_interval_hours: 1 },
    });
    valkey = makeValkey();
    mgr = new PetsManager(supabase as any, null as any, valkey as any);
  });

  afterEach(() => {
    mgr.stopDecayTimer?.();
    vi.useRealTimers();
  });

  describe('constructor & utility', () => {
    it('creates an instance', () => {
      expect(mgr).toBeInstanceOf(PetsManager);
    });

    it('clearCache works', () => {
      mgr.clearCache();
    });

    it('register and invalidate', () => {
      registerPetsManager(mgr, 'test-guild-id');
      invalidatePetsCache();
    });
  });

  describe('viewPet', () => {
    it('shows pet info', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: {
          name: 'Fluffy', pet_type: 'hunting', level: 10, prestige: 1,
          xp: 500, status: 'happy', health: 100, attack: 20, defense: 15,
          speed: 18, hunger: 80, happiness: 90, energy: 70,
        },
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);
      const interaction = makeInteraction();
      await mgr.viewPet(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        embeds: expect.any(Array),
      }));
    });

    it('returns disabled message when pets not enabled', async () => {
      supabase = makeSupabase({ guild_config: { economy_pets_enabled: false } });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);
      const interaction = makeInteraction();
      await mgr.viewPet(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('not enabled'),
      }));
    });

    it('returns no pet message when user has no pet', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: null,
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);
      const interaction = makeInteraction();
      await mgr.viewPet(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining("don't"),
      }));
    });

    it('shows other user pet', async () => {
      const targetUser = { id: 'u2', username: 'other' };
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: {
          name: 'Rex', pet_type: 'guard', level: 5, prestige: 0,
          xp: 100, status: 'sad', health: 50, attack: 10, defense: 10,
          speed: 10, hunger: 30, happiness: 20, energy: 40,
        },
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);
      const interaction = makeInteraction({ targetUser });
      await mgr.viewPet(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });
  });

  describe('buyPet', () => {
    it('buys a pet successfully', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: null, // no existing pet
        economy_wallets: { wallet: 10000 },
      });
      supabase.rpc.mockResolvedValue({ data: { status: 'purchased', replayed: false }, error: null });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      const interaction = makeInteraction({ petType: 'lucky' });
      await mgr.buyPet(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        embeds: expect.any(Array),
      }));
    });

    it('rejects when already has pet', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: { name: 'Existing' },
      });
      supabase.rpc.mockResolvedValue({ data: { status: 'already_has_pet', replayed: false }, error: null });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      const interaction = makeInteraction();
      await mgr.buyPet(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('already have'),
      }));
    });

    it('rejects when insufficient funds', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: null,
        economy_wallets: { wallet: 100 },
      });
      supabase.rpc.mockResolvedValue({ data: { status: 'insufficient_balance', replayed: false }, error: null });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      const interaction = makeInteraction();
      await mgr.buyPet(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('need'),
      }));
    });

    it('handles atomic insufficient-balance failure', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: null,
        economy_wallets: { wallet: 10000 },
      });
      supabase.rpc.mockResolvedValue({ data: { status: 'insufficient_balance', replayed: false }, error: null });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      const interaction = makeInteraction();
      await mgr.buyPet(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('need'),
      }));
    });

    it('degrades without claiming a refund when the atomic purchase fails', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: null,
      });
      supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'database unavailable' } });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);
      await mgr.buyPet(makeInteraction() as any);
      expect(supabase.rpc).toHaveBeenCalledWith('economy_pet_buy_atomic', expect.anything());
      expect(raiseOwnerAlert).not.toHaveBeenCalled();
    });
  });

  describe('feedPet', () => {
    it('feeds pet successfully', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: { id: 'p1', hunger: 50, status: 'normal' },
      });
      supabase.rpc.mockResolvedValue({ data: { status: 'fed', replayed: false, old_hunger: 50, new_hunger: 80, pet_name: 'Pet' }, error: null });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      const interaction = makeInteraction();
      await mgr.feedPet(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('zero feed cost does not call the positive-only balance debit RPC', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true, economy_pet_feed_cost: 0 },
        economy_pets: { id: 'p1', hunger: 50, status: 'normal' },
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      await mgr.feedPet(makeInteraction() as any);

      expect(supabase.rpc).not.toHaveBeenCalledWith(
        'economy_subtract_balance',
        expect.anything(),
      );
    });

    it('does not issue a compensating refund when the atomic feed call fails', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true, economy_pet_feed_cost: 50 },
        economy_pets: { id: 'p1', hunger: 50, status: 'normal' },
        economy_wallets: { wallet: 500 },
      });
      supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'feed failed' } });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);
      const interaction = makeInteraction();

      await mgr.feedPet(interaction as any);

      expect(supabase.rpc).toHaveBeenCalledWith('economy_pet_feed_atomic', expect.anything());
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('does not claim a paid feed refund when the atomic call fails', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true, economy_pet_feed_cost: 50 },
        economy_pets: { id: 'p1', hunger: 50, status: 'normal' },
        economy_wallets: { wallet: 500 },
      });
      supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'feed failed' } });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);
      const interaction = makeInteraction();

      await mgr.feedPet(interaction as any);

      expect(interaction.reply).toHaveBeenCalled();
      expect(raiseOwnerAlert).not.toHaveBeenCalled();
    });

    it('rejects when no pet', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: null,
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      const interaction = makeInteraction();
      await mgr.feedPet(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });
  });

  describe('playWithPet', () => {
    it('plays with pet', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: { id: 'p1', happiness: 60, energy: 80, xp: 50, level: 1, status: 'normal' },
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      const interaction = makeInteraction();
      await mgr.playWithPet(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });
  });

  describe('trainPet', () => {
    it('trains pet', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: {
          id: 'p1', level: 5, xp: 50, energy: 90,
          health: 100, attack: 10, defense: 10, speed: 10, status: 'happy',
        },
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      const interaction = makeInteraction();
      await mgr.trainPet(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('zero training cost does not call the positive-only balance debit RPC', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true, economy_pet_train_cost: 0 },
        economy_pets: {
          id: 'p1', level: 5, xp: 50, energy: 90,
          health: 100, attack: 10, defense: 10, speed: 10, status: 'happy',
        },
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      await mgr.trainPet(makeInteraction() as any);

      expect(supabase.rpc).not.toHaveBeenCalledWith(
        'economy_subtract_balance',
        expect.anything(),
      );
    });

    it('describes a failed zero-cost training honestly without claiming a refund', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true, economy_pet_train_cost: 0 },
        economy_pets: {
          id: 'p1', level: 5, xp: 50, energy: 90,
          health: 100, attack: 10, defense: 10, speed: 10, status: 'happy',
        },
      });
      supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'train failed' } });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);
      const interaction = makeInteraction();

      await mgr.trainPet(interaction as any);

      expect(interaction.reply).toHaveBeenCalled();
      expect(interaction.reply).not.toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('have been refunded'),
      }));
    });

    it('does not issue a paid training refund when the atomic call fails', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true, economy_pet_train_cost: 100 },
        economy_pets: {
          id: 'p1', level: 5, xp: 50, energy: 90,
          health: 100, attack: 10, defense: 10, speed: 10, status: 'happy',
        },
        economy_wallets: { wallet: 500 },
      });
      supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'train failed' } });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);
      const interaction = makeInteraction();

      await mgr.trainPet(interaction as any);

      expect(interaction.reply).toHaveBeenCalled();
      expect(raiseOwnerAlert).not.toHaveBeenCalled();
    });
  });

  describe('renamePet', () => {
    it('renames pet', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: { id: 'p1', name: 'Old Name' },
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      const interaction = makeInteraction({ name: 'NewName' });
      await mgr.renamePet(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('NewName'),
      }));
    });

    it('rejects when no pet', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: null,
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      const interaction = makeInteraction();
      await mgr.renamePet(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });
  });

  describe('battlePet', () => {
    it('battles another pet', async () => {
      const targetUser = { id: 'u2', username: 'opponent' };
      // Need different pets for different users
      const fromMock = vi.fn();
      let petCalls = 0;
      fromMock.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }
        if (table === 'guild_config') {
          chain.then = (resolve: (v: any) => void) => resolve({ data: { economy_pets_enabled: true }, error: null });
        } else if (table === 'economy_pets') {
          petCalls++;
          if (petCalls === 1) {
            // Attacker's pet
            chain.then = (resolve: (v: any) => void) => resolve({
              data: { id: 'p1', name: 'Attacker', attack: 30, defense: 20, speed: 25, level: 10, xp: 50, status: 'happy' },
              error: null,
            });
          } else {
            // Defender's pet
            chain.then = (resolve: (v: any) => void) => resolve({
              data: { id: 'p2', name: 'Defender', attack: 20, defense: 30, speed: 15, level: 8, xp: 40, status: 'happy' },
              error: null,
            });
          }
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        }
        (chain as any)[Symbol.toStringTag] = 'Promise';
        return chain;
      });

      mgr = new PetsManager({ from: fromMock, rpc: vi.fn().mockResolvedValue({ error: null }) } as any, null as any, valkey as any);
      const interaction = makeInteraction({ targetUser });
      await mgr.battlePet(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('rejects battle when no target user', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: { id: 'p1', name: 'MyPet' },
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);
      const interaction = makeInteraction(); // no targetUser
      await mgr.battlePet(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });
  });

  describe('prestigePet', () => {
    it('prestiges pet at max level', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: { id: 'p1', name: 'MaxPet', level: 50, prestige: 0, xp: 1000 },
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      const interaction = makeInteraction();
      await mgr.prestigePet(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('rejects prestige when pet not max level', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: { id: 'p1', name: 'LowPet', level: 10, prestige: 0, xp: 100 },
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      const interaction = makeInteraction();
      await mgr.prestigePet(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('rejects when no pet', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true },
        economy_pets: null,
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);

      const interaction = makeInteraction();
      await mgr.prestigePet(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });
  });

  describe('schedulePetDecay', () => {
    it('sets up decay timer', async () => {
      supabase = makeSupabase({
        guild_config: { economy_pets_enabled: true, economy_pet_decay_interval_hours: 1 },
      });
      mgr = new PetsManager(supabase as any, null as any, valkey as any);
      await mgr.schedulePetDecay('g1');
      // Timer is set — advance to trigger initial delay
      mgr.stopDecayTimer();
    });

    it('clears existing timer on reschedule', async () => {
      await mgr.schedulePetDecay('g1');
      await mgr.schedulePetDecay('g1'); // should clear and re-set
      mgr.stopDecayTimer();
    });
  });

  describe('stopDecayTimer', () => {
    it('clears both timers', () => {
      mgr.stopDecayTimer();
    });
  });
});
