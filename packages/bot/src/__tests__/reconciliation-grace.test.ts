/**
 * Reconciliation — grace-period expiry lifecycle (W2 hardening).
 *
 * Expired-grace entitlements must be transitioned deterministically:
 *  - the status update is guarded on `status = 'grace_period'` so a
 *    concurrently reactivated entitlement (payment recovered) is never
 *    clobbered back to expired;
 *  - every transition writes an audit_logs row and resolves the operator
 *    "entitlement in grace" alert;
 *  - paid role revocation is owned by the status trigger's durable,
 *    identity-rich `revoke_roles` action rather than duplicated inline;
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
      chain[m] = vi.fn((...args: unknown[]) => {
        ctx.filters.push([m, ...args]);
        return chain;
      });
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
  order_id: 'order-1',
  license_key_id: 'lk1',
  grace_period_ends_at: '2026-07-08T00:00:00.000Z',
  source: 'purchase',
  type: 'subscription',
};

/**
 * Standard responder: no active entitlements, one lapsed grace entitlement,
 * no stale sessions. Individual behaviors are overridable.
 */
function makeResponder(overrides: {
  graceRows?: unknown[];
  updateResult?: { data?: unknown; error?: unknown };
  activeSweepError?: Error;
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
      return { data: [{ id: 'c1', guild_id: 'g1', discord_id: 'u1' }], error: null };
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
  it('transitions a lapsed grace entitlement with a guarded update and leaves paid role removal to the trigger', async () => {
    const { respond } = makeResponder();
    const supabase = makeSupabase(respond);
    const guild = makeGuild();

    const findings = await runReconciliation(guild as never, supabase as never, 'scheduled');

    expect(findings.grace_periods_expired).toBe(1);

    // Status transition is guarded on the current status — a concurrent
    // reactivation must never be clobbered (TOCTOU) — and re-checks the
    // deadline so a row that re-entered a NEW grace window (reactivate +
    // suspend between the page query and this update) is never expired
    // while its fresh window is still open.
    const update = supabase.calls.find((c) => c.table === 'entitlements' && c.op === 'update');
    expect(update).toBeDefined();
    expect(update!.values).toMatchObject({ status: 'expired' });
    expect(update!.filters).toContainEqual(['eq', 'id', 'e1']);
    expect(update!.filters).toContainEqual(['eq', 'status', 'grace_period']);
    expect(
      update!.filters.some(([m, col]) => m === 'lt' && col === 'grace_period_ends_at'),
    ).toBe(true);

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

    // The real database status update atomically writes the identity-rich queue
    // row. This unit mock does not execute triggers; it proves reconciliation
    // performs no competing Discord mutation or partial fallback insert.
    expect(guild.member.roles.remove).not.toHaveBeenCalled();
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

  it('preserves a malformed grace row before any terminal transition', async () => {
    const { respond } = makeResponder({
      graceRows: [{ ...GRACE_ENT, granted_role_ids: ['r1', 'r1'] }],
    });
    const supabase = makeSupabase(respond);

    const findings = await runReconciliation(makeGuild() as never, supabase as never);

    expect(findings.grace_periods_expired).toBe(0);
    expect(findings.errors.some((error) => error.includes('row is malformed'))).toBe(true);
    expect(supabase.calls.find(
      (ctx) => ctx.table === 'entitlements' && ctx.op === 'update',
    )).toBeUndefined();
  });

  it('does not count malformed transition evidence as an expired entitlement', async () => {
    const { respond } = makeResponder({
      updateResult: { data: [{ id: 'different-entitlement' }], error: null },
    });
    const supabase = makeSupabase(respond);

    const findings = await runReconciliation(makeGuild() as never, supabase as never);

    expect(findings.grace_periods_expired).toBe(0);
    expect(findings.errors.some((error) => error.includes('malformed evidence'))).toBe(true);
  });

  it('does not duplicate paid revocation even when Discord removal would fail', async () => {
    const { respond } = makeResponder();
    const supabase = makeSupabase(respond);
    const guild = makeGuild({ removeError: new Error('Missing Permissions') });

    const findings = await runReconciliation(guild as never, supabase as never);

    expect(findings.grace_periods_expired).toBe(1);
    expect(guild.member.roles.remove).not.toHaveBeenCalled();
    expect(supabase.calls.find((c) => c.table === 'bot_action_queue')).toBeUndefined();
  });

  it('records an explicit operator finding when direct non-commerce cleanup cannot run', async () => {
    const { respond } = makeResponder({
      graceRows: [{ ...GRACE_ENT, source: 'manual' }],
    });
    const supabase = makeSupabase(respond);
    const guild = makeGuild({ fetchError: new Error('connect ETIMEDOUT') });

    const findings = await runReconciliation(guild as never, supabase as never);

    expect(findings.grace_periods_expired).toBe(1);
    expect(supabase.calls.find((c) => c.table === 'bot_action_queue')).toBeUndefined();
    expect(findings.errors).toContain(
      'Entitlement e1: non-commerce role revocation requires operator reconciliation for role(s): r1',
    );
  });

  it('preserves anomalous non-commerce access for explicit operator reconciliation', async () => {
    const { respond } = makeResponder({
      graceRows: [{ ...GRACE_ENT, source: 'manual' }],
    });
    const supabase = makeSupabase(respond);
    const guild = makeGuild({ fetchError: new Error('Unknown Member') });

    const findings = await runReconciliation(guild as never, supabase as never);

    expect(findings.grace_periods_expired).toBe(1);
    expect(supabase.calls.find((c) => c.table === 'bot_action_queue')).toBeUndefined();
    expect(guild.members.fetch).not.toHaveBeenCalled();
    expect(findings.errors.some((error) => error.includes('operator reconciliation'))).toBe(true);
    // Transition + audit still happened.
    expect(supabase.calls.find((c) => c.table === 'audit_logs' && c.op === 'insert')).toBeDefined();
  });

  it('records direct non-commerce role-removal failure in findings.errors', async () => {
    const { respond } = makeResponder({
      graceRows: [{ ...GRACE_ENT, source: 'manual' }],
    });
    const supabase = makeSupabase(respond);
    const guild = makeGuild({ removeError: new Error('Missing Permissions') });

    const findings = await runReconciliation(guild as never, supabase as never);

    expect(findings.grace_periods_expired).toBe(1);
    expect(findings.errors.some((e) => e.includes('operator reconciliation'))).toBe(true);
    expect(supabase.calls.find((c) => c.table === 'bot_action_queue')).toBeUndefined();
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

    // The guarded update re-checks the deadline against the same cutoff.
    const update = supabase.calls.find((c) => c.table === 'entitlements' && c.op === 'update');
    expect(update).toBeDefined();
    expect(update!.filters).toContainEqual(['lt', 'grace_period_ends_at', frozen.toISOString()]);
  });

  it('uses strict ID keysets to scan beyond 1000 rows in all three reconciliation lanes', async () => {
    const activeFirst = Array.from({ length: 1_000 }, (_, index) => ({
      id: `active-${String(index).padStart(4, '0')}`,
      customer_id: 'c1',
      granted_role_ids: [],
      product_id: 'p1',
      customers: { id: 'c1', guild_id: 'g1', discord_id: 'u1' },
    }));
    const activeLast = { ...activeFirst[0], id: 'active-1000' };
    const graceFirst = Array.from({ length: 1_000 }, (_, index) => ({
      ...GRACE_ENT,
      id: `grace-${String(index).padStart(4, '0')}`,
      customer_id: `customer-${String(index).padStart(4, '0')}`,
    }));
    const graceLast = { ...GRACE_ENT, id: 'grace-1000', customer_id: 'customer-1000' };
    const sessionFirst = Array.from({ length: 1_000 }, (_, index) => ({
      id: `session-${String(index).padStart(4, '0')}`,
      last_seen_at: new Date().toISOString(),
      license_key_id: `key-${index}`,
      license_keys: { product_id: `product-${String(index).padStart(4, '0')}`, guild_id: 'g1' },
    }));
    const sessionLast = {
      id: 'session-1000',
      last_seen_at: new Date().toISOString(),
      license_key_id: 'key-1000',
      license_keys: { product_id: 'product-1000', guild_id: 'g1' },
    };

    const respond: Responder = (ctx) => {
      if (ctx.table === 'reconciliation_runs') {
        return ctx.op === 'insert' ? { data: { id: 'run-keyset' }, error: null } : { data: null, error: null };
      }
      if (ctx.table === 'entitlements' && ctx.op === 'select') {
        const status = ctx.filters.find(([method, column]) => method === 'eq' && column === 'status')?.[2];
        const cursor = ctx.filters.find(([method, column]) => method === 'gt' && column === 'id')?.[2];
        if (status === 'active') {
          return { data: cursor === undefined ? activeFirst : [activeLast], error: null };
        }
        if (status === 'grace_period') {
          return { data: cursor === undefined ? graceFirst : [graceLast], error: null };
        }
      }
      if (ctx.table === 'entitlements' && ctx.op === 'update') {
        return { data: [], error: null };
      }
      if (ctx.table === 'customers') {
        const customerIds = ctx.filters.find(
          ([method, column]) => method === 'in' && column === 'id',
        )?.[2] as string[] | undefined;
        return {
          data: (customerIds ?? []).map((customerId) => ({
            id: customerId,
            guild_id: 'g1',
            discord_id: `discord-${customerId}`,
          })),
          error: null,
        };
      }
      if (ctx.table === 'license_sessions' && ctx.op === 'select') {
        const cursor = ctx.filters.find(([method, column]) => method === 'gt' && column === 'id')?.[2];
        return { data: cursor === undefined ? sessionFirst : [sessionLast], error: null };
      }
      if (ctx.table === 'product_license_config') {
        const productIds = ctx.filters.find(
          ([method, column]) => method === 'in' && column === 'product_id',
        )?.[2] as string[] | undefined;
        return {
          data: (productIds ?? []).map((productId) => ({
            product_id: productId,
            offline_grace_period_seconds: 86_400,
          })),
          error: null,
        };
      }
      return { data: null, error: null };
    };
    const supabase = makeSupabase(respond);

    const findings = await runReconciliation(makeGuild() as never, supabase as never);

    expect(findings.entitlements_checked).toBe(1_001);
    const activeQueries = supabase.calls.filter((ctx) =>
      ctx.table === 'entitlements'
      && ctx.op === 'select'
      && ctx.filters.some(([method, column, value]) => method === 'eq' && column === 'status' && value === 'active'));
    const graceQueries = supabase.calls.filter((ctx) =>
      ctx.table === 'entitlements'
      && ctx.op === 'select'
      && ctx.filters.some(([method, column, value]) => method === 'eq' && column === 'status' && value === 'grace_period'));
    const sessionQueries = supabase.calls.filter((ctx) =>
      ctx.table === 'license_sessions' && ctx.op === 'select');

    expect(activeQueries).toHaveLength(2);
    expect(activeQueries[1].filters).toContainEqual(['gt', 'id', 'active-0999']);
    expect(graceQueries).toHaveLength(2);
    expect(graceQueries[1].filters).toContainEqual(['gt', 'id', 'grace-0999']);
    const customerQueries = supabase.calls.filter((ctx) => ctx.table === 'customers');
    expect(customerQueries).toHaveLength(3);
    expect((customerQueries[0].filters.find(([method]) => method === 'in')?.[2] as string[])).toHaveLength(500);
    expect((customerQueries[1].filters.find(([method]) => method === 'in')?.[2] as string[])).toHaveLength(500);
    expect((customerQueries[2].filters.find(([method]) => method === 'in')?.[2] as string[])).toHaveLength(1);
    expect(sessionQueries).toHaveLength(2);
    expect(sessionQueries[1].filters).toContainEqual(['gt', 'id', 'session-0999']);
    expect(sessionQueries[0].filters).toContainEqual(['eq', 'license_keys.guild_id', 'g1']);
    const configQueries = supabase.calls.filter((ctx) => ctx.table === 'product_license_config');
    expect(configQueries).toHaveLength(3);
    expect((configQueries[0].filters.find(([method]) => method === 'in')?.[2] as string[])).toHaveLength(500);
    expect((configQueries[1].filters.find(([method]) => method === 'in')?.[2] as string[])).toHaveLength(500);
    expect((configQueries[2].filters.find(([method]) => method === 'in')?.[2] as string[])).toHaveLength(1);
    for (const query of [...activeQueries, ...graceQueries, ...sessionQueries]) {
      expect(query.filters).toContainEqual(['order', 'id', { ascending: true }]);
      expect(query.filters).toContainEqual(['limit', 1_000]);
      expect(query.filters.some(([method]) => method === 'range')).toBe(false);
    }
  });

  it('fails all three scans closed on null or non-increasing keyset pages', async () => {
    const respond: Responder = (ctx) => {
      if (ctx.table === 'reconciliation_runs') {
        return ctx.op === 'insert' ? { data: { id: 'run-malformed' }, error: null } : { data: null, error: null };
      }
      if (ctx.table === 'entitlements' && ctx.op === 'select') {
        const status = ctx.filters.find(([method, column]) => method === 'eq' && column === 'status')?.[2];
        if (status === 'active') return { data: null, error: null };
        if (status === 'grace_period') {
          return {
            data: [
              { ...GRACE_ENT, id: 'grace-2' },
              { ...GRACE_ENT, id: 'grace-1' },
            ],
            error: null,
          };
        }
      }
      if (ctx.table === 'license_sessions' && ctx.op === 'select') {
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };
    const supabase = makeSupabase(respond);
    const guild = makeGuild();

    const findings = await runReconciliation(guild as never, supabase as never);

    expect(findings.errors.some((error) => error.includes('Active entitlement query returned a malformed result'))).toBe(true);
    expect(findings.errors.some((error) => error.includes('Grace-period query returned a malformed or non-increasing'))).toBe(true);
    expect(findings.errors.some((error) => error.includes('License-session query returned a malformed result'))).toBe(true);
    expect(findings.entitlements_checked).toBe(0);
    expect(findings.grace_periods_expired).toBe(0);
    expect(findings.sessions_timed_out).toBe(0);
    expect(supabase.calls.find((ctx) => ctx.table === 'entitlements' && ctx.op === 'update')).toBeUndefined();
    expect(supabase.calls.find((ctx) => ctx.table === 'license_sessions' && ctx.op === 'update')).toBeUndefined();
    expect(guild.members.fetch).not.toHaveBeenCalled();
  });

  it('rejects a cross-guild joined license session without deactivating it', async () => {
    const respond: Responder = (ctx) => {
      if (ctx.table === 'reconciliation_runs') {
        return ctx.op === 'insert' ? { data: { id: 'run-cross-guild' }, error: null } : { data: null, error: null };
      }
      if (ctx.table === 'entitlements') return { data: [], error: null };
      if (ctx.table === 'license_sessions' && ctx.op === 'select') {
        return {
          data: [{
            id: 'session-other-guild',
            last_seen_at: '2000-01-01T00:00:00.000Z',
            license_key_id: 'key-other-guild',
            license_keys: { product_id: 'product-other', guild_id: 'g2' },
          }],
          error: null,
        };
      }
      return { data: null, error: null };
    };
    const supabase = makeSupabase(respond);

    const findings = await runReconciliation(makeGuild() as never, supabase as never);

    const sessionSelect = supabase.calls.find(
      (ctx) => ctx.table === 'license_sessions' && ctx.op === 'select',
    );
    expect(sessionSelect?.filters).toContainEqual(['eq', 'license_keys.guild_id', 'g1']);
    expect(findings.sessions_timed_out).toBe(0);
    expect(findings.errors.some((error) => error.includes('cross-guild row'))).toBe(true);
    expect(supabase.calls.find(
      (ctx) => ctx.table === 'license_sessions' && ctx.op === 'update',
    )).toBeUndefined();
  });

  it('does not count a timed-out session when its guarded update errors', async () => {
    const respond: Responder = (ctx) => {
      if (ctx.table === 'reconciliation_runs') {
        return ctx.op === 'insert' ? { data: { id: 'run-update-error' }, error: null } : { data: null, error: null };
      }
      if (ctx.table === 'entitlements') return { data: [], error: null };
      if (ctx.table === 'license_sessions' && ctx.op === 'select') {
        return {
          data: [{
            id: 'session-stale',
            last_seen_at: '2000-01-01T00:00:00.000Z',
            license_key_id: 'key-stale',
            license_keys: { product_id: 'product-stale', guild_id: 'g1' },
          }],
          error: null,
        };
      }
      if (ctx.table === 'product_license_config') return { data: [], error: null };
      if (ctx.table === 'license_sessions' && ctx.op === 'update') {
        return { data: null, error: { message: 'database unavailable' } };
      }
      return { data: null, error: null };
    };
    const supabase = makeSupabase(respond);

    const findings = await runReconciliation(makeGuild() as never, supabase as never);

    expect(findings.sessions_timed_out).toBe(0);
    expect(findings.errors.some((error) => error.includes('timeout update failed'))).toBe(true);
  });
});
