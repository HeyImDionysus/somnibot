/**
 * Reconciliation — grace-period expiry lifecycle (W2 hardening).
 *
 * Expired-grace entitlements must be transitioned deterministically:
 *  - the status update is guarded on `status = 'grace_period'` so a
 *    concurrently reactivated entitlement (payment recovered) is never
 *    clobbered back to expired;
 *  - every transition writes an audit_logs row and resolves the operator
 *    "entitlement in grace" alert;
 *  - role revocation that fails inline is queued as a durable
 *    `revoke_roles` bot action instead of being silently dropped;
 *  - a failure in the earlier active-entitlement sweep must not prevent
 *    the grace-expiry sweep from running.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { runReconciliation } from '../services/reconciliation.js';

// ── Scriptable Supabase mock ──────────────────────────────
//
// Each `.from()` call produces a context recording the table, operation,
// values, and filters. Awaiting the chain resolves via the test-provided
// responder, so select/update/insert on the same table can be scripted
// independently and every filter can be asserted on.

interface QueryCtx {
  table: string;
  op: 'select' | 'update' | 'insert';
  values?: unknown;
  filters: Array<[string, ...unknown[]]>;
}

type Responder = (ctx: QueryCtx) => { data?: unknown; error?: unknown } | Promise<{ data?: unknown; error?: unknown }>;

function makeSupabase(respond: Responder) {
  const calls: QueryCtx[] = [];
  const from = vi.fn((table: string) => {
    const ctx: QueryCtx = { table, op: 'select', filters: [] };
    calls.push(ctx);
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.update = vi.fn((values: unknown) => {
      ctx.op = 'update';
      ctx.values = values;
      return chain;
    });
    chain.insert = vi.fn((values: unknown) => {
      ctx.op = 'insert';
      ctx.values = values;
      return chain;
    });
    for (const m of ['eq', 'neq', 'lt', 'gt', 'gte', 'lte', 'in', 'is', 'or', 'not']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        ctx.filters.push([m, ...args]);
        return chain;
      });
    }
    for (const m of ['order', 'limit', 'range']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.single = vi.fn(async () => respond(ctx));
    chain.then = (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => respond(ctx))
        .then(resolve, reject);
    return chain;
  });
  return { from, calls };
}

function makeGuild(opts: { hasRole?: boolean; removeError?: Error; fetchError?: Error } = {}) {
  const remove = opts.removeError
    ? vi.fn().mockRejectedValue(opts.removeError)
    : vi.fn().mockResolvedValue(undefined);
  const member = {
    roles: {
      cache: { has: vi.fn().mockReturnValue(opts.hasRole ?? true) },
      add: vi.fn().mockResolvedValue(undefined),
      remove,
    },
  };
  const fetch = opts.fetchError
    ? vi.fn().mockRejectedValue(opts.fetchError)
    : vi.fn().mockResolvedValue(member);
  return {
    id: 'g1',
    members: { fetch },
    roles: { cache: { get: vi.fn().mockReturnValue({ id: 'r1' }) } },
    member,
  };
}

const GRACE_ENT = {
  id: 'e1',
  customer_id: 'c1',
  granted_role_ids: ['r1'],
  product_id: 'p1',
  license_key_id: 'lk1',
  grace_period_ends_at: '2026-07-08T00:00:00.000Z',
};

/**
 * Standard responder: no active entitlements, one lapsed grace entitlement,
 * no stale sessions. Individual behaviors are overridable.
 */
