/**
 * heist-manager — resume idempotency (WAVE 2B)
 *
 * Verifies that heist resolution is atomic and single-shot:
 *  - double-resolve pays out exactly once;
 *  - crash-then-resume does not re-notify or re-charge;
 *  - concurrent resolve attempts collapse to a single payout.
 *
 * The fake Supabase models the DB semantics of the new RPCs
 * (heist_claim_for_resolution / heist_credit_participant /
 * heist_finalize_resolution) as an in-memory state machine, so the
 * assertions reflect the real single-shot / idempotent guards, not a
 * pass-through stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../utils/random.js', () => ({
  randomPick: (arr: unknown[]) => arr[0],
}));
vi.mock('../utils/random.js', () => ({
  randomPick: (arr: unknown[]) => arr[0],
}));
vi.mock('../../utils/db-helpers.js', () => ({
  hasErrorCode: (e: unknown) => !!e && typeof e === 'object' && 'code' in e,
}));
vi.mock('../utils/db-helpers.js', () => ({
  hasErrorCode: (e: unknown) => !!e && typeof e === 'object' && 'code' in e,
}));
vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => ({ trackProgress: vi.fn().mockResolvedValue(undefined) }),
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

import { HeistManager } from '../features/heist/heist-manager.js';

const CONFIG = {
  economy_heist_enabled: true,
  economy_heist_entry_fee: 100,
  economy_heist_min_participants: 2,
  economy_log_channel_id: 'ch1',
};

/**
 * Stateful fake DB. Tracks one heist + its participants, plus the wallet
 * credits applied through economy_add_balance / heist_credit_participant.
 * The three resolution RPCs implement the exact single-shot / idempotent
 * guards the migration enforces under FOR UPDATE.
 */
function makeStatefulDb(opts: {
  status: string;
  resolution?: string | null;
  payoutEach?: number | null;
  participants: string[];
  successChance?: number;
  targetPayout?: number;
}) {
  const heist: any = {
    id: 'h1',
    guild_id: 'g1',
    status: opts.status,
    resolution: opts.resolution ?? null,
    payout_each: opts.payoutEach ?? null,
    target_name: 'Corner Store',
    target_payout: opts.targetPayout ?? 250,
    success_chance: opts.successChance ?? 40,
    participants: [...opts.participants],
    expires_at: new Date(Date.now() - 1000).toISOString(),
  };
  const parts = opts.participants.map((uid) => ({
    heist_id: 'h1', user_id: uid, role: 'Hacker', payout: 0, paid_at: null as string | null, payout_failed: false,
  }));

  // Ledger of every wallet credit that actually landed.
  const credits: Array<{ user_id: string; amount: number }> = [];

  function heistChain() {
    let selecting = false;
    const chain: any = {
      select: () => { selecting = true; return chain; },
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (patch: Record<string, unknown>) => { Object.assign(heist, patch); return chain; },
      single: () => Promise.resolve({ data: selecting ? { ...heist } : null, error: null }),
      maybeSingle: () => Promise.resolve({ data: selecting ? { ...heist } : null, error: null }),
      then: (res: (v: unknown) => void) => Promise.resolve({ data: [{ ...heist }], error: null }).then(res),
    };
    return chain;
  }

  function partsChain() {
    let target: { user_id?: string } = {};
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: string) => { if (col === 'user_id') target.user_id = val; return chain; },
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (patch: Record<string, unknown>) => {
        for (const p of parts) {
          if (target.user_id && p.user_id !== target.user_id) continue;
          Object.assign(p, patch);
        }
        return chain;
      },
      single: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (res: (v: unknown) => void) =>
        Promise.resolve({ data: parts.map((p) => ({ ...p })), error: null }).then(res),
    };
    return chain;
  }

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'guild_config') {
        const c: any = {
          select: () => c, eq: () => c, limit: () => c, order: () => c, in: () => c,
          single: () => Promise.resolve({ data: { ...CONFIG }, error: null }),
          maybeSingle: () => Promise.resolve({ data: { ...CONFIG }, error: null }),
        };
        return c;
      }
      if (table === 'economy_heists') return heistChain();
      if (table === 'economy_heist_participants') return partsChain();
      const g: any = { select: () => g, eq: () => g, limit: () => g, single: () => Promise.resolve({ data: null, error: null }) };
      return g;
    }),
    rpc: vi.fn().mockImplementation((fn: string, args: any) => {
      if (fn === 'heist_claim_for_resolution') {
        // Single-shot: only the caller that observes 'recruiting' claims.
        if (heist.status !== 'recruiting') {
          return Promise.resolve({ data: [{ claimed: false, outcome: null, participant_count: 0, payout_each: null }], error: null });
        }
        const count = parts.length;
        if (count < args.p_min_participants) {
          heist.status = 'cancelled'; heist.resolution = 'cancelled'; heist.resolved_at = new Date().toISOString();
          return Promise.resolve({ data: [{ claimed: true, outcome: 'cancelled', participant_count: count, payout_each: null }], error: null });
        }
        const isSuccess = (heist.success_chance ?? 0) > 0; // deterministic for tests
        if (isSuccess) {
          const each = Math.floor(heist.target_payout / count);
          heist.status = 'in_progress'; heist.resolution = 'success'; heist.payout_each = each;
          return Promise.resolve({ data: [{ claimed: true, outcome: 'success', participant_count: count, payout_each: each }], error: null });
        }
        heist.status = 'in_progress'; heist.resolution = 'failed'; heist.payout_each = 0;
        return Promise.resolve({ data: [{ claimed: true, outcome: 'failed', participant_count: count, payout_each: 0 }], error: null });
      }
      if (fn === 'heist_credit_participant') {
        const p = parts.find((x) => x.user_id === args.p_user_id);
        if (!p || p.paid_at) return Promise.resolve({ data: false, error: null }); // idempotent skip
        if (args.p_amount > 0) credits.push({ user_id: args.p_user_id, amount: args.p_amount });
        p.paid_at = new Date().toISOString(); p.payout = args.p_amount; p.payout_failed = false;
        return Promise.resolve({ data: true, error: null });
      }
      if (fn === 'heist_finalize_resolution') {
        if (heist.status !== 'in_progress') return Promise.resolve({ data: false, error: null });
        heist.status = heist.resolution ?? 'failed'; heist.resolved_at = new Date().toISOString();
        return Promise.resolve({ data: true, error: null });
      }
      if (fn === 'economy_add_balance') {
        credits.push({ user_id: args.p_user_id, amount: args.p_amount });
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }),
  };

  return { supabase, heist, parts, credits };
}

