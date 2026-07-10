/**
 * heist-manager — coverage tests
 *
 * Tests HeistManager class with REAL imports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
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

import {
  HeistManager,
  registerHeistManager,
  invalidateHeistCache,
  getHeistManager,
} from '../features/heist/heist-manager.js';

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
    vi.clearAllMocks();
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
        expect.objectContaining({ content: expect.stringContaining('coins to start') }),
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
      supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'fail' } });
      const interaction = makeInteraction();
      await mgr.startHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Payment failed') }),
      );
    });

    it('handles heist insert unique violation (concurrent start)', async () => {
      let heistCallCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          heistCallCount++;
          if (heistCallCount <= 2) return chainBuilder({ data: null, error: null }); // no recent/active
          // Insert fails with unique violation
          return chainBuilder({ data: null, error: { code: '23505', message: 'dup' } });
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 500 }, error: null });
        }
        return chainBuilder();
      });
      supabase.rpc.mockResolvedValue({ data: null, error: null }); // fee deduct + refund
      const interaction = makeInteraction();
      await mgr.startHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('just started a heist') }),
      );
    });

    it('starts heist successfully', async () => {
      let heistCallCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          heistCallCount++;
          if (heistCallCount <= 2) return chainBuilder({ data: null, error: null }); // no recent/active
          // Insert success
          return chainBuilder({
            data: { id: 'h1', success_chance: 40, target_name: 'Corner Store', target_payout: 250 },
            error: null,
          });
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 500 }, error: null });
        }
        if (table === 'economy_heist_participants') {
          return chainBuilder({ data: null, error: null }); // insert participant
        }
        return chainBuilder();
      });
      supabase.rpc.mockResolvedValue({ data: null, error: null });
      const interaction = makeInteraction();
      await mgr.startHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array) }),
      );
    });
  });

  describe('joinHeist', () => {
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

    it('rejects when already joined', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({
            data: { id: 'h1', participants: ['u1'], success_chance: 40, target_name: 'Bank' },
            error: null,
          });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already in') }),
      );
    });

    it('rejects when crew is full', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({
            data: { ...defaultConfig, economy_heist_max_participants: 2 },
            error: null,
          });
        }
        if (table === 'economy_heists') {
          return chainBuilder({
            data: { id: 'h1', participants: ['u2', 'u3'], success_chance: 47, target_name: 'Bank' },
            error: null,
          });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('full') }),
      );
    });

    it('joins heist successfully', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({
            data: { id: 'h1', participants: ['u2'], success_chance: 40, target_name: 'Corner Store' },
            error: null,
          });
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 500 }, error: null });
        }
        if (table === 'economy_heist_participants') {
          const c = chainBuilder({ data: null, error: null });
          // For select count
          (c as any).count = 2;
          return c;
        }
        return chainBuilder();
      });
      supabase.rpc.mockResolvedValue({ data: null, error: null });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array) }),
      );
    });

    it('rejects insufficient balance for join', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({
            data: { id: 'h1', participants: ['u2'], success_chance: 40, target_name: 'Bank' },
            error: null,
          });
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 5 }, error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('coins to join') }),
      );
    });

    it('refunds a join that raced past the atomic claim (missed join)', async () => {
      // The join reads the heist as recruiting, charges the fee and inserts the
      // participant — but resolution froze the crew before the insert committed.
      // heist_settle_missed_join deletes the stranded row AND refunds the entry
      // fee atomically, returning 'refunded' only once the credit has committed;
      // the join path must confirm the refund and tell the user recruiting closed
      // instead of announcing a false "Joined".
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({
            data: { id: 'h1', participants: ['u2'], success_chance: 40, target_name: 'Corner Store' },
            error: null,
          });
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 500 }, error: null });
        }
        return chainBuilder();
      });
      const rpcCalls: Array<{ fn: string; args: any }> = [];
      supabase.rpc.mockImplementation((fn: string, args: any) => {
        rpcCalls.push({ fn, args });
        if (fn === 'heist_settle_missed_join') return Promise.resolve({ data: 'refunded', error: null });
        return Promise.resolve({ data: null, error: null });
      });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);

      // Refund happens INSIDE the RPC (atomic with the delete) — the bot must
      // pass the fee to settle, and must NOT issue a separate economy_add_balance
      // that could land without the delete (or vice versa).
      expect(rpcCalls).toContainEqual({
        fn: 'heist_settle_missed_join',
        args: expect.objectContaining({ p_heist_id: 'h1', p_user_id: 'u1', p_refund_amount: 100 }),
      });
      expect(supabase.rpc).not.toHaveBeenCalledWith(
        'economy_add_balance', expect.anything(),
      );
      // User told recruiting already closed; no "Joined" embed.
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already got underway') }),
      );
      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      expect(replyArg.embeds).toBeUndefined();
      expect(replyArg.content).toContain('refunded');
    });

    it('retries the missed-join refund and confirms once it commits', async () => {
      // The atomic delete+refund RPC errors transiently, then succeeds. The bot
      // must retry inline (the RPC is idempotent) and only confirm the refund
      // after it actually commits.
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({
            data: { id: 'h1', participants: ['u2'], success_chance: 40, target_name: 'Corner Store' },
            error: null,
          });
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 500 }, error: null });
        }
        return chainBuilder();
      });
      let attempts = 0;
      supabase.rpc.mockImplementation((fn: string) => {
        if (fn === 'heist_settle_missed_join') {
          attempts++;
          if (attempts === 1) return Promise.resolve({ data: null, error: { message: 'transient' } });
          return Promise.resolve({ data: 'refunded', error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);

      expect(attempts).toBe(2); // one failure, one success
      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      expect(replyArg.content).toContain('was refunded');
      expect(replyArg.embeds).toBeUndefined();
    });

    it('does not confirm a refund when both settle and undo keep erroring', async () => {
      // If heist_settle_missed_join errors on every attempt, its transaction
      // rolled back — the stranded row is NOT deleted and no credit landed. The
      // bot then tries heist_undo_join to roll the join back; if THAT also errors
      // on every attempt, the bot must NOT tell the user their fee was refunded
      // (the earlier bug did) — a false confirmation. It surfaces the honest
      // "contact an admin" message instead.
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({
            data: { id: 'h1', participants: ['u2'], success_chance: 40, target_name: 'Corner Store' },
            error: null,
          });
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 500 }, error: null });
        }
        return chainBuilder();
      });
      let settleAttempts = 0;
      let undoAttempts = 0;
      supabase.rpc.mockImplementation((fn: string) => {
        if (fn === 'heist_settle_missed_join') {
          settleAttempts++;
          return Promise.resolve({ data: null, error: { message: 'refund tx failed' } });
        }
        if (fn === 'heist_undo_join') {
          undoAttempts++;
          return Promise.resolve({ data: null, error: { message: 'undo tx failed' } });
        }
        return Promise.resolve({ data: null, error: null });
      });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);

      expect(settleAttempts).toBeGreaterThan(1); // settle retried, not a single shot
      expect(undoAttempts).toBeGreaterThan(1);   // undo also retried before giving up
      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      // Must NOT falsely claim the fee was refunded.
      expect(replyArg.content).not.toContain('was refunded');
      // Must not confirm a refund at all, and must not send a "Joined" embed.
      expect(replyArg.content).not.toContain('Your entry fee was refunded');
      expect(replyArg.content).toContain('contact a server admin');
      expect(replyArg.embeds).toBeUndefined();
    });

    it('undoes a still-recruiting join when settle keeps erroring transiently (codex :491)', async () => {
      // The heist is still recruiting (the crew was never frozen), but
      // heist_settle_missed_join errors on every attempt — a pure transient blip.
      // Leaving the member joined would let a later claim FREEZE and settle them as
      // crew even though we are about to tell them they did not join. The bot must
      // instead UNDO the join: heist_undo_join refunds the frozen fee, deletes the
      // row, drops the participants[] slot and reverses the +7 success bump, all
      // atomically. The user is told their join was cancelled and the fee refunded
      // — never a false "Joined" embed and never a half-committed state.
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({
            data: { id: 'h1', participants: ['u2'], success_chance: 40, target_name: 'Corner Store' },
            error: null,
          });
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 500 }, error: null });
        }
        return chainBuilder();
      });
      const rpcCalls: Array<{ fn: string; args: any }> = [];
      supabase.rpc.mockImplementation((fn: string, args: any) => {
        rpcCalls.push({ fn, args });
        if (fn === 'heist_settle_missed_join') {
          return Promise.resolve({ data: null, error: { message: 'transient' } });
        }
        if (fn === 'heist_undo_join') {
          // Undo succeeds: the join is rolled back and the frozen fee refunded
          // inside the RPC transaction.
          return Promise.resolve({ data: 'undone', error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);

      // Undo was invoked with the frozen fee, atomically (no separate credit).
      expect(rpcCalls).toContainEqual({
        fn: 'heist_undo_join',
        args: expect.objectContaining({ p_heist_id: 'h1', p_user_id: 'u1', p_refund_amount: 100 }),
      });
      expect(supabase.rpc).not.toHaveBeenCalledWith('economy_add_balance', expect.anything());
      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      // No "Joined" embed; told the join was cancelled and the fee refunded.
      expect(replyArg.embeds).toBeUndefined();
      expect(replyArg.content).toContain('refunded');
      expect(replyArg.content).not.toContain('contact a server admin');
    });

    it('does not refund a join that made it into the frozen crew', async () => {
      // heist_settle_missed_join returns 'in_crew' — the participant is stamped
      // into the frozen crew. The normal "Joined" flow runs.
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({
            data: { id: 'h1', participants: ['u2'], success_chance: 40, target_name: 'Corner Store' },
            error: null,
          });
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 500 }, error: null });
        }
        if (table === 'economy_heist_participants') {
          const c = chainBuilder({ data: null, error: null });
          (c as any).count = 2;
          return c;
        }
        return chainBuilder();
      });
      supabase.rpc.mockImplementation((fn: string) => {
        if (fn === 'heist_settle_missed_join') return Promise.resolve({ data: 'in_crew', error: null });
        return Promise.resolve({ data: null, error: null });
      });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);

      // No refund; normal "Joined" embed sent.
      expect(supabase.rpc).not.toHaveBeenCalledWith(
        'economy_add_balance', expect.anything(),
      );
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array) }),
      );
    });

    it('does not announce "Joined" when a racing resolver already reconciled the join', async () => {
      // Codex :482 — the resolver's bulk heist_reconcile_stranded_joins won the
      // race and already deleted + refunded this just-inserted row, so
      // heist_settle_missed_join finds no row and returns 'reconciled'. The old
      // boolean=false collapsed this into the "still in crew" path and the command
      // mis-announced "Joined the Heist!" to an already-refunded, removed user.
      // The command must instead tell the user recruiting closed and their fee is
      // back — never a "Joined" embed.
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { ...defaultConfig }, error: null });
        }
        if (table === 'economy_heists') {
          return chainBuilder({
            data: { id: 'h1', participants: ['u2'], success_chance: 40, target_name: 'Corner Store' },
            error: null,
          });
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 500 }, error: null });
        }
        return chainBuilder();
      });
      supabase.rpc.mockImplementation((fn: string) => {
        if (fn === 'heist_settle_missed_join') return Promise.resolve({ data: 'reconciled', error: null });
        return Promise.resolve({ data: null, error: null });
      });
      const interaction = makeInteraction();
      await mgr.joinHeist(interaction as any);

      const replyArg = (interaction.reply as any).mock.calls.at(-1)[0];
      // Must NOT send a "Joined the Heist!" embed to a reconciled/removed user.
      expect(replyArg.embeds).toBeUndefined();
      expect(replyArg.content).toContain('already got underway');
      expect(replyArg.content).toContain('refunded');
      // The reconcile already refunded — the command issues no separate credit.
      expect(supabase.rpc).not.toHaveBeenCalledWith(
        'economy_add_balance', expect.anything(),
      );
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

    it('shows last completed heist when no active', async () => {
      let callCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_heists') {
          callCount++;
          if (callCount === 1) return chainBuilder({ data: null, error: null }); // no active
          return chainBuilder({
            data: {
              id: 'h1', target_name: 'Bank', status: 'success',
              participants: ['u1', 'u2'], target_payout: 500,
              resolved_at: new Date().toISOString(),
            },
            error: null,
          });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.viewHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('shows active heist', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_heists') {
          return chainBuilder({
            data: {
              id: 'h1', target_name: 'Museum', status: 'recruiting',
              participants: ['u1', 'u2'], success_chance: 47,
              target_payout: 750,
              expires_at: new Date(Date.now() + 30000).toISOString(),
            },
            error: null,
          });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.viewHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array) }),
      );
    });

    it('shows last failed heist', async () => {
      let callCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'economy_heists') {
          callCount++;
          if (callCount === 1) return chainBuilder({ data: null, error: null });
          return chainBuilder({
            data: {
              id: 'h2', target_name: 'Vault', status: 'failed',
              participants: ['u1'], target_payout: 1000,
              resolved_at: new Date().toISOString(),
            },
            error: null,
          });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.viewHeist(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
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
