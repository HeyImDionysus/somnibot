/**
 * heist-manager — coverage tests
 *
 * Tests HeistManager class with REAL imports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../../utils/random.js', () => ({
  randomPick: (arr: unknown[]) => arr[0],
  randomFloat: () => 50, // default: 50% roll
}));
vi.mock('../utils/random.js', () => ({
  randomPick: (arr: unknown[]) => arr[0],
  randomFloat: () => 50,
}));

vi.mock('../../utils/db-helpers.js', () => ({
  hasErrorCode: (e: unknown) => e && typeof e === 'object' && 'code' in e,
}));
vi.mock('../utils/db-helpers.js', () => ({
  hasErrorCode: (e: unknown) => e && typeof e === 'object' && 'code' in e,
}));

const mockTrackProgress = vi.fn().mockResolvedValue(undefined);
vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => ({ trackProgress: mockTrackProgress }),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setColor(c: number) { this.data.color = c; return this; }
    setFooter(f: Record<string, unknown>) { this.data.footer = f; return this; }
  },
}));

vi.mock('../services/alert-service.js', () => ({
  raiseOwnerAlert: vi.fn().mockResolvedValue({ inserted: true, delivered: false }),
}));

import {
  HeistManager,
  registerHeistManager,
  invalidateHeistCache,
  getHeistManager,
} from '../features/heist/heist-manager.js';
import { raiseOwnerAlert } from '../services/alert-service.js';

// ── Helpers ───────────────────────────────────────────────

function chainBuilder(resolveValue: Record<string, unknown> = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'update', 'upsert', 'insert', 'delete', 'order', 'limit']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(resolveValue);
  chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);
  chain.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
    Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

const defaultConfig = {
  economy_heist_enabled: true,
  economy_heist_cooldown_seconds: 300,
  economy_heist_entry_fee: 100,
  economy_heist_base_payout: 500,
  economy_heist_join_window_secs: 60,
  economy_heist_success_base_pct: 40,
  economy_heist_max_participants: 8,
  economy_heist_min_participants: 2,
  economy_log_channel_id: 'ch1',
};

function makeSupabase(tableOverrides: Record<string, () => unknown> = {}) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (tableOverrides[table]) return tableOverrides[table]();
      if (table === 'guild_config') {
        return chainBuilder({ data: { ...defaultConfig }, error: null });
      }
      return chainBuilder();
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
}

function makeValkey() {
  const store = new Map<string, string>();
  return {
    get: vi.fn().mockImplementation((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: vi.fn().mockImplementation((...args: unknown[]) => {
      const [k, v, , , flag] = args as [string, string, string, number, string];
      if (flag === 'NX' && store.has(k as string)) return Promise.resolve(null);
      store.set(k as string, v as string);
      return Promise.resolve('OK');
    }),
    ttl: vi.fn().mockResolvedValue(120),
  };
}

function makeClient() {
  return {
    channels: {
      cache: new Map([['ch1', { send: vi.fn().mockResolvedValue(undefined) }]]),
    },
  };
}

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'interaction-1',
    guildId: 'g1',
    channelId: 'ch1',
    user: { id: 'u1' },
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('module-level helpers', () => {
  it('register / get / invalidate', () => {
    const supabase = makeSupabase();
    const client = makeClient();
    const mgr = new HeistManager(supabase as any, client as any);
    registerHeistManager(mgr, 'test-guild-id');
    expect(getHeistManager()).toBe(mgr);
    invalidateHeistCache();
  });
});

describe('HeistManager', () => {
  let mgr: HeistManager;
  let supabase: ReturnType<typeof makeSupabase>;
  let client: ReturnType<typeof makeClient>;
  let valkey: ReturnType<typeof makeValkey>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockTrackProgress.mockResolvedValue(undefined);
    vi.mocked(raiseOwnerAlert).mockResolvedValue({
      inserted: true,
      delivered: false,
    });
    supabase = makeSupabase();
    client = makeClient();
    valkey = makeValkey();
    mgr = new HeistManager(supabase as any, client as any, valkey as any);
  });

  afterEach(() => {
    mgr.cleanup();
  });

  describe('startHeist', () => {
    it('rejects when heists disabled', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { economy_heist_enabled: false }, error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.startHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('not enabled') }),
      );
    });

    it('rejects on Valkey cooldown', async () => {
      // Pre-set cooldown
      await valkey.set('heist:cd:g1', '1', 'EX', 300, 'NX' as any);
      const interaction = makeInteraction();
      await mgr.startHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('lay low') }),
      );
    });

    it('zero cooldown and entry fee bypass invalid Valkey and debit calls', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({
            data: {
              ...defaultConfig,
              economy_heist_cooldown_seconds: 0,
              economy_heist_entry_fee: 0,
            },
            error: null,
          });
        }
        if (table === 'economy_heists') return chainBuilder({ data: null, error: null });
        if (table === 'economy_wallets') return chainBuilder({ data: null, error: { code: 'PGRST116' } });
        return chainBuilder();
      });
      const interaction = makeInteraction();

      await mgr.startHeist(interaction as any);

      expect(valkey.set).not.toHaveBeenCalledWith('heist:cd:g1', '1', 'EX', 0, 'NX');
      expect(supabase.from).not.toHaveBeenCalledWith('economy_wallets');
      expect(supabase.rpc).not.toHaveBeenCalledWith('economy_subtract_balance', expect.anything());
    });

    it('describes a failed zero-fee start without claiming a refund', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({
            data: {
              ...defaultConfig,
              economy_heist_cooldown_seconds: 0,
              economy_heist_entry_fee: 0,
            },
            error: null,
          });
        }
        if (table === 'economy_heists') return chainBuilder({ data: null, error: null });
        return chainBuilder();
      });
      supabase.rpc.mockImplementation((fn: string) => {
        if (fn === 'heist_start') {
          return Promise.resolve({ data: null, error: { message: 'database unavailable' } });
        }
        return Promise.resolve({ data: null, error: null });
      });
      const interaction = makeInteraction();

      await mgr.startHeist(interaction as any);

      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Nothing was charged'),
      }));
      expect(interaction.reply).not.toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('refunded'),
      }));
      expect(supabase.rpc).not.toHaveBeenCalledWith('economy_refund_balance', expect.anything());
    });

    it('rejects on DB cooldown fallback', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({
            data: { resolved_at: new Date().toISOString() }, // recent
            error: null,
          });
        }
        return chainBuilder();
      });
      // Create without valkey
      const mgrNoValkey = new HeistManager(supabase as any, client as any);
      const interaction = makeInteraction();
      await mgrNoValkey.startHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('lay low') }),
      );
      mgrNoValkey.cleanup();
    });

    it('rejects when active heist exists', async () => {
      let heistCallCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          heistCallCount++;
          if (heistCallCount === 1) return chainBuilder({ data: null, error: null }); // no recent
          if (heistCallCount === 2) return chainBuilder({ data: { id: 'h1' }, error: null }); // active!
          return chainBuilder();
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.startHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already an active heist') }),
      );
    });

    it('rejects insufficient balance', async () => {
      let heistCallCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          heistCallCount++;
          return chainBuilder({ data: null, error: null }); // no recent, no active
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 10 }, error: null }); // too low
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.startHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringMatching(/coins to start/i) }),
      );
    });

    it('rejects when fee deduction fails', async () => {
      let heistCallCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          heistCallCount++;
          return chainBuilder({ data: null, error: null });
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 500 }, error: null });
        }
        return chainBuilder();
      });
      // A GENERIC (network/transient) RPC failure debited nothing — it must not
      // fabricate a balance verdict; it degrades honestly and says so.
      supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'fail' } });
      const interaction = makeInteraction();
      await mgr.startHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('temporarily unavailable'),
        }),
      );
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Nothing was charged') }),
      );
    });

    it('reports a genuine insufficient-balance raise as a payment failure', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') return chainBuilder({ data: { ...defaultConfig }, error: null });
        if (table === 'economy_heists') return chainBuilder({ data: null, error: null });
        if (table === 'economy_wallets') return chainBuilder({ data: { wallet: 500 }, error: null });
        return chainBuilder();
      });
      // The atomic debit RPC RAISES on insufficient balance — the one error that
      // may legitimately tell the member they lack coins.
      supabase.rpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'insufficient balance for this operation' },
      });
      const interaction = makeInteraction();
      await mgr.startHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Payment failed') }),
      );
    });

    it('handles concurrent-start rejection from heist_start (duplicate_active)', async () => {
      // Row-derived-crew: startHeist creates the heist + initiator row atomically
      // via the heist_start RPC. A concurrent start loses the unique-active-heist
      // index race, so heist_start returns status='duplicate_active' (the whole tx
      // rolled back — nothing half-inserted). The bot refunds and surfaces the
      // "just started a heist" reply.
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({ data: null, error: null }); // no recent/active
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 500 }, error: null });
        }
        return chainBuilder();
      });
      supabase.rpc.mockImplementation((fn: string) => {
        if (fn === 'heist_start') {
          return Promise.resolve({ data: [{ status: 'duplicate_active', heist_id: null }], error: null });
        }
        return Promise.resolve({ data: null, error: null }); // fee deduct + refund
      });
      const interaction = makeInteraction();
      await mgr.startHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('just started a heist') }),
      );
      // No separate participant insert — the initiator row is inserted inside the
      // atomic RPC, not a second statement.
      expect(
        supabase.from.mock.calls.some((c: any[]) => c[0] === 'economy_heist_participants'),
      ).toBe(false);
      expect(supabase.rpc).toHaveBeenCalledWith('economy_refund_balance', {
        p_guild_id: 'g1',
        p_user_id: 'u1',
        p_amount: 100,
        p_idempotency_key: 'heist:start-refund:interaction-1',
      });
    });

    it('raises an owner alert when a positive-fee start refund fails', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') return chainBuilder({ data: { ...defaultConfig }, error: null });
        if (table === 'economy_heists') return chainBuilder({ data: null, error: null });
        if (table === 'economy_wallets') return chainBuilder({ data: { wallet: 500 }, error: null });
        return chainBuilder();
      });
      supabase.rpc.mockImplementation((fn: string) => {
        if (fn === 'economy_subtract_balance') {
          return Promise.resolve({ data: null, error: null });
        }
        if (fn === 'heist_start') {
          return Promise.resolve({ data: null, error: { message: 'create failed' } });
        }
        if (fn === 'economy_refund_balance') {
          return Promise.resolve({ data: null, error: { message: 'refund failed' } });
        }
        return Promise.resolve({ data: null, error: null });
      });
      const interaction = makeInteraction();

      await mgr.startHeist(interaction as any);

      expect(raiseOwnerAlert).toHaveBeenCalledWith(
        supabase,
        'g1',
        expect.objectContaining({ alertType: 'heist_entry_fee_refund_failed' }),
      );
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('administrator was notified'),
      }));
    });

    it('does not claim an administrator notification when every alert leg fails', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') return chainBuilder({ data: { ...defaultConfig }, error: null });
        if (table === 'economy_heists') return chainBuilder({ data: null, error: null });
        if (table === 'economy_wallets') return chainBuilder({ data: { wallet: 500 }, error: null });
        return chainBuilder();
      });
      supabase.rpc.mockImplementation((fn: string) => {
        if (fn === 'economy_subtract_balance') {
          return Promise.resolve({ data: null, error: null });
        }
        if (fn === 'heist_start') {
          return Promise.resolve({ data: null, error: { message: 'create failed' } });
        }
        if (fn === 'economy_refund_balance') {
          return Promise.resolve({ data: null, error: { message: 'refund failed' } });
        }
        return Promise.resolve({ data: null, error: null });
      });
      vi.mocked(raiseOwnerAlert).mockResolvedValueOnce({
        inserted: false,
        delivered: false,
      });
      const interaction = makeInteraction();

      await mgr.startHeist(interaction as any);

      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('administrator notification could not be confirmed'),
      }));
    });

    it('starts heist successfully via the atomic heist_start RPC', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({ data: null, error: null }); // no recent/active
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 500 }, error: null });
        }
        return chainBuilder();
      });
      // heist_start returns 'started' with the new heist id; the initiator
      // participant row is inserted inside the SAME transaction (no second insert).
      supabase.rpc.mockImplementation((fn: string) => {
        if (fn === 'heist_start') {
          return Promise.resolve({ data: [{ status: 'started', heist_id: 'h1' }], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
      const interaction = makeInteraction();
      await mgr.startHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array) }),
      );
      // The initiator row is NOT a separate table insert — the atomic RPC owns it.
      expect(
        supabase.from.mock.calls.some((c: any[]) => c[0] === 'economy_heist_participants'),
      ).toBe(false);
      expect(
        supabase.rpc.mock.calls.some((c: any[]) => c[0] === 'heist_start'),
      ).toBe(true);
    });
  });

  describe('joinHeist', () => {
    // Helper: the /heist join path now delegates the ENTIRE join to one atomic
    // heist_join RPC. Set up the recruiting-heist read + the heist_join result.
    function setupJoin(joinResult: unknown, opts: { configOverrides?: Record<string, unknown> } = {}) {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig, ...opts.configOverrides }, error: null });
        }
        if (table === 'economy_heists') {
          // The recruiting-heist read used only for target_name + a fast "no heist"
          // UX check. It no longer carries participants[] or a success_chance
          // counter — the join RPC derives count + chance from the rows.
          return chainBuilder({
            data: { id: 'h1', base_success_chance: 40, target_name: 'Corner Store' },
            error: null,
          });
        }
        return chainBuilder();
      });
      const rpcCalls: Array<{ fn: string; args: any }> = [];
      supabase.rpc.mockImplementation((fn: string, args: any) => {
        rpcCalls.push({ fn, args });
        if (fn === 'heist_join') return Promise.resolve(joinResult);
        return Promise.resolve({ data: null, error: null });
      });
      return rpcCalls;
    }

    it('rejects when heists disabled', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { economy_heist_enabled: false }, error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('not enabled') }),
      );
    });

    it('rejects when no recruiting heist', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({ data: null, error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('No heist') }),
      );
    });

    it('joins atomically via heist_join and announces the derived crew/chance', async () => {
      // The happy path: heist_join returns 'joined' with the post-join member
      // count and DERIVED success_chance (base 40 + (3-1)*7 = 54). The command
      // renders those directly from the RPC result — no separate debit/insert/
      // append/settle calls.
      const rpcCalls = setupJoin({
        data: [{ status: 'joined', member_count: 3, success_chance: 54, role: 'Hacker' }],
        error: null,
      });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);

      // The whole join is one atomic RPC — no legacy debit / append / settle.
      expect(rpcCalls.some((c) => c.fn === 'heist_join')).toBe(true);
      expect(rpcCalls.some((c) => c.fn === 'economy_subtract_balance')).toBe(false);
      expect(rpcCalls.some((c) => c.fn === 'array_append_heist_participant')).toBe(false);
      expect(rpcCalls.some((c) => c.fn === 'heist_settle_missed_join')).toBe(false);
      // heist_join was passed the derived-chance anchor (base + difficulty) and role.
      expect(rpcCalls).toContainEqual({
        fn: 'heist_join',
        args: expect.objectContaining({
          p_heist_id: 'h1', p_user_id: 'u1', p_entry_fee: 100,
          p_max: 8, p_base_chance: 40, p_role: 'Hacker',
        }),
      });
      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      expect(replyArg.embeds).toBeDefined();
      expect(String(replyArg.embeds[0].data.description)).toContain('3/8');
      expect(String(replyArg.embeds[0].data.description)).toContain('54%');
    });

    it('passes a configured zero fee to the atomic join without a separate debit', async () => {
      const rpcCalls = setupJoin(
        {
          data: [{ status: 'joined', member_count: 2, success_chance: 47, role: 'Hacker' }],
          error: null,
        },
        { configOverrides: { economy_heist_entry_fee: 0 } },
      );

      await mgr.joinHeist(makeInteraction() as any);

      expect(rpcCalls).toContainEqual({
        fn: 'heist_join',
        args: expect.objectContaining({ p_entry_fee: 0 }),
      });
      expect(rpcCalls.some((c) => c.fn === 'economy_subtract_balance')).toBe(false);
    });

    it('rejects when already joined (RPC status already_joined)', async () => {
      setupJoin({ data: [{ status: 'already_joined', member_count: 2, success_chance: 47, role: null }], error: null });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);
      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      expect(replyArg.embeds).toBeUndefined();
      expect(replyArg.content).toContain('already in');
    });

    it('rejects when crew is full (RPC status crew_full)', async () => {
      setupJoin({ data: [{ status: 'crew_full', member_count: 8, success_chance: 89, role: null }], error: null });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);
      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      expect(replyArg.embeds).toBeUndefined();
      expect(replyArg.content).toContain('full');
    });

    it('rejects insufficient balance (RPC status insufficient_funds)', async () => {
      setupJoin({ data: [{ status: 'insufficient_funds', member_count: 1, success_chance: 40, role: null }], error: null });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);
      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      expect(replyArg.embeds).toBeUndefined();
      expect(replyArg.content.toLowerCase()).toContain('coins to join');
    });

    // ── Root serialization fix (codex heist-manager.ts:797) ─────────────────
    it('a join that loses the row lock to resolution is rejected without any charge', async () => {
      // The claim won the heist-row lock first, so heist_join re-checked the
      // status under the lock, saw it was no longer 'recruiting', and returned
      // 'not_recruiting' having debited NOTHING. A post-recruiting insert is
      // structurally impossible — no fee can be stranded, and the command tells the
      // user plainly that nothing was charged (never a false "Joined", never a
      // "we refunded you" for a debit that never happened).
      const rpcCalls = setupJoin({
        data: [{ status: 'not_recruiting', member_count: 2, success_chance: 0, role: null }],
        error: null,
      });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);

      // No separate debit and no refund — the RPC never charged the fee.
      expect(rpcCalls.some((c) => c.fn === 'economy_subtract_balance')).toBe(false);
      expect(rpcCalls.some((c) => c.fn === 'economy_add_balance')).toBe(false);
      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      expect(replyArg.embeds).toBeUndefined();
      expect(replyArg.content).toContain('already got underway');
      expect(replyArg.content.toLowerCase()).toContain('no coins were charged');
    });

    it('surfaces a clean error and confirms no charge when heist_join errors (tx rolled back)', async () => {
      // The RPC transaction errored — debit and insert commit together or not at
      // all, so nothing was charged. The command must not claim a charge or a
      // refund; the user simply retries.
      const rpcCalls = setupJoin({ data: null, error: { message: 'transient' } });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);

      expect(rpcCalls.some((c) => c.fn === 'economy_add_balance')).toBe(false);
      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      expect(replyArg.embeds).toBeUndefined();
      expect(replyArg.content.toLowerCase()).toContain('no coins were charged');
    });
  });

  describe('viewHeist', () => {
    it('shows no-heist message', async () => {
      supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
      const interaction = makeInteraction();
      await mgr.viewHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array) }),
      );
    });

    it('shows last completed heist with crew derived from participant rows', async () => {
      let callCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_heists') {
          callCount++;
          if (callCount === 1) return chainBuilder({ data: null, error: null }); // no active
          return chainBuilder({
            data: {
              id: 'h1', target_name: 'Bank', status: 'success',
              target_payout: 500, resolved_at: new Date().toISOString(),
            },
            error: null,
          });
        }
        if (table === 'economy_heist_participants') {
          // Crew is derived from the rows (single source of truth) — no
          // participants[] array on the heist row anymore.
          return chainBuilder({ data: [{ user_id: 'u1' }, { user_id: 'u2' }], error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.viewHeist(interaction as any);
      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      // Crew mentions come from the participant rows.
      expect(String(replyArg.embeds[0].data.description)).toContain('<@u1>');
      expect(String(replyArg.embeds[0].data.description)).toContain('<@u2>');
    });

    it('shows active heist with crew + chance derived from rows and base_success_chance', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_heists') {
          return chainBuilder({
            data: {
              id: 'h1', target_name: 'Museum', status: 'recruiting',
              // The immutable base anchor; success_chance is derived, not stored.
              base_success_chance: 40,
              target_payout: 750,
              expires_at: new Date(Date.now() + 30000).toISOString(),
            },
            error: null,
          });
        }
        if (table === 'economy_heist_participants') {
          return chainBuilder({ data: [{ user_id: 'u1' }, { user_id: 'u2' }], error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.viewHeist(interaction as any);
      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      // 2-member crew → derived chance = min(95, 40 + (2-1)*7) = 47.
      expect(String(replyArg.embeds[0].data.description)).toContain('47%');
      expect(String(replyArg.embeds[0].data.description)).toContain('<@u1>');
      expect(String(replyArg.embeds[0].data.description)).toContain('<@u2>');
    });

    it('shows last failed heist with crew derived from participant rows', async () => {
      let callCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_heists') {
          callCount++;
          if (callCount === 1) return chainBuilder({ data: null, error: null });
          return chainBuilder({
            data: {
              id: 'h2', target_name: 'Vault', status: 'failed',
              target_payout: 1000, resolved_at: new Date().toISOString(),
            },
            error: null,
          });
        }
        if (table === 'economy_heist_participants') {
          return chainBuilder({ data: [{ user_id: 'u1' }], error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.viewHeist(interaction as any);
      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      expect(String(replyArg.embeds[0].data.description)).toContain('<@u1>');
    });
  });

  describe('resumePendingHeists', () => {
    it('resolves expired heists immediately', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({
            data: [{
              id: 'h1', status: 'recruiting',
              participants: ['u1'],
              expires_at: new Date(Date.now() - 10000).toISOString(), // expired
              success_chance: 40,
            }],
            error: null,
          });
        }
        if (table === 'economy_heist_participants') {
          return chainBuilder({ data: [{ user_id: 'u1' }], error: null });
        }
        return chainBuilder();
      });
      supabase.rpc.mockResolvedValue({ data: null, error: null });
      await mgr.resumePendingHeists('g1');
      // Should resolve immediately (cancel because < minParticipants)
    });

    it('schedules future heists', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({
            data: [{
              id: 'h2', status: 'recruiting',
              participants: ['u1', 'u2'],
              expires_at: new Date(Date.now() + 30000).toISOString(), // 30s from now
              success_chance: 47,
            }],
            error: null,
          });
        }
        return chainBuilder();
      });
      await mgr.resumePendingHeists('g1');
      // Timer should be set
      mgr.cleanup(); // clean up timer
    });

    it('handles no pending heists', async () => {
      supabase.from.mockReturnValue(chainBuilder({ data: [], error: null }));
      await mgr.resumePendingHeists('g1');
      // No error
    });
  });

  describe('cleanup', () => {
    it('clears all timers', () => {
      mgr.cleanup();
      // No error
    });
  });
});