function makeClient() {
  const send = vi.fn().mockResolvedValue(undefined);
  return {
    send,
    client: { channels: { cache: new Map([['ch1', { send }]]) } },
  };
}

/** Invoke the private resolveHeist directly to exercise resolution paths. */
function resolve(mgr: HeistManager) {
  return (mgr as unknown as {
    resolveHeist(g: string, h: string, c: string): Promise<void>;
  }).resolveHeist('g1', 'h1', 'ch1');
}

describe('heist resume idempotency', () => {
  beforeEach(() => vi.clearAllMocks());

  it('double-resolve pays out exactly once (success)', async () => {
    const db = makeStatefulDb({ status: 'recruiting', participants: ['u1', 'u2'], successChance: 100, targetPayout: 250 });
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr); // first resolution claims + pays + finalises
    await resolve(mgr); // second resolution must be a no-op

    expect(db.heist.status).toBe('success');
    // Each of the two crew members credited exactly once (125 each).
    expect(db.credits).toHaveLength(2);
    expect(db.credits.filter((c) => c.user_id === 'u1')).toHaveLength(1);
    expect(db.credits.filter((c) => c.user_id === 'u2')).toHaveLength(1);
    // Success embed announced exactly once — the second resolve does not re-notify.
    const successSends = send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'));
    expect(successSends).toHaveLength(1);
  });

  it('crash-then-resume does not re-notify or re-charge (resume finishes in_progress)', async () => {
    // Simulate a crash AFTER the atomic claim (status already 'in_progress',
    // outcome frozen) but BEFORE any payout landed. Resume must credit each
    // crew member exactly once and finalise.
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'success', payoutEach: 125,
      participants: ['u1', 'u2'], targetPayout: 250,
    });
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr); // resume finishes the frozen decision
    await resolve(mgr); // a second resume must be a no-op

    expect(db.heist.status).toBe('success');
    expect(db.credits).toHaveLength(2);
    const successSends = send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'));
    expect(successSends).toHaveLength(1);
  });

  it('crash-then-resume after partial payout credits only the unpaid participant', async () => {
    // u1 was already paid before the crash (paid_at set); u2 was not.
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'success', payoutEach: 125,
      participants: ['u1', 'u2'], targetPayout: 250,
    });
    db.parts[0].paid_at = new Date().toISOString(); // u1 already credited pre-crash
    const { client } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr);

    expect(db.heist.status).toBe('success');
    // Only u2 gets credited on resume; u1 is not double-paid.
    expect(db.credits).toHaveLength(1);
    expect(db.credits[0].user_id).toBe('u2');
  });

  it('concurrent resolve attempts collapse to a single payout', async () => {
    const db = makeStatefulDb({ status: 'recruiting', participants: ['u1', 'u2'], successChance: 100, targetPayout: 250 });
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    // Two resolvers race. The RPC dispatcher is synchronous per call, so the
    // claim's single-shot guard admits exactly one; the other sees
    // status !== 'recruiting' and no-ops.
    await Promise.all([resolve(mgr), resolve(mgr), resolve(mgr)]);

    expect(db.heist.status).toBe('success');
    expect(db.credits).toHaveLength(2); // exactly one credit per crew member
    const successSends = send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'));
    expect(successSends).toHaveLength(1);
  });

  it('double-resolve of an under-crewed heist refunds each member exactly once', async () => {
    const db = makeStatefulDb({ status: 'recruiting', participants: ['u1'], successChance: 100 });
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr);
    await resolve(mgr);

    expect(db.heist.status).toBe('cancelled');
    // Single refund of the entry fee to the one member.
    expect(db.credits).toHaveLength(1);
    expect(db.credits[0]).toEqual({ user_id: 'u1', amount: 100 });
    const cancelSends = send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Cancelled'));
    expect(cancelSends).toHaveLength(1);
  });

  it('failed heist finalises once and never credits', async () => {
    const db = makeStatefulDb({ status: 'recruiting', participants: ['u1', 'u2'], successChance: 0 });
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr);
    await resolve(mgr);

    expect(db.heist.status).toBe('failed');
    expect(db.credits).toHaveLength(0);
    const failSends = send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Failed'));
    expect(failSends).toHaveLength(1);
  });

  it('resumePendingHeists finishes a crashed in_progress heist exactly once', async () => {
    // Public entry point: a heist left 'in_progress' by a crash after the
    // atomic claim must be picked up on boot, paid once, and finalised once.
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'success', payoutEach: 125,
      participants: ['u1', 'u2'], targetPayout: 250,
    });
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await mgr.resumePendingHeists('g1');
    await mgr.resumePendingHeists('g1'); // a second boot resume must not re-pay

    expect(db.heist.status).toBe('success');
    expect(db.credits).toHaveLength(2);
    const successSends = send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'));
    expect(successSends).toHaveLength(1);
  });
});
