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

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
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
  // Initial crew as user_ids. Seeds the participant ROWS (the single source of
  // truth); there is no participants[] array on the heist row anymore.
  participants: string[];
  // The old success_chance seed. It now maps to base_success_chance (the
  // immutable single-member anchor) — the claim DERIVES the roll chance from
  // base + the frozen crew count, and the success/fail decision below keys off
  // this seed (>0 ⇒ success, 0 ⇒ fail) for deterministic tests.
  successChance?: number;
  targetPayout?: number;
  // Per-user frozen entry_fee_paid stamped on each seeded participant row. Lets a
  // test model a crew that paid DIFFERENT fees (an admin edited the entry fee mid
  // recruiting window) so the cancel refund can be asserted per-member. Defaults
  // to 100 for any user not listed here.
  entryFeePaid?: Record<string, number>;
  // user_ids whose heist_credit_participant call errors — but only while the
  // mutable Set still contains them, so a test can clear it to model a
  // transient failure that heals on the next resume.
  failCreditFor?: Set<string>;
  // When set, the frozen-crew SELECT (`.not('claimed_at','is',null)`) returns an
  // error while the flag holds — models a transient read failure that must be
  // treated as retryable, NOT as "no one to pay/refund". Cleared by a test to
  // heal the read on the next resume.
  failCrewRead?: { on: boolean };
  // When set, heist_reconcile_stranded_joins errors while the flag holds —
  // models a transient reconcile failure that must be retryable, NOT a terminal
  // flip that strands a late joiner's fee. Cleared by a test to heal it.
  failReconcile?: { on: boolean };
  // When set, heist_claim_for_resolution errors while the flag holds — models a
  // transient claim failure at expiry that must RE-ARM resolution (in-process
  // retry), NOT strand the recruiting heist until the next restart (codex :617).
  failClaim?: { on: boolean };
  // When set, the heist-row single() re-read errors while the flag holds — models
  // the claim-lost re-read failing transiently, which must schedule a retry, NOT
  // return terminally (codex :631).
  failHeistRead?: { on: boolean };
  // When set, heist_claim_for_resolution returns claimed:false (a concurrent
  // resolver won the claim) even though our stale read saw 'recruiting' — drives
  // the claim-lost re-read path so failHeistRead can fail that re-read.
  loseClaim?: { on: boolean };
}) {
  const failCreditFor = opts.failCreditFor ?? new Set<string>();
  const failCrewRead = opts.failCrewRead ?? { on: false };
  const failReconcile = opts.failReconcile ?? { on: false };
  const failClaim = opts.failClaim ?? { on: false };
  const failHeistRead = opts.failHeistRead ?? { on: false };
  const loseClaim = opts.loseClaim ?? { on: false };
  const heist: any = {
    id: 'h1',
    guild_id: 'g1',
    status: opts.status,
    resolution: opts.resolution ?? null,
    payout_each: opts.payoutEach ?? null,
    target_name: 'Corner Store',
    target_payout: opts.targetPayout ?? 250,
    // Immutable derivation anchor (was the mutable success_chance counter). The
    // roll chance and every display chance derive from this + a participant-row
    // COUNT; nothing else is stored. There is NO participants[] array.
    base_success_chance: opts.successChance ?? 40,
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
    // Frozen fee this member paid at join time. The bot stamps it on insert; EVERY
    // refund path — cancelled frozen crew AND stranded late join — refunds THIS
    // per-row value on any outcome. Default to the config entry fee (100) so
    // existing tests keep their amounts; a test may override per-user to model a
    // crew that paid heterogeneous fees.
    entry_fee_paid: (opts.entryFeePaid?.[uid] ?? 100) as number | null,
  }));

  // Ledger of every wallet credit that actually landed.
  const credits: Array<{ user_id: string; amount: number }> = [];

  // Set true once a claim was LOST (returned claimed:false). The claim-lost
  // re-read that follows is the ONLY economy_heists single() we let failHeistRead
  // fail — the initial resolveHeist read must still succeed so we reach the claim.
  const claimState = { lostClaim: false };

  function heistChain() {
    let selecting = false;
    const readHeist = () => {
      // Fail ONLY the claim-lost re-read (after a lost claim), never the initial
      // read — models a transient re-read error that must schedule a retry.
      if (selecting && failHeistRead.on && claimState.lostClaim) {
        return Promise.resolve({ data: null, error: { message: 'injected heist re-read failure' } });
      }
      return Promise.resolve({ data: selecting ? { ...heist } : null, error: null });
    };
    const chain: any = {
      select: () => { selecting = true; return chain; },
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (patch: Record<string, unknown>) => { Object.assign(heist, patch); return chain; },
      single: () => readHeist(),
      maybeSingle: () => readHeist(),
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
        // Transient claim error (codex :617): the bot must re-arm resolution, not
        // strand the recruiting heist.
        if (failClaim.on) {
          return Promise.resolve({ data: null, error: { message: 'injected claim failure' } });
        }
        // Single-shot: only the caller that observes 'recruiting' claims. Model a
        // lost claim (a concurrent resolver already claimed) so the claim-lost
        // re-read path runs — failHeistRead can then fail that re-read (codex :631).
        // loseClaim forces claimed:false even against a 'recruiting' snapshot to
        // model the race where another resolver flipped the row between our stale
        // read and the claim.
        if (heist.status !== 'recruiting' || loseClaim.on) {
          claimState.lostClaim = true;
          return Promise.resolve({ data: [{ claimed: false, outcome: null, participant_count: 0, payout_each: null }], error: null });
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
          // The claim no longer freezes a per-heist refund amount — every refund
          // reads each participant's OWN frozen entry_fee_paid (20260710160000).
          heist.status = 'in_progress'; heist.resolution = 'cancelled';
          return Promise.resolve({ data: [{ claimed: true, outcome: 'cancelled', participant_count: count, payout_each: null }], error: null });
        }
        // The roll chance is DERIVED from base_success_chance + the FROZEN crew
        // count, clamped [0,95] — never a stored counter (20260710180000). The
        // success/fail decision is deterministic for tests: a base > 0 always
        // succeeds, a base of 0 always fails (the seeded 100/0 sentinels).
        const _derivedChance = Math.min(95, Math.max(0, (heist.base_success_chance ?? 0) + (count - 1) * 7));
        void _derivedChance;
        const isSuccess = (heist.base_success_chance ?? 0) > 0; // deterministic for tests
        if (isSuccess) {
          const each = Math.floor(heist.target_payout / count);
          heist.status = 'in_progress'; heist.resolution = 'success'; heist.payout_each = each;
          return Promise.resolve({ data: [{ claimed: true, outcome: 'success', participant_count: count, payout_each: each }], error: null });
        }
        heist.status = 'in_progress'; heist.resolution = 'failed'; heist.payout_each = 0;
        return Promise.resolve({ data: [{ claimed: true, outcome: 'failed', participant_count: count, payout_each: 0 }], error: null });
      }
      if (fn === 'heist_reconcile_stranded_joins') {
        // Sweep every crash-stranded late-join row (claimed_at NULL AND paid_at
        // NULL): delete it, drop its participants[] slot, refund the row's OWN
        // frozen entry_fee_paid (fallback p_refund_amount for legacy rows) —
        // mirrors heist_reconcile_stranded_joins under the heist-row lock. Using
        // the per-row frozen fee (not a per-heist value) is what makes the refund
        // correct on a success/failed heist and immune to a config edit. A frozen
        // crew member (claimed_at set) is untouched; a re-run finds nothing (rows
        // already deleted) so it is idempotent.
        if (failReconcile.on) {
          return Promise.resolve({ data: null, error: { message: 'injected reconcile failure' } });
        }
        const stranded = parts.filter((p) => p.claimed_at == null && p.paid_at == null);
        for (const p of stranded) {
          // Deleting the ROW is the entire removal — no participants[] array to
          // maintain (20260710180000).
          const idx = parts.indexOf(p);
          if (idx >= 0) parts.splice(idx, 1);
          const refund = p.entry_fee_paid ?? args.p_refund_amount;
          if (refund > 0) credits.push({ user_id: p.user_id, amount: refund });
        }
        return Promise.resolve({ data: stranded.length, error: null });
      }
      if (fn === 'heist_settle_missed_join') {
        // Models the migration's TEXT-status contract. With the participants[]
        // array gone (20260710180000), deleting the ROW is the whole removal —
        // there is no ghost array slot to strip on any branch.
        if (heist.status === 'recruiting') return Promise.resolve({ data: 'recruiting', error: null });
        const p = parts.find((x) => x.user_id === args.p_user_id);
        if (!p) {
          // Row gone (a concurrent bulk reconcile deleted it) → reconciled.
          return Promise.resolve({ data: 'reconciled', error: null });
        }
        if (p.claimed_at != null) return Promise.resolve({ data: 'in_crew', error: null });
        if (p.paid_at != null) {
          return Promise.resolve({ data: 'reconciled', error: null });
        }
        // Unstamped + unsettled: delete the row, refund frozen fee.
        const idx = parts.indexOf(p);
        if (idx >= 0) parts.splice(idx, 1);
        const refund = p.entry_fee_paid ?? args.p_refund_amount;
        if (refund > 0) credits.push({ user_id: args.p_user_id, amount: refund });
        return Promise.resolve({ data: 'refunded', error: null });
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
      if (fn === 'heist_join') {
        // Atomic serialized join under the heist-row lock. Re-check status: if the
        // heist already left 'recruiting' (the claim won the lock), reject WITHOUT
        // debiting — a post-recruiting insert is structurally impossible, so no fee
        // is ever stranded. Otherwise debit and insert the ROW (frozen fee). Crew
        // count + success_chance are DERIVED from the participant rows (no
        // participants[] array, no stored counter — 20260710180000).
        const rowCount = () => parts.length;
        const deriveChance = (n: number) => Math.min(95, Math.max(0, args.p_base_chance + (n - 1) * 7));
        if (heist.status !== 'recruiting') {
          return Promise.resolve({
            data: [{ status: 'not_recruiting', member_count: rowCount(), success_chance: 0, role: null }],
            error: null,
          });
        }
        if (parts.some((p) => p.user_id === args.p_user_id)) {
          return Promise.resolve({
            data: [{ status: 'already_joined', member_count: rowCount(), success_chance: deriveChance(rowCount()), role: null }],
            error: null,
          });
        }
        if (rowCount() >= args.p_max) {
          return Promise.resolve({
            data: [{ status: 'crew_full', member_count: rowCount(), success_chance: deriveChance(rowCount()), role: null }],
            error: null,
          });
        }
        // Debit (models economy_subtract_balance inside the tx) + insert the row.
        credits.push({ user_id: args.p_user_id, amount: -args.p_entry_fee });
        parts.push({
          heist_id: 'h1', user_id: args.p_user_id, role: args.p_role, payout: 0,
          paid_at: null, payout_failed: false, claimed_at: null,
          entry_fee_paid: args.p_entry_fee,
        });
        const newCount = rowCount();
        // Derived, clamped — display-only; nothing stored back on the heist row.
        return Promise.resolve({
          data: [{ status: 'joined', member_count: newCount, success_chance: deriveChance(newCount), role: args.p_role }],
          error: null,
        });
      }
      if (fn === 'heist_undo_join') {
        // Simplified undo (20260710180000): with success_chance DERIVED and the
        // participants[] array gone, an undo has nothing to recompute and no slot
        // to strip — it just refunds the frozen fee and DELETES the row. The next
        // derivation reads one fewer row, so the chance drops automatically,
        // capped or not. Only a still-recruiting, unstamped, unsettled row.
        if (heist.status !== 'recruiting') return Promise.resolve({ data: 'not_recruiting', error: null });
        const p = parts.find((x) => x.user_id === args.p_user_id);
        if (!p) {
          return Promise.resolve({ data: 'gone', error: null });
        }
        if (p.claimed_at != null) return Promise.resolve({ data: 'in_crew', error: null });
        if (p.paid_at != null) {
          return Promise.resolve({ data: 'gone', error: null });
        }
        const idx = parts.indexOf(p);
        if (idx >= 0) parts.splice(idx, 1);
        const refund = p.entry_fee_paid ?? args.p_refund_amount;
        if (refund > 0) credits.push({ user_id: args.p_user_id, amount: refund });
        return Promise.resolve({ data: 'undone', error: null });
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
  it('a late joiner inserted after the claim is not paid a success share (its fee is reconciled)', async () => {
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
    // The two FROZEN members get the frozen success share (250/2 = 125 each);
    // the late joiner is never paid a success share.
    expect(db.credits.filter((c) => c.user_id === 'u1')).toEqual([{ user_id: 'u1', amount: 125 }]);
    expect(db.credits.filter((c) => c.user_id === 'u2')).toEqual([{ user_id: 'u2', amount: 125 }]);
    expect(db.credits.some((c) => c.user_id === 'late' && c.amount === 125)).toBe(false);
    // But the stranded late-join row is reconciled (not left unsettled): its entry
    // fee is refunded exactly once and the row removed from the crew.
    expect(db.credits.filter((c) => c.user_id === 'late')).toEqual([{ user_id: 'late', amount: 100 }]);
    // The row is deleted — and since crew membership derives ONLY from the rows
    // now, deleting the row IS its full removal from the crew (no array to check).
    expect(db.parts.some((p) => p.user_id === 'late')).toBe(false);
  });

  it('an under-crewed cancellation refunds/announces only the frozen crew', async () => {
    // The heist is claimed-cancelled with one stamped crew member; a later
    // unstamped row (a join that raced past the claim) is present when the refund
    // pass reads participants. It must be excluded from the announced crew count,
    // but its stranded entry fee must still be reconciled (refunded) rather than
    // lost — it is not part of the FROZEN crew's cancel refund.
    const db = makeStatefulDb({ status: 'recruiting', participants: ['u1'], successChance: 100 });
    db.parts.push({ heist_id: 'h1', user_id: 'late', role: 'Hacker', payout: 0, paid_at: null, payout_failed: false, claimed_at: null, entry_fee_paid: 100 });
    // Mark the late row so the claim fake does not stamp it (models an insert
    // that commits after the claim's freeze).
    (db.parts[1] as any).__late = true;
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr); // claims (freezes u1 only), reconciles the late row, cancels, refunds u1

    expect(db.heist.status).toBe('cancelled');
    // The frozen crew member u1 is refunded the frozen fee (100)…
    expect(db.credits.filter((c) => c.user_id === 'u1')).toEqual([{ user_id: 'u1', amount: 100 }]);
    // …and the stranded late joiner is reconciled (fee refunded once, row removed),
    // never silently forfeited.
    expect(db.credits.filter((c) => c.user_id === 'late')).toEqual([{ user_id: 'late', amount: 100 }]);
    expect(db.parts.some((p) => p.user_id === 'late')).toBe(false);
    const cancelSends = send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Cancelled'));
    // Announced once, and the crew size in the message reflects the frozen 1
    // (the late joiner is not part of the announced crew).
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
      status: 'in_progress', resolution: 'cancelled',
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

  // ── Unification (codex :777): the cancel refund is each member's OWN frozen fee ──
  it('a cancelled heist refunds each frozen crew member their OWN entry_fee_paid', async () => {
    // The refund reads each participant's frozen entry_fee_paid (not a per-heist
    // amount). refund_each no longer exists on the row — the per-participant frozen
    // fee is the single source for every refund path.
    const db = makeStatefulDb({ status: 'recruiting', participants: ['u1'], successChance: 100 });
    const { client } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr); // 1 < min(2) → cancel; refund u1 their frozen fee (100)

    expect(db.heist.status).toBe('cancelled');
    expect(db.heist.refund_each).toBeUndefined(); // column removed — no per-heist frozen refund
    expect(db.credits).toEqual([{ user_id: 'u1', amount: 100 }]); // refunded the per-row frozen value
  });

  it('a cancelled crew that paid DIFFERENT fees is each refunded its own amount (codex :777)', async () => {
    // An admin raised the entry fee during the recruiting window: the initiator u1
    // paid 100, a later joiner u2 paid 200. min crew is 3, so with only 2 members
    // the heist cancels. The OLD code refunded every frozen member a single
    // per-heist refund_each (over/under-refunding u1 or u2). The unified path
    // refunds each member their OWN frozen entry_fee_paid: u1 → 100, u2 → 200.
    const db = makeStatefulDb({
      status: 'recruiting', participants: ['u1', 'u2'], successChance: 100,
      entryFeePaid: { u1: 100, u2: 200 },
    });
    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    // min participants for cancellation is 2 by default; force a higher bar so a
    // 2-member crew cancels. CONFIG drives economy_heist_min_participants.
    CONFIG.economy_heist_min_participants = 3;
    try {
      await resolve(mgr); // 2 < min(3) → cancel; each member refunded their own fee
    } finally {
      CONFIG.economy_heist_min_participants = 2;
    }

    expect(db.heist.status).toBe('cancelled');
    // Each frozen crew member refunded EXACTLY what they paid — never a shared value.
    expect(db.credits.filter((c) => c.user_id === 'u1')).toEqual([{ user_id: 'u1', amount: 100 }]);
    expect(db.credits.filter((c) => c.user_id === 'u2')).toEqual([{ user_id: 'u2', amount: 200 }]);
    // Announced once.
    expect(send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Cancelled'))).toHaveLength(1);
  });

  it('a resumed cancelled heist refunds each crew member their frozen entry_fee_paid (not config)', async () => {
    // A crash left the heist in_progress/cancelled with the crew frozen. Even if
    // config now reads a different entry fee, the resume refunds each member the
    // fee frozen on their participant row (u1 paid 100, u2 paid 200), never the
    // drifted config value.
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'cancelled',
      participants: ['u1', 'u2'], entryFeePaid: { u1: 100, u2: 200 },
    });
    db.parts[0].claimed_at = new Date().toISOString(); // frozen crew member
    db.parts[1].claimed_at = new Date().toISOString(); // frozen crew member
    const { client } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    CONFIG.economy_heist_entry_fee = 999;
    try {
      await mgr.resumePendingHeists('g1');
    } finally {
      CONFIG.economy_heist_entry_fee = 100;
    }

    expect(db.heist.status).toBe('cancelled');
    expect(db.credits.filter((c) => c.user_id === 'u1')).toEqual([{ user_id: 'u1', amount: 100 }]);
    expect(db.credits.filter((c) => c.user_id === 'u2')).toEqual([{ user_id: 'u2', amount: 200 }]);
  });

  it('a resumed single-member cancelled heist refunds the frozen fee (legacy shape)', async () => {
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'cancelled',
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

  // ── Newest finding: reconcile crash-stranded late joins before terminalizing ──
  it('a late-join row stranded by a crash is refunded once on resume and the heist finalises cleanly', async () => {
    // Model the crash window: a /heist join debited the fee and inserted the
    // participant row AFTER the claim froze the crew, but the bot crashed before
    // joinHeist reached heist_settle_missed_join — so the row survives with
    // claimed_at = NULL and paid_at = NULL. The heist is already claimed-success
    // (frozen crew u1,u2). On resume the stranded 'late' row must be reconciled
    // (fee refunded exactly once) and the heist must finalise to success.
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'success', payoutEach: 125,
      participants: ['u1', 'u2'], targetPayout: 250,
    });
    // u1,u2 are the frozen crew (in_progress preseeds claimed_at). Add the
    // stranded 'late' row: unstamped + unpaid, and present in participants[].
    db.parts.push({ heist_id: 'h1', user_id: 'late', role: 'Hacker', payout: 0, paid_at: null, payout_failed: false, claimed_at: null, entry_fee_paid: 100 });    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await mgr.resumePendingHeists('g1');

    expect(db.heist.status).toBe('success');
    // Frozen crew paid their success share once each…
    expect(db.credits.filter((c) => c.user_id === 'u1')).toEqual([{ user_id: 'u1', amount: 125 }]);
    expect(db.credits.filter((c) => c.user_id === 'u2')).toEqual([{ user_id: 'u2', amount: 125 }]);
    // …and the stranded joiner's fee is refunded exactly once (entry fee 100).
    expect(db.credits.filter((c) => c.user_id === 'late')).toEqual([{ user_id: 'late', amount: 100 }]);
    // The stranded row is deleted — its removal from the row set IS its removal
    // from the crew (crew derives from rows; there is no participants[] array).
    expect(db.parts.some((p) => p.user_id === 'late')).toBe(false);
    const successSends = send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'));
    expect(successSends).toHaveLength(1);
  });

  it('re-running the resolve does not double-refund a reconciled stranded join (idempotent)', async () => {
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'success', payoutEach: 125,
      participants: ['u1', 'u2'], targetPayout: 250,
    });
    db.parts.push({ heist_id: 'h1', user_id: 'late', role: 'Hacker', payout: 0, paid_at: null, payout_failed: false, claimed_at: null, entry_fee_paid: 100 });    const { client } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr);  // reconciles + refunds 'late', pays crew, finalises
    await resolve(mgr);  // a second resolve must find nothing stranded to refund

    expect(db.heist.status).toBe('success');
    // 'late' refunded exactly once across both resolves (the row was deleted, so
    // the second reconcile sweep finds nothing).
    expect(db.credits.filter((c) => c.user_id === 'late')).toEqual([{ user_id: 'late', amount: 100 }]);
    // Frozen crew each paid exactly once.
    expect(db.credits.filter((c) => c.user_id === 'u1')).toHaveLength(1);
    expect(db.credits.filter((c) => c.user_id === 'u2')).toHaveLength(1);
  });

  it('a normally-settled (already paid) missed join is not swept or re-refunded', async () => {
    // A participant row that is unstamped (claimed_at NULL) but ALREADY settled
    // (paid_at set) — e.g. a missed join that heist_settle_missed_join already
    // refunded, or any credited row — must be left untouched by the reconcile
    // sweep (which only targets claimed_at NULL AND paid_at NULL). No double refund.
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'success', payoutEach: 125,
      participants: ['u1', 'u2'], targetPayout: 250,
    });
    // Add an unstamped-but-already-settled row; it must NOT be swept/refunded.
    db.parts.push({ heist_id: 'h1', user_id: 'settled', role: 'Hacker', payout: 100, paid_at: new Date().toISOString(), payout_failed: false, claimed_at: null, entry_fee_paid: 100 });
    const { client } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr);

    expect(db.heist.status).toBe('success');
    // The already-settled row is never credited again by the reconcile sweep.
    expect(db.credits.some((c) => c.user_id === 'settled')).toBe(false);
    // It is also not deleted (it was legitimately settled, not stranded).
    expect(db.parts.some((p) => p.user_id === 'settled')).toBe(true);
  });

  // ── Newest finding (codex :704): stranded join is refunded the DEBITED fee,
  //    frozen per-row, on a SUCCESS heist (where refund_each is NULL) and immune
  //    to a config edit after the debit. ──────────────────────────────────────
  it('a stranded join on a SUCCESS heist is refunded its OWN frozen fee, not the drifted config value', async () => {
    // Success heist: refund_each is NULL (only cancelled heists freeze it). A late
    // join that raced past the claim was charged 150 (frozen on its row), but the
    // guild has since re-read entry_fee=100 in this resolve attempt. The refund
    // must be the 150 the joiner actually paid — read from entry_fee_paid — NOT
    // the 100 the config now reports. This is the exact over/under-refund codex
    // flagged: for success/failed heists the old code fell back to the live config
    // entry fee.
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'success', payoutEach: 125,
      participants: ['u1', 'u2'], targetPayout: 250,
    });
    db.parts.push({
      heist_id: 'h1', user_id: 'late', role: 'Hacker', payout: 0,
      paid_at: null, payout_failed: false, claimed_at: null,
      entry_fee_paid: 150, // charged 150 at join time — before an admin lowered the fee
    } as any);    const { client } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await mgr.resumePendingHeists('g1');

    expect(db.heist.status).toBe('success');
    // Frozen crew paid their success share; the stranded joiner refunded EXACTLY
    // the 150 they were charged (their frozen entry_fee_paid), not the config 100.
    expect(db.credits.filter((c) => c.user_id === 'late')).toEqual([{ user_id: 'late', amount: 150 }]);
    expect(db.credits.filter((c) => c.user_id === 'u1')).toEqual([{ user_id: 'u1', amount: 125 }]);
    expect(db.credits.filter((c) => c.user_id === 'u2')).toEqual([{ user_id: 'u2', amount: 125 }]);
    expect(db.parts.some((p) => p.user_id === 'late')).toBe(false);
  });

  it('a stranded join on a FAILED heist is still refunded its frozen fee (forfeit applies only to the frozen crew)', async () => {
    // A failed heist forfeits the FROZEN crew's fees (nothing credited), but a
    // stranded late join was never in the crew — it must get its debited fee back
    // on a failed outcome too. refund_each is NULL on a failed heist, so this only
    // works because the refund reads the per-row frozen entry_fee_paid.
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'failed', payoutEach: 0,
      participants: ['u1', 'u2'], targetPayout: 250,
    });
    db.parts.push({
      heist_id: 'h1', user_id: 'late', role: 'Hacker', payout: 0,
      paid_at: null, payout_failed: false, claimed_at: null,
      entry_fee_paid: 100,
    } as any);    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await mgr.resumePendingHeists('g1');

    expect(db.heist.status).toBe('failed');
    // Frozen crew forfeit (no credit)…
    expect(db.credits.filter((c) => c.user_id === 'u1')).toHaveLength(0);
    expect(db.credits.filter((c) => c.user_id === 'u2')).toHaveLength(0);
    // …but the stranded joiner is refunded its frozen fee, never forfeited.
    expect(db.credits.filter((c) => c.user_id === 'late')).toEqual([{ user_id: 'late', amount: 100 }]);
    expect(db.parts.some((p) => p.user_id === 'late')).toBe(false);
    // Failure still announced once.
    expect(send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Failed'))).toHaveLength(1);
  });

  it('a failed stranded-join reconcile leaves the heist in_progress and retries (never strands a fee)', async () => {
    // A transient reconcile RPC error must be treated like the frozen-crew read
    // failure: retryable, NEVER a terminal flip that would strand the late
    // joiner's fee. The heist stays in_progress; a resume once the failure heals
    // reconciles + refunds and finalises.
    const failReconcile = { on: true };
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'success', payoutEach: 125,
      participants: ['u1', 'u2'], targetPayout: 250, failReconcile,
    });
    db.parts.push({ heist_id: 'h1', user_id: 'late', role: 'Hacker', payout: 0, paid_at: null, payout_failed: false, claimed_at: null, entry_fee_paid: 100 });    const { client, send } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);

    await resolve(mgr); // reconcile errors → must NOT finalise, must NOT credit

    expect(db.heist.status).toBe('in_progress');
    expect(db.heist.resolution).toBe('success');
    expect(db.credits).toHaveLength(0);
    expect(send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'))).toHaveLength(0);

    // The failure heals; the next resume reconciles the stranded fee once, pays
    // the frozen crew, and finalises.
    failReconcile.on = false;
    await mgr.resumePendingHeists('g1');

    expect(db.heist.status).toBe('success');
    expect(db.credits.filter((c) => c.user_id === 'late')).toEqual([{ user_id: 'late', amount: 100 }]);
    expect(db.credits.filter((c) => c.user_id === 'u1')).toHaveLength(1);
    expect(db.credits.filter((c) => c.user_id === 'u2')).toHaveLength(1);
    expect(send.mock.calls.filter(
      (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'))).toHaveLength(1);
  });

  // ── Newest finding (codex :617): a transient claim error re-arms resolution ──
  it('a transient claim error schedules an in-process retry that then claims and settles', async () => {
    vi.useFakeTimers();
    try {
      // The expiry timer fires, but heist_claim_for_resolution errors transiently.
      // The row is still 'recruiting' and expired, and resolveHeist already deleted
      // the only scheduled resolve timer — so without a re-arm the guild is blocked
      // until the next restart. The bot must schedule an in-process retry that
      // re-enters resolveHeist and claims once the blip heals.
      const failClaim = { on: true };
      const db = makeStatefulDb({
        status: 'recruiting', participants: ['u1', 'u2'], successChance: 100,
        targetPayout: 250, failClaim,
      });
      const { client, send } = makeClient();
      const mgr = new HeistManager(db.supabase as any, client as any);

      await resolve(mgr); // claim errors → still recruiting, in-process retry scheduled

      expect(db.heist.status).toBe('recruiting'); // NOT terminalized, NOT guessed
      expect(db.credits).toHaveLength(0);
      expect(send.mock.calls.filter(
        (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist'))).toHaveLength(0);

      // The blip heals; advancing past the backoff fires the retry, which claims,
      // pays both, and finalises — no restart needed.
      failClaim.on = false;
      await vi.advanceTimersByTimeAsync(1_500); // first backoff is 1s

      expect(db.heist.status).toBe('success');
      expect(db.credits).toHaveLength(2);
      expect(db.credits.map((c) => c.user_id).sort()).toEqual(['u1', 'u2']);
      expect(send.mock.calls.filter(
        (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Newest finding (codex :631): a transient claim-lost re-read error retries ──
  it('a transient claim-lost re-read error schedules a retry instead of stranding an in_progress heist', async () => {
    vi.useFakeTimers();
    try {
      // Our stale read saw 'recruiting', but a concurrent resolver won the claim
      // (loseClaim → claimed:false). We must re-read to learn whether the winner
      // finished or crashed mid-resolution (in_progress). That re-read errors
      // transiently. If the winner then dies after claiming, the row is left
      // in_progress and /heist start treats it as active — so the bot must schedule
      // a retry, not return terminally. The winner's frozen success decision is
      // already stamped on the row.
      const failHeistRead = { on: true };
      const loseClaim = { on: true };
      const db = makeStatefulDb({
        status: 'in_progress', resolution: 'success', payoutEach: 125,
        participants: ['u1', 'u2'], targetPayout: 250, failHeistRead, loseClaim,
      });
      // Present a 'recruiting' snapshot to resolveHeist's INITIAL read so it takes
      // the claim path (then loses the claim). The underlying row's frozen success
      // decision is what a retry will read once the re-read heals.
      db.heist.status = 'recruiting';
      const { client, send } = makeClient();
      const mgr = new HeistManager(db.supabase as any, client as any);

      await resolve(mgr); // claim lost → re-read errors → retry scheduled, no finalise

      // Neither finalised nor credited on a read we could not perform.
      expect(db.credits).toHaveLength(0);
      expect(send.mock.calls.filter(
        (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist'))).toHaveLength(0);

      // The read heals and the winner "committed" the in_progress row (stop losing
      // the claim so the retry takes the direct in_progress branch); the retry
      // re-reads it, finishes the frozen success payout, and finalises once.
      failHeistRead.on = false;
      loseClaim.on = false;
      db.heist.status = 'in_progress';
      await vi.advanceTimersByTimeAsync(1_500); // first backoff is 1s

      expect(db.heist.status).toBe('success');
      expect(db.credits).toHaveLength(2);
      expect(db.credits.map((c) => c.user_id).sort()).toEqual(['u1', 'u2']);
      expect(send.mock.calls.filter(
        (c: any[]) => String(c[0]?.embeds?.[0]?.data?.title ?? '').includes('Heist Success'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Derive-from-rows: settle of an already-reconciled joiner is a clean
  //    'reconciled' no-op — no ghost is possible because there is no array. ──
  it('heist_settle_missed_join returns reconciled (and does not double-refund) when the row is already gone', async () => {
    // Model the race: the resolver's bulk reconcile already deleted + refunded the
    // late joiner's participant ROW (so no row exists). Pre-refactor this test
    // guarded against a GHOST left in participants[] by array_append; that array no
    // longer exists (20260710180000), so crew membership is derived purely from the
    // rows — a deleted row is fully gone from the crew with nothing else to fix.
    // settle must simply observe the missing row, return 'reconciled', and NOT
    // refund again.
    const db = makeStatefulDb({
      status: 'in_progress', resolution: 'success', payoutEach: 125,
      participants: ['u1', 'u2'], targetPayout: 250,
    });
    const { supabase } = db;

    const res = await supabase.rpc('heist_settle_missed_join', {
      p_heist_id: 'h1', p_user_id: 'late', p_refund_amount: 100,
    });

    // Reconciled (no row to settle), and no ghost is possible — the crew is the
    // row set, and 'late' has no row.
    expect(res.data).toBe('reconciled');
    expect(db.parts.some((p) => p.user_id === 'late')).toBe(false);
    // No second refund: the bulk reconcile already paid it.
    expect(db.credits.filter((c) => c.user_id === 'late')).toHaveLength(0);
  });

  // ── Root serialization (codex heist-manager.ts:797): a join that races
  //    resolution is SERIALIZED at the heist-row lock — it cannot strand a fee. ─
  it('heist_join once resolution has started is rejected and debits nothing (no stranded fee)', async () => {
    // Model the exact race the sweep could never fully close: the claim already
    // won the heist-row lock and flipped status out of 'recruiting'. A /heist join
    // that arrives now calls heist_join, which re-checks the status under the SAME
    // lock and returns 'not_recruiting' — WITHOUT debiting. There is no window in
    // which a fee is debited but the seat is stranded: a post-recruiting insert is
    // structurally impossible.
    const db = makeStatefulDb({ status: 'in_progress', resolution: 'success', payoutEach: 125, participants: ['u1', 'u2'], targetPayout: 250 });
    const { supabase } = db;

    const res = await supabase.rpc('heist_join', {
      p_heist_id: 'h1', p_user_id: 'late', p_role: 'Hacker',
      p_entry_fee: 100, p_max: 8, p_base_chance: 40,
    });
    const row = (res.data as any[])[0];

    // Rejected, nothing charged, no participant row created (the row IS the
    // membership now — no separate array slot to check).
    expect(row.status).toBe('not_recruiting');
    expect(db.credits).toHaveLength(0); // no debit, no refund — the fee was never taken
    expect(db.parts.some((p) => p.user_id === 'late')).toBe(false);
  });

  it('a join that commits before the claim is admitted, then frozen into the crew (serialized both ways)', async () => {
    // The other order: heist_join wins the lock first (heist still recruiting), so
    // it debits + inserts. The subsequent claim stamps every claimed_at IS NULL
    // row — including this one — so the member is in the frozen crew and paid on
    // success. No strand in EITHER commit order.
    const db = makeStatefulDb({ status: 'recruiting', participants: ['u1'], successChance: 40, targetPayout: 300 });
    const { supabase } = db;

    const res = await supabase.rpc('heist_join', {
      p_heist_id: 'h1', p_user_id: 'u2', p_role: 'Muscle',
      p_entry_fee: 100, p_max: 8, p_base_chance: 40,
    });
    expect((res.data as any[])[0].status).toBe('joined');

    const { client } = makeClient();
    const mgr = new HeistManager(db.supabase as any, client as any);
    await resolve(mgr); // claim freezes BOTH u1 and the just-joined u2, pays success

    expect(db.heist.status).toBe('success');
    // u2 (joined before the claim) is in the frozen crew and paid a share — never stranded.
    expect(db.credits.filter((c) => c.user_id === 'u2' && c.amount > 0)).toHaveLength(1);
    expect(db.parts.some((p) => p.user_id === 'u2' && p.claimed_at != null)).toBe(true);
  });

  // ── Derived chance after undo (drift-free by construction) ──────────────────
  // The mutable success_chance counter is GONE — chance is derived from the row
  // COUNT at the point of use (LEAST(95, GREATEST(0, base + (n-1)*7))). So an undo
  // has nothing to recompute: it just deletes the row, and the very next
  // derivation reads one fewer row. This is drift-free whether or not the value
  // was capped — the class of bug the old naive -7 counter caused (codex
  // 20260710160000:385) is now structurally impossible.
  const deriveChance = (base: number, n: number) => Math.min(95, Math.max(0, base + (n - 1) * 7));

  it('after undoing a join from a capped crew, the DERIVED chance is exact (no -7 drift)', async () => {
    // 9 members at base 40 → derived min(95, 40 + 8*7) = min(95, 96) = 95, CAPPED.
    // Undo one → 8 members remain → derived min(95, 40 + 7*7) = 89, NOT the naive
    // capped 95 - 7 = 88 the old counter produced. The value is never stored; it is
    // computed from the surviving row count.
    const db = makeStatefulDb({
      status: 'recruiting',
      participants: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9'],
      successChance: 40, // base_success_chance anchor
    });
    const { supabase } = db;
    // Pre-condition: 9 rows → derived chance is capped at 95.
    expect(deriveChance(40, db.parts.length)).toBe(95);

    const res = await supabase.rpc('heist_undo_join', {
      p_heist_id: 'h1', p_user_id: 'u9', p_refund_amount: 100, p_base_chance: 40,
    });

    expect(res.data).toBe('undone');
    // The row is deleted — the crew is now the 8 surviving rows.
    expect(db.parts.some((p) => p.user_id === 'u9')).toBe(false);
    expect(db.parts.length).toBe(8);
    // Derived from the surviving count: min(95, 40 + 7*7) = 89 (never 88).
    expect(deriveChance(40, db.parts.length)).toBe(89);
    // The undone member is refunded their frozen fee exactly once.
    expect(db.credits.filter((c) => c.user_id === 'u9')).toEqual([{ user_id: 'u9', amount: 100 }]);
  });

  it('after undoing a join below the cap, the DERIVED chance is exact (small crew)', async () => {
    // 3 members → derived 40 + 2*7 = 54. Undo one → 2 rows → 40 + 1*7 = 47.
    const db = makeStatefulDb({
      status: 'recruiting', participants: ['u1', 'u2', 'u3'], successChance: 40,
    });
    const { supabase } = db;
    expect(deriveChance(40, db.parts.length)).toBe(54);

    const res = await supabase.rpc('heist_undo_join', {
      p_heist_id: 'h1', p_user_id: 'u3', p_refund_amount: 100, p_base_chance: 40,
    });

    expect(res.data).toBe('undone');
    expect(db.parts.length).toBe(2);
    expect(deriveChance(40, db.parts.length)).toBe(47);
  });

  // ── ONE SOURCE OF TRUTH: crew + count + membership + chance derive from the
  //    participant ROWS; no participants[] array and no stored counter remain. ──
  describe('derive-from-rows model (20260710180000)', () => {
    it('heist_join derives member_count + success_chance from the rows, storing neither on the heist', async () => {
      // Start with a single-member recruiting heist (base 40). Two more join.
      const db = makeStatefulDb({ status: 'recruiting', participants: ['u1'], successChance: 40 });
      const { supabase } = db;

      const j2 = (await supabase.rpc('heist_join', {
        p_heist_id: 'h1', p_user_id: 'u2', p_role: 'Muscle',
        p_entry_fee: 100, p_max: 8, p_base_chance: 40,
      })).data[0];
      // 2 rows → count 2, derived chance min(95, 40 + 1*7) = 47.
      expect(j2.status).toBe('joined');
      expect(j2.member_count).toBe(2);
      expect(j2.success_chance).toBe(47);

      const j3 = (await supabase.rpc('heist_join', {
        p_heist_id: 'h1', p_user_id: 'u3', p_role: 'Lookout',
        p_entry_fee: 100, p_max: 8, p_base_chance: 40,
      })).data[0];
      // 3 rows → count 3, derived chance 40 + 2*7 = 54.
      expect(j3.member_count).toBe(3);
      expect(j3.success_chance).toBe(54);

      // Count is the ROW count; nothing was written back to the heist row.
      expect(db.parts.length).toBe(3);
      expect('participants' in db.heist).toBe(false);   // no denormalized array
      expect('success_chance' in db.heist).toBe(false); // no stored counter
      // The immutable anchor is the ONLY chance field on the row.
      expect(db.heist.base_success_chance).toBe(40);
    });

    it('heist_join derives the success_chance CAP from the row count (no counter to overshoot)', async () => {
      // A crew already large enough that the next join is capped at 95. base 40:
      // 8 rows → 40 + 7*7 = 89; 9 rows → 40 + 8*7 = 96 → clamped 95.
      const db = makeStatefulDb({
        status: 'recruiting',
        participants: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'],
        successChance: 40,
      });
      const { supabase } = db;

      const j9 = (await supabase.rpc('heist_join', {
        p_heist_id: 'h1', p_user_id: 'u9', p_role: 'Driver',
        p_entry_fee: 100, p_max: 12, p_base_chance: 40,
      })).data[0];

      expect(j9.member_count).toBe(9);
      expect(j9.success_chance).toBe(95); // clamped, derived from the 9-row count
    });

    it('membership is derived from a row: already_joined keys off the rows, not an array', async () => {
      const db = makeStatefulDb({ status: 'recruiting', participants: ['u1', 'u2'], successChance: 40 });
      const { supabase } = db;

      // u2 already has a row → already_joined, no debit.
      const dup = (await supabase.rpc('heist_join', {
        p_heist_id: 'h1', p_user_id: 'u2', p_role: 'Muscle',
        p_entry_fee: 100, p_max: 8, p_base_chance: 40,
      })).data[0];
      expect(dup.status).toBe('already_joined');
      expect(db.credits).toHaveLength(0);        // nothing charged
      expect(db.parts.length).toBe(2);           // no duplicate row
      // Derived current chance for the 2-row crew.
      expect(dup.success_chance).toBe(47);
    });

    it('crew_full keys off the ROW count, not an array length', async () => {
      const db = makeStatefulDb({ status: 'recruiting', participants: ['u1', 'u2'], successChance: 40 });
      const { supabase } = db;

      const full = (await supabase.rpc('heist_join', {
        p_heist_id: 'h1', p_user_id: 'u3', p_role: 'Muscle',
        p_entry_fee: 100, p_max: 2, p_base_chance: 40, // max already reached by the 2 rows
      })).data[0];
      expect(full.status).toBe('crew_full');
      expect(db.credits).toHaveLength(0);
      expect(db.parts.length).toBe(2); // rejected without inserting
    });
  });
});