function makeResponder(overrides: {
  graceRows?: unknown[];
  updateResult?: { data?: unknown; error?: unknown };
  activeSweepError?: Error;
  queueError?: { message: string };
} = {}): { respond: Responder } {
  const respond: Responder = (ctx) => {
    if (ctx.table === 'reconciliation_runs') {
      return ctx.op === 'insert' ? { data: { id: 'run1' }, error: null } : { data: null, error: null };
    }
    if (ctx.table === 'entitlements' && ctx.op === 'select') {
      const statusFilter = ctx.filters.find(([m, col]) => m === 'eq' && col === 'status');
      if (statusFilter?.[2] === 'active') {
        if (overrides.activeSweepError) throw overrides.activeSweepError;
        return { data: [], error: null };
      }
      if (statusFilter?.[2] === 'grace_period') {
        return { data: overrides.graceRows ?? [GRACE_ENT], error: null };
      }
      return { data: [], error: null };
    }
    if (ctx.table === 'entitlements' && ctx.op === 'update') {
      return overrides.updateResult ?? { data: [{ id: 'e1' }], error: null };
    }
    if (ctx.table === 'customers') {
      return { data: [{ id: 'c1', discord_id: 'u1' }], error: null };
    }
    if (ctx.table === 'bot_action_queue') {
      return { data: null, error: overrides.queueError ?? null };
    }
    if (ctx.table === 'license_sessions') {
      return { data: [], error: null };
    }
    return { data: null, error: null };
  };
  return { respond };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runReconciliation — grace-period expiry', () => {
  it('transitions a lapsed grace entitlement with a status-guarded update, audit trail, alert resolution, and role revocation', async () => {
    const { respond } = makeResponder();
    const supabase = makeSupabase(respond);
    const guild = makeGuild();

    const findings = await runReconciliation(guild as never, supabase as never, 'scheduled');

    expect(findings.grace_periods_expired).toBe(1);

    // Status transition is guarded on the current status — a concurrent
    // reactivation must never be clobbered (TOCTOU).
    const update = supabase.calls.find((c) => c.table === 'entitlements' && c.op === 'update');
    expect(update).toBeDefined();
    expect(update!.values).toMatchObject({ status: 'expired' });
    expect(update!.filters).toContainEqual(['eq', 'id', 'e1']);
    expect(update!.filters).toContainEqual(['eq', 'status', 'grace_period']);

    // Audit trail for the automatic revocation, including when the grace
    // window actually ended.
    const audit = supabase.calls.find((c) => c.table === 'audit_logs' && c.op === 'insert');
    expect(audit).toBeDefined();
    expect(audit!.values).toMatchObject({
      guild_id: 'g1',
      actor_type: 'system',
      action: 'entitlement.grace_expired',
      target_type: 'entitlement',
      target_id: 'e1',
      details: expect.objectContaining({
        grace_period_ends_at: '2026-07-08T00:00:00.000Z',
      }),
    });

    // The operator "entitlement in grace" alert is resolved — terminal state.
    const alertResolve = supabase.calls.find((c) => c.table === 'alerts' && c.op === 'update');
    expect(alertResolve).toBeDefined();
    expect(alertResolve!.values).toMatchObject({ resolved: true });
    expect(alertResolve!.filters).toContainEqual(['eq', 'alert_type', 'entitlement_grace_period']);
    expect(alertResolve!.filters).toContainEqual(['eq', 'metadata->>entitlement_id', 'e1']);

    // Roles revoked inline; nothing queued because it succeeded.
    expect(guild.member.roles.remove).toHaveBeenCalledWith('r1', expect.stringContaining('grace'));
    expect(supabase.calls.find((c) => c.table === 'bot_action_queue')).toBeUndefined();
  });

  it('deactivates the entitlement license sessions on transition (parity with EntitlementService.revoke)', async () => {
    const { respond } = makeResponder();
    const supabase = makeSupabase(respond);
    const guild = makeGuild();

    await runReconciliation(guild as never, supabase as never);

    const sessionUpdate = supabase.calls.find(
      (c) => c.table === 'license_sessions' && c.op === 'update',
    );
    expect(sessionUpdate).toBeDefined();
    // CHECK-constraint-safe reason (license_sessions.deactivation_reason).
    expect(sessionUpdate!.values).toMatchObject({
      active: false,
      deactivation_reason: 'entitlement_revoked',
    });
    expect(sessionUpdate!.filters).toContainEqual(['eq', 'license_key_id', 'lk1']);
    expect(sessionUpdate!.filters).toContainEqual(['eq', 'active', true]);
    // license_sessions has NO guild_id column — filtering on it makes
    // PostgREST reject the whole update (the key id is already guild-scoped
    // via the entitlement).
    expect(sessionUpdate!.filters.some(([, col]) => col === 'guild_id')).toBe(false);
  });

  it('does not touch license sessions when the entitlement has no license key', async () => {
    const { respond } = makeResponder({ graceRows: [{ ...GRACE_ENT, license_key_id: null }] });
    const supabase = makeSupabase(respond);
    const guild = makeGuild();

    const findings = await runReconciliation(guild as never, supabase as never);

    expect(findings.grace_periods_expired).toBe(1);
    expect(
      supabase.calls.find((c) => c.table === 'license_sessions' && c.op === 'update'),
    ).toBeUndefined();
  });

  it('skips an entitlement that was concurrently reactivated (guarded update matches zero rows)', async () => {
    const { respond } = makeResponder({ updateResult: { data: [], error: null } });
    const supabase = makeSupabase(respond);
    const guild = makeGuild();

    const findings = await runReconciliation(guild as never, supabase as never);

    expect(findings.grace_periods_expired).toBe(0);
    expect(supabase.calls.find((c) => c.table === 'audit_logs')).toBeUndefined();
    expect(guild.member.roles.remove).not.toHaveBeenCalled();
  });

  it('queues a durable revoke_roles action when inline role removal fails', async () => {
    const { respond } = makeResponder();
    const supabase = makeSupabase(respond);
    const guild = makeGuild({ removeError: new Error('Missing Permissions') });

    const findings = await runReconciliation(guild as never, supabase as never);

    expect(findings.grace_periods_expired).toBe(1);
    const queued = supabase.calls.find((c) => c.table === 'bot_action_queue' && c.op === 'insert');
    expect(queued).toBeDefined();
    expect(queued!.values).toMatchObject({
      guild_id: 'g1',
      action: 'revoke_roles',
      status: 'pending',
      payload: expect.objectContaining({
        discord_id: 'u1',
        role_ids: ['r1'],
        reason: 'grace_period_expired',
        entitlement_id: 'e1',
      }),
    });
  });

  it('queues revocation for the full role set when the member fetch fails transiently', async () => {
    const { respond } = makeResponder();
    const supabase = makeSupabase(respond);
    const guild = makeGuild({ fetchError: new Error('connect ETIMEDOUT') });

    const findings = await runReconciliation(guild as never, supabase as never);

    expect(findings.grace_periods_expired).toBe(1);
    const queued = supabase.calls.find((c) => c.table === 'bot_action_queue' && c.op === 'insert');
    expect(queued).toBeDefined();
    expect(queued!.values).toMatchObject({
      action: 'revoke_roles',
      payload: expect.objectContaining({ role_ids: ['r1'] }),
    });
  });

  it('does not queue revocation when the member has left the guild (roles are gone with membership)', async () => {
    const { respond } = makeResponder();
    const supabase = makeSupabase(respond);
    const guild = makeGuild({ fetchError: new Error('Unknown Member') });

    const findings = await runReconciliation(guild as never, supabase as never);

    expect(findings.grace_periods_expired).toBe(1);
    expect(supabase.calls.find((c) => c.table === 'bot_action_queue')).toBeUndefined();
    // Transition + audit still happened.
    expect(supabase.calls.find((c) => c.table === 'audit_logs' && c.op === 'insert')).toBeDefined();
  });

  it('records a queue-insert failure in findings.errors instead of dropping the revocation silently', async () => {
    const { respond } = makeResponder({ queueError: { message: 'insert failed' } });
    const supabase = makeSupabase(respond);
    const guild = makeGuild({ removeError: new Error('Missing Permissions') });

    const findings = await runReconciliation(guild as never, supabase as never);

    expect(findings.grace_periods_expired).toBe(1);
    expect(findings.errors.some((e) => e.includes('insert failed'))).toBe(true);
  });

  it('still expires lapsed grace entitlements when the active-entitlement sweep throws', async () => {
    const { respond } = makeResponder({ activeSweepError: new Error('boom in sweep 1') });
    const supabase = makeSupabase(respond);
    const guild = makeGuild();

    const findings = await runReconciliation(guild as never, supabase as never);

    expect(findings.errors.some((e) => e.includes('boom in sweep 1'))).toBe(true);
    expect(findings.grace_periods_expired).toBe(1);
  });

  it('uses the injected clock for the grace-window cutoff', async () => {
    vi.useFakeTimers();
    const frozen = new Date('2026-07-09T00:00:00.000Z');
    vi.setSystemTime(frozen);

    const { respond } = makeResponder();
    const supabase = makeSupabase(respond);
    const guild = makeGuild();

    await runReconciliation(guild as never, supabase as never);

    const graceSelect = supabase.calls.find(
      (c) =>
        c.table === 'entitlements' &&
        c.op === 'select' &&
        c.filters.some(([m, col, val]) => m === 'eq' && col === 'status' && val === 'grace_period'),
    );
    expect(graceSelect).toBeDefined();
    expect(graceSelect!.filters).toContainEqual(['lt', 'grace_period_ends_at', frozen.toISOString()]);
  });
});
