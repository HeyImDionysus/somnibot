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
  refundEach?: number | null;
  participants: string[];
  successChance?: number;
  targetPayout?: number;
  // user_ids whose heist_credit_participant call errors — but only while the
  // mutable Set still contains them, so a test can clear it to model a
  // transient failure that heals on the next resume.
  failCreditFor?: Set<string>;
  // When set, the frozen-crew SELECT (`.not('claimed_at','is',null)`) returns an
  // error while the flag holds — models a transient read failure that must be
  // treated as retryable, NOT as "no one to pay/refund". Cleared by a test to
  // heal the read on the next resume.
  failCrewRead?: { on: boolean };
}) {
  const failCreditFor = opts.failCreditFor ?? new Set<string>();
  const failCrewRead = opts.failCrewRead ?? { on: false };
  const heist: any = {
    id: 'h1',
    guild_id: 'g1',
    status: opts.status,
    resolution: opts.resolution ?? null,
    payout_each: opts.payoutEach ?? null,
    // Frozen per-member refund. A pre-claimed cancelled in_progress row carries
    // it (the claim stamped it); recruiting rows have it stamped by the claim RPC.
    refund_each: opts.refundEach ?? null,
    target_name: 'Corner Store',
    target_payout: opts.targetPayout ?? 250,
    success_chance: opts.successChance ?? 40,
    participants: [...opts.participants],
    expires_at: new Date(Date.now() - 1000).toISOString(),
  };
  // A heist that starts already claimed (in_progress) had its crew frozen by
  // the earlier claim, so those participants carry claimed_at. A still-recruiting
  // heist has none stamped yet — the claim RPC stamps them.
  const preClaimed = opts.status === 'in_progress';
  const parts = opts.participants.map((uid) => ({
    heist_id: 'h1', user_id: uid, role: 'Hacker', payout: 0,
    paid_at: null as string | null, payout_failed: false,
    claimed_at: (preClaimed ? new Date().toISOString() : null) as string | null,
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
    let claimedOnly = false;
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: string) => { if (col === 'user_id') target.user_id = val; return chain; },
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      // Models `.not('claimed_at', 'is', null)` — the frozen-crew filter the
      // settle loop uses so late (unstamped) joiners are excluded.
      not: (col: string, op: string, _val: unknown) => {
        if (col === 'claimed_at' && op === 'is') claimedOnly = true;
        return chain;
      },
      update: (patch: Record<string, unknown>) => {
        for (const p of parts) {
          if (target.user_id && p.user_id !== target.user_id) continue;
          Object.assign(p, patch);
        }
        return chain;
      },
      single: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (res: (v: unknown) => void) => {
        // Inject a transient failure on the frozen-crew read only (the settle
        // pass filters on claimed_at). A failed read must be retryable, never
        // interpreted as an empty crew.
        if (claimedOnly && failCrewRead.on) {
          return Promise.resolve({ data: null, error: { message: 'injected crew read failure' } }).then(res);
        }
        const rows = parts
          .filter((p) => (claimedOnly ? p.claimed_at != null : true))
          .map((p) => ({ ...p }));
        return Promise.resolve({ data: rows, error: null }).then(res);
      },
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
          return Promise.resolve({ data: [{ claimed: false, outcome: null, participant_count: 0, payout_each: null, refund_each: null }], error: null });
        }
        // Freeze the crew: stamp claimed_at on unstamped rows, then count only
        // stamped rows — mirrors the migration's UPDATE ... WHERE claimed_at IS
        // NULL followed by COUNT(*) WHERE claimed_at IS NOT NULL. Rows flagged
        // __late model participant inserts that commit AFTER this claim, so they
        // are left unstamped (never counted, never settled).
        for (const p of parts) { if (p.claimed_at == null && !(p as any).__late) p.claimed_at = new Date().toISOString(); }
        const count = parts.filter((p) => p.claimed_at != null).length;
        if (count < args.p_min_participants) {
          // Under-crewed now flips to the INTERMEDIATE in_progress with
          // resolution='cancelled' (not terminal), so a failed refund stays
          // retryable; heist_finalize_resolution moves it to terminal 'cancelled'
          // only after every refund committed. Mirrors 20260710120000 §B.
          // The per-member refund is FROZEN from the passed entry fee (mirrors
          // 20260710130000 §2), so later retries read a stable amount off the row.
          heist.status = 'in_progress'; heist.resolution = 'cancelled'; heist.refund_each = args.p_entry_fee;
          return Promise.resolve({ data: [{ claimed: true, outcome: 'cancelled', participant_count: count, payout_each: null, refund_each: args.p_entry_fee }], error: null });
        }
        const isSuccess = (heist.success_chance ?? 0) > 0; // deterministic for tests
        if (isSuccess) {
          const each = Math.floor(heist.target_payout / count);
          heist.status = 'in_progress'; heist.resolution = 'success'; heist.payout_each = each;
          return Promise.resolve({ data: [{ claimed: true, outcome: 'success', participant_count: count, payout_each: each, refund_each: null }], error: null });
        }
        heist.status = 'in_progress'; heist.resolution = 'failed'; heist.payout_each = 0;
        return Promise.resolve({ data: [{ claimed: true, outcome: 'failed', participant_count: count, payout_each: 0, refund_each: null }], error: null });
      }
      if (fn === 'heist_credit_participant') {
        const p = parts.find((x) => x.user_id === args.p_user_id);
        if (!p || p.paid_at) return Promise.resolve({ data: false, error: null }); // idempotent skip
        // Injected credit failure — leaves paid_at NULL (nothing stamped) so the
        // participant remains retryable, exactly like a real RPC error.
        if (failCreditFor.has(args.p_user_id)) {
          return Promise.resolve({ data: null, error: { message: 'injected credit failure' } });
        }
        if (args.p_amount > 0) credits.push({ user_id: args.p_user_id, amount: args.p_amount });
        p.paid_at = new Date().toISOString(); p.payout = args.p_amount; p.payout_failed = false;
        return Promise.resolve({ data: true, error: null });
      }
      if (fn === 'heist_finalize_resolution') {
        if (heist.status !== 'in_progress') return Promise.resolve({ data: false, error: null });
        // Refuse a NULL resolution (legacy in_progress heist) rather than
        // defaulting it to 'failed' — mirrors the migration guard.
        if (heist.resolution == null) return Promise.resolve({ data: false, error: null });
        heist.status = heist.resolution; heist.resolved_at = new Date().toISOString();
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

  // ── Finding 1: settle only the frozen (claimed) crew ────────────────────
  it('a late joiner inserted after the claim is not paid a success share', async () => {
    const db = makeStatefulDb({ status: 'recruiting', participants: ['u1', 'u2'], successChance: 100, targetPayout: 250 });
    const { client } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    // Simulate a /heist join whose participant insert lands AFTER the claim:
    // add an unstamped (claimed_at = null) row flagged __late so the claim fake
    // leaves it unstamped. In the real system the claim already committed and
    // froze the crew at 2 members.
    db.parts.push({ heist_id: 'h1', user_id: 'late', role: 'Hacker', payout: 0, paid_at: null, payout_failed: false, claimed_at: null, __late: true } as any);

    await resolve(mgr);

    expect(db.heist.status).toBe('success');
    // payout_each was frozen at 250/2 = 125; only the two claimed members get it.
    expect(db.credits).toHaveLength(2);
    expect(db.credits.map((c) => c.user_id).sort()).toEqual(['u1', 'u2']);
    expect(db.credits.every((c) => c.amount === 125)).toBe(true);
    // The late joiner is never credited.
    expect(db.credits.some((c) => c.user_id === 'late')).toBe(false);
  });

  it('an under-crewed cancellation refunds/announces only the frozen crew', async () => {
    // The heist is already claimed-cancelled with one stamped crew member; a
    // later unstamped row (a join that raced past the claim) is present when the
    // refund pass reads participants. It must be excluded from both the refund
    // and the announced crew count.
    const db = makeStatefulDb({ status: 'recruiting', participants: ['u1'], successChance: 100 });
    db.parts.push({ heist_id: 'h1', user_id: 'late', role: 'Hacker', payout: 0, paid_at: null, payout_failed: false, claimed_at: null });
    // Mark the late row so the claim fake does not stamp it (models an insert
    // that commits after the claim's freeze).
    (db.parts[1] as any).__late = true;
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr); // claims (freezes u1 only), cancels, refunds the frozen crew

    expect(db.heist.status).toBe('cancelled');
    // Only u1 (the frozen crew) is refunded; the late joiner is not.
    expect(db.credits).toHaveLength(1);
    expect(db.credits[0]).toEqual({ user_id: 'u1', amount: 100 });
    const cancelSends = send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Cancelled'));
    // Announced once, and the crew size in the message reflects the frozen 1.
    expect(cancelSends).toHaveLength(1);
    expect(String(cancelSends[0][0]?.embeds?.[0]?.data?.description ?? '')).toContain('got 1');
  });

  // ── Round-3 finding: a failed cancel refund stays retryable, not terminal ──
  it('a failed cancel refund leaves the heist in_progress and does not announce', async () => {
    // Under-crewed heist whose single crew member's refund RPC errors. The row
    // must NOT be finalised to terminal 'cancelled' (that would strand the
    // refund — resumePendingHeists skips terminal rows) and the channel must NOT
    // be told fees were refunded while a refund is still outstanding.
    const failSet = new Set(['u1']);
    const db = makeStatefulDb({
      status: 'recruiting', participants: ['u1'], successChance: 100,
      failCreditFor: failSet,
    });
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr); // claims (cancelled), refund of u1 errors → stay in_progress

    expect(db.heist.status).toBe('in_progress');
    expect(db.heist.resolution).toBe('cancelled');
    expect(db.credits).toHaveLength(0);
    // No "Heist Cancelled" announcement while the refund is unpaid.
    expect(send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Cancelled'))).toHaveLength(0);

    // The transient failure heals; the next resume refunds u1 and finalises.
    failSet.clear();
    await mgr.resumePendingHeists('g1');

    expect(db.heist.status).toBe('cancelled');
    expect(db.credits).toEqual([{ user_id: 'u1', amount: 100 }]);
    // Announced exactly once, only after the refund committed.
    const cancelSends = send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Cancelled'));
    expect(cancelSends).toHaveLength(1);
  });

  it('a failed cancel refund retries in-process and is not double-refunded', async () => {
    vi.useFakeTimers();
    try {
      const failSet = new Set(['u1']);
      const db = makeStatefulDb({
        status: 'recruiting', participants: ['u1'], successChance: 100,
        failCreditFor: failSet,
      });
      const { client, send } = makeClient();
      const mgr = new HeistManager(db.supabase as any, client as any);

      await resolve(mgr); // refund errors → in_progress + in-process retry scheduled
      expect(db.heist.status).toBe('in_progress');
      expect(db.credits).toHaveLength(0);

      failSet.clear();
      await vi.advanceTimersByTimeAsync(1_500); // first backoff is 1s

      expect(db.heist.status).toBe('cancelled');
      // Refunded exactly once (paid_at guard survives the retry).
      expect(db.credits).toEqual([{ user_id: 'u1', amount: 100 }]);
      expect(send.mock.calls.filter(
        (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Cancelled'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Finding 2: an errored payout stays retryable (not finalised) ────────
  it('a failed payout leaves the heist in_progress and retries on resume', async () => {
    const failSet = new Set(['u2']);
    const db = makeStatefulDb({
      status: 'recruiting', participants: ['u1', 'u2'], successChance: 100, targetPayout: 250,
      failCreditFor: failSet,
    });
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr); // u1 paid, u2's credit errors → must NOT finalise

    // The heist is left mid-resolution so a later resume can retry u2.
    expect(db.heist.status).toBe('in_progress');
    expect(db.heist.resolution).toBe('success');
    expect(db.credits).toEqual([{ user_id: 'u1', amount: 125 }]);
    // No success announcement while a payout is still outstanding.
    expect(send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'))).toHaveLength(0);

    // The transient failure heals; the next resume pays only the still-unpaid u2.
    failSet.clear();
    await mgr.resumePendingHeists('g1');

    expect(db.heist.status).toBe('success');
    expect(db.credits).toHaveLength(2);
    expect(db.credits.filter((c) => c.user_id === 'u2')).toEqual([{ user_id: 'u2', amount: 125 }]);
    // u1 is not double-credited (paid_at guard).
    expect(db.credits.filter((c) => c.user_id === 'u1')).toHaveLength(1);
    // Announced exactly once, only after every member is paid.
    expect(send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'))).toHaveLength(1);
  });

  // ── Finding (round 2): errored payout is retried IN-PROCESS, not only on restart ──
  it('a transient payout error schedules an in-process retry that pays + finalises', async () => {
    vi.useFakeTimers();
    try {
      const failSet = new Set(['u2']);
      const db = makeStatefulDb({
        status: 'recruiting', participants: ['u1', 'u2'], successChance: 100, targetPayout: 250,
        failCreditFor: failSet,
      });
      const { client, send } = makeClient();
      const mgr = new HeistManager(db.supabase as any, client as any);

      await resolve(mgr); // u1 paid, u2 errors → left in_progress + in-process retry scheduled

      expect(db.heist.status).toBe('in_progress');
      expect(db.credits).toEqual([{ user_id: 'u1', amount: 125 }]);
      // No announcement yet.
      expect(send.mock.calls.filter(
        (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'))).toHaveLength(0);

      // The transient failure heals; advancing past the backoff fires the
      // in-process retry (no restart / resumePendingHeists needed).
      failSet.clear();
      await vi.advanceTimersByTimeAsync(1_500); // first backoff is 1s

      expect(db.heist.status).toBe('success');
      expect(db.credits).toHaveLength(2);
      expect(db.credits.filter((c) => c.user_id === 'u2')).toEqual([{ user_id: 'u2', amount: 125 }]);
      // u1 not double-credited.
      expect(db.credits.filter((c) => c.user_id === 'u1')).toHaveLength(1);
      // Announced exactly once, only after every member is paid.
      expect(send.mock.calls.filter(
        (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('in-process retries are bounded and give up after MAX_RETRY_ATTEMPTS', async () => {
    vi.useFakeTimers();
    try {
      // u2's credit never heals — the retry must not loop forever.
      const failSet = new Set(['u2']);
      const db = makeStatefulDb({
        status: 'recruiting', participants: ['u1', 'u2'], successChance: 100, targetPayout: 250,
        failCreditFor: failSet,
      });
      const { client } = makeClient();
      const mgr = new HeistManager(db.supabase as any, client as any);

      await resolve(mgr); // initial attempt fails on u2

      // Drain all scheduled backoffs (1+2+4+8+16s, capped 30s each). Advancing a
      // generous window fires every retry; each re-fails and reschedules until
      // the attempt cap, after which no further timer is armed.
      await vi.advanceTimersByTimeAsync(300_000);

      // Never finalised — left in_progress for a future restart's resume.
      expect(db.heist.status).toBe('in_progress');
      // u1 paid exactly once across all attempts (idempotent); u2 never paid.
      expect(db.credits).toEqual([{ user_id: 'u1', amount: 125 }]);
      // No pending timers remain (bounded) — a further advance changes nothing.
      const before = db.credits.length;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(db.credits.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Finding 3: legacy in_progress heist (NULL resolution) is not failed ──
  it('a legacy in_progress heist with NULL resolution is left untouched, not failed', async () => {
    // Old-resolver row: status in_progress but no frozen resolution.
    const db = makeStatefulDb({
      status: 'in_progress', resolution: null, participants: ['u1', 'u2'], targetPayout: 250,
    });
    // The old crew were already stamped-in-progress in this model; ensure the
    // manager still refuses to finalize regardless of the frozen-crew filter.
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await mgr.resumePendingHeists('g1');

    // Must NOT be driven to a terminal 'failed'; left for a dedicated backfill.
    expect(db.heist.status).toBe('in_progress');
    expect(db.credits).toHaveLength(0);
    // No failure (or any) announcement for the legacy heist.
    expect(send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist'))).toHaveLength(0);
  });

  // ── Newest finding (a): a failed frozen-crew read is retryable, not "no one to pay" ──
  it('a failed frozen-crew read does NOT finalise a success — it stays retryable', async () => {
    // The claim has frozen a 2-member crew and rolled success; the settle pass's
    // participant SELECT then errors. Treating that empty/errored read as "no one
    // to pay" would finalise the heist to terminal 'success' while crediting
    // nobody — every frozen member silently loses their share (paid_at stays NULL
    // and no terminal heist is ever revisited). The heist must instead stay
    // in_progress and retryable.
    const failCrewRead = { on: true };
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'success', payoutEach: 125,
      participants: ['u1', 'u2'], targetPayout: 250, failCrewRead,
    });
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr); // crew read errors → must NOT finalise, must NOT credit

    expect(db.heist.status).toBe('in_progress');
    expect(db.heist.resolution).toBe('success');
    expect(db.credits).toHaveLength(0);
    // No success announcement while the crew could not even be read.
    expect(send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'))).toHaveLength(0);

    // The read heals; the next resume reads the frozen crew and pays both once.
    failCrewRead.on = false;
    await mgr.resumePendingHeists('g1');

    expect(db.heist.status).toBe('success');
    expect(db.credits).toHaveLength(2);
    expect(db.credits.map((c) => c.user_id).sort()).toEqual(['u1', 'u2']);
    expect(send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'))).toHaveLength(1);
  });

  it('a failed frozen-crew read does NOT finalise a cancel — the refund stays retryable', async () => {
    // Same defect on the cancel path: an under-crewed heist whose frozen-crew
    // read errors must not be flipped to terminal 'cancelled' with zero refunds
    // (which would forfeit the frozen member's entry fee). It must stay
    // in_progress/retryable, then refund once the read heals.
    const failCrewRead = { on: true };
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'cancelled', refundEach: 100,
      participants: ['u1'], failCrewRead,
    });
    // Pre-claimed cancelled row: its single crew member was frozen (claimed_at set).
    db.parts[0].claimed_at = new Date().toISOString();
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr); // crew read errors → must stay in_progress, no refund

    expect(db.heist.status).toBe('in_progress');
    expect(db.heist.resolution).toBe('cancelled');
    expect(db.credits).toHaveLength(0);
    expect(send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Cancelled'))).toHaveLength(0);

    // Read heals → the frozen crew member is refunded exactly once and finalised.
    failCrewRead.on = false;
    await mgr.resumePendingHeists('g1');

    expect(db.heist.status).toBe('cancelled');
    expect(db.credits).toEqual([{ user_id: 'u1', amount: 100 }]);
    expect(send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Cancelled'))).toHaveLength(1);
  });

  // ── Newest finding (b): the cancel refund amount is FROZEN at claim time ──
  it('the claim freezes refund_each on the row and the refund uses that frozen value', async () => {
    // The under-crewed claim must persist the per-member refund (the entry fee it
    // was passed) on the heist row, and the settle pass must refund exactly that
    // frozen amount — establishing the value the resume test proves is immune to
    // later config drift.
    const db = makeStatefulDb({ status: 'recruiting', participants: ['u1'], successChance: 100 });
    const { client } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr); // 1 < min(2) → cancel; claim freezes refund_each = 100

    expect(db.heist.status).toBe('cancelled');
    expect(db.heist.refund_each).toBe(100); // frozen on the row at claim time
    expect(db.credits).toEqual([{ user_id: 'u1', amount: 100 }]); // refunded the frozen value
  });

  it('a resumed cancelled heist refunds the frozen refund_each off the row (not config)', async () => {
    // A crash left the heist in_progress/cancelled with refund_each=100 frozen on
    // the row. Even if config now reads a different entry fee, the resume refunds
    // the frozen 100.
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'cancelled', refundEach: 100,
      participants: ['u1'],
    });
    db.parts[0].claimed_at = new Date().toISOString(); // frozen crew member
    const { client } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    CONFIG.economy_heist_entry_fee = 999;
    try {
      await mgr.resumePendingHeists('g1');
    } finally {
      CONFIG.economy_heist_entry_fee = 100;
    }

    expect(db.heist.status).toBe('cancelled');
    expect(db.credits).toEqual([{ user_id: 'u1', amount: 100 }]);
  });
});
