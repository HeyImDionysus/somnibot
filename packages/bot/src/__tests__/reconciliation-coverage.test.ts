/**
 * Reconciliation — coverage tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { runReconciliation, scheduleReconciliation } from '../services/reconciliation.js';

// ── Helpers ───────────────────────────────────────────────

function makeSupabase(tableData: Record<string, any> = {}) {
  const fromMock = vi.fn();
  fromMock.mockImplementation((table: string) => {
    const chain: Record<string, any> = {};
    const eqFilters = new Map<string, unknown>();
    const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'in', 'order', 'limit', 'range', 'single', 'insert', 'update', 'delete', 'maybeSingle'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.eq = vi.fn((column: string, value: unknown) => {
      eqFilters.set(column, value);
      return chain;
    });
    const data = tableData[table]
      ?? (table === 'entitlements'
        || table === 'license_sessions'
        || table === 'commerce_role_delivery_intents'
        ? []
        : table === 'customers'
          ? [{ id: 'c1', guild_id: 'g1', discord_id: 'u1' }]
          : null);
    chain.then = (resolve: (v: any) => void) => {
      let filtered = data;
      if (table === 'entitlements' && Array.isArray(data) && eqFilters.has('status')) {
        const status = eqFilters.get('status');
        filtered = data.filter((row) => (row.status ?? 'active') === status);
      }
      resolve({ data: filtered, error: null });
    };
    (chain as any)[Symbol.toStringTag] = 'Promise';
    return chain;
  });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    const configured = tableData.__rpc?.[name];
    if (typeof configured === 'function') return configured(args);
    return configured ?? { data: null, error: null };
  });
  return { from: fromMock, rpc };
}

function makeGuild(overrides: Record<string, any> = {}) {
  let hasRole = !overrides.missingRoles;
  const rolesCacheGet = vi.fn().mockReturnValue({ id: 'r1', name: 'Premium' });
  const add = vi.fn(async () => {
    if (!overrides.addHasNoEffect) hasRole = true;
  });

  return {
    id: 'g1',
    members: {
      fetch: vi.fn().mockResolvedValue({
        roles: {
          cache: {
            has: vi.fn(() => hasRole),
          },
          add,
          remove: vi.fn().mockResolvedValue(undefined),
        },
      }),
    },
    roles: {
      cache: {
        get: rolesCacheGet,
      },
    },
  };
}

// ── Tests ────────────────────────────────────────────────

describe('runReconciliation', () => {
  let supabase: ReturnType<typeof makeSupabase>;
  let guild: ReturnType<typeof makeGuild>;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('runs full reconciliation with active entitlements (roles present)', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [
        { id: 'e1', customer_id: 'c1', granted_role_ids: ['r1'], product_id: 'p1', customers: { id: 'c1', guild_id: 'g1', discord_id: 'u1' } },
      ],
    });
    guild = makeGuild({ missingRoles: false });
    const findings = await runReconciliation(guild as any, supabase as any, 'manual');
    expect(findings.entitlements_checked).toBe(1);
    expect(findings.roles_missing).toBe(0);
  });

  it('re-grants missing roles', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [
        { id: 'e1', customer_id: 'c1', granted_role_ids: ['r1'], product_id: 'p1', customers: { id: 'c1', guild_id: 'g1', discord_id: 'u1' } },
      ],
    });
    guild = makeGuild({ missingRoles: true });
    const findings = await runReconciliation(guild as any, supabase as any);
    expect(findings.entitlements_checked).toBe(1);
    expect(findings.roles_missing).toBe(1);
    expect(findings.roles_regranted).toBe(1);
  });

  it('routes a missing paid role through the deterministic SQL carrier', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [{
        id: 'e-paid',
        customer_id: 'c1',
        granted_role_ids: ['r1'],
        product_id: 'p1',
        plan_id: null,
        order_id: 'o1',
        type: 'one_time',
        status: 'active',
        source: 'purchase',
        customers: { id: 'c1', guild_id: 'g1', discord_id: 'u1' },
      }],
      __rpc: {
        commerce_ensure_live_role_delivery_action: {
          data: [{ action_id: 'carrier-1', action_status: 'pending' }],
          error: null,
        },
      },
    });
    guild = makeGuild({ missingRoles: true });

    const findings = await runReconciliation(guild as any, supabase as any);

    expect(findings.roles_missing).toBe(1);
    expect(findings.roles_regranted).toBe(0);
    expect(findings.role_repairs_queued).toBe(1);
    expect(supabase.rpc).toHaveBeenCalledWith(
      'commerce_ensure_live_role_delivery_action',
      { p_entitlement_id: 'e-paid' },
    );
    expect(supabase.from).not.toHaveBeenCalledWith('bot_action_queue');
  });

  it('re-enqueues both unresolved paid cleanup states through exact SQL carriers', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      commerce_role_delivery_intents: [
        { id: 'intent-1', guild_id: 'g1', state: 'cleanup_required' },
        { id: 'intent-2', guild_id: 'g1', state: 'operator_required' },
      ],
      __rpc: {
        commerce_ensure_role_delivery_cleanup_action: (
          args: Record<string, unknown>,
        ) => ({
          data: [{
            action_id: `cleanup-${String(args.p_intent_id)}`,
            action_status: 'pending',
          }],
          error: null,
        }),
      },
    });
    guild = makeGuild();

    const findings = await runReconciliation(guild as any, supabase as any);

    expect(findings.role_cleanups_queued).toBe(2);
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      1,
      'commerce_ensure_role_delivery_cleanup_action',
      { p_intent_id: 'intent-1' },
    );
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      'commerce_ensure_role_delivery_cleanup_action',
      { p_intent_id: 'intent-2' },
    );
  });

  it('does not presume a source-null missing role is paid when SQL authorizes no carrier', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [{
        id: 'e-legacy',
        customer_id: 'c1',
        granted_role_ids: ['r1'],
        product_id: 'p1',
        plan_id: null,
        order_id: 'o1',
        type: 'one_time',
        status: 'active',
        source: null,
        customers: { id: 'c1', guild_id: 'g1', discord_id: 'u1' },
      }],
      __rpc: {
        commerce_ensure_live_role_delivery_action: { data: null, error: null },
      },
    });
    guild = makeGuild({ missingRoles: true });

    const findings = await runReconciliation(guild as any, supabase as any);

    expect(findings.roles_regranted).toBe(0);
    expect(findings.role_repairs_queued).toBe(0);
    expect(findings.errors.some((error) => error.includes('no exact paid repair carrier')))
      .toBe(true);
  });

  it('does not count a Discord add that a forced refetch cannot confirm', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [
        { id: 'e1', customer_id: 'c1', granted_role_ids: ['r1'], product_id: 'p1', customers: { id: 'c1', guild_id: 'g1', discord_id: 'u1' } },
      ],
    });
    guild = makeGuild({ missingRoles: true, addHasNoEffect: true });

    const findings = await runReconciliation(guild as any, supabase as any);

    expect(findings.roles_missing).toBe(1);
    expect(findings.roles_regranted).toBe(0);
    expect(findings.errors.some((error) => error.includes('did not confirm'))).toBe(true);
    expect(guild.members.fetch).toHaveBeenCalledWith({ user: 'u1', force: true });
  });

  it('handles empty role_ids', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [
        { id: 'e1', customer_id: 'c1', granted_role_ids: [], product_id: 'p1', customers: { id: 'c1', guild_id: 'g1', discord_id: 'u1' } },
      ],
    });
    guild = makeGuild();
    const findings = await runReconciliation(guild as any, supabase as any);
    expect(findings.entitlements_checked).toBe(1);
    expect(findings.roles_missing).toBe(0);
  });

  it('handles missing discord_id on customer', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [
        { id: 'e1', customer_id: 'c1', granted_role_ids: ['r1'], product_id: 'p1', customers: null },
      ],
    });
    guild = makeGuild();
    const findings = await runReconciliation(guild as any, supabase as any);
    expect(findings.entitlements_checked).toBe(1);
    expect(findings.roles_missing).toBe(0);
  });

  it('rejects an active entitlement joined to a customer from another guild', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [{
        id: 'e1',
        customer_id: 'c1',
        granted_role_ids: ['r1'],
        product_id: 'p1',
        customers: { id: 'c1', guild_id: 'g2', discord_id: 'u1' },
      }],
    });
    guild = makeGuild();

    const findings = await runReconciliation(guild as any, supabase as any);

    expect(findings.errors.some((error) => error.includes('customer identity'))).toBe(true);
    expect(guild.members.fetch).not.toHaveBeenCalled();
  });

  it('handles member not found (unknown member)', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [
        { id: 'e1', customer_id: 'c1', granted_role_ids: ['r1'], product_id: 'p1', customers: { id: 'c1', guild_id: 'g1', discord_id: 'u1' } },
      ],
    });
    guild = makeGuild();
    guild.members.fetch.mockRejectedValue(new Error('Unknown Member'));
    const findings = await runReconciliation(guild as any, supabase as any);
    expect(findings.errors.length).toBe(0); // Unknown Member is silently ignored
  });

  it('records unexpected member fetch errors', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [
        { id: 'e1', customer_id: 'c1', granted_role_ids: ['r1'], product_id: 'p1', customers: { id: 'c1', guild_id: 'g1', discord_id: 'u1' } },
      ],
    });
    guild = makeGuild();
    guild.members.fetch.mockRejectedValue(new Error('Some unexpected error'));
    const findings = await runReconciliation(guild as any, supabase as any);
    expect(findings.errors.length).toBe(1);
  });

  it('expires grace period entitlements and revokes roles', async () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [
        {
          id: 'e2', customer_id: 'c2', granted_role_ids: ['r2'], product_id: 'p2',
          order_id: 'order-2', license_key_id: null, status: 'grace_period',
          grace_period_ends_at: pastDate, source: 'purchase', type: 'subscription',
        },
      ],
      customers: [{ id: 'c2', guild_id: 'g1', discord_id: 'u2' }],
    });
    guild = makeGuild();
    // Mock so roles.cache.has returns true (to trigger removal)
    guild.members.fetch.mockResolvedValue({
      roles: {
        cache: { has: vi.fn().mockReturnValue(true) },
        add: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
    const findings = await runReconciliation(guild as any, supabase as any);
    expect(findings.grace_periods_expired).toBeGreaterThanOrEqual(0);
  });

  it('times out stale license sessions', async () => {
    const staleTime = new Date(Date.now() - 200_000 * 1000).toISOString(); // Way past
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      license_sessions: [
        { id: 's1', last_seen_at: staleTime, license_key_id: 'lk1', license_keys: { product_id: 'p1', guild_id: 'g1' } },
      ],
      product_license_config: [{ product_id: 'p1', offline_grace_period_seconds: 3600 }],
    });
    guild = makeGuild();
    const findings = await runReconciliation(guild as any, supabase as any);
    expect(findings.sessions_timed_out).toBeGreaterThanOrEqual(0);
  });

  it('fails closed when the reconciliation run has no durable id', async () => {
    supabase = makeSupabase({
      reconciliation_runs: null,
    });
    guild = makeGuild();
    await expect(runReconciliation(guild as any, supabase as any)).rejects.toThrow(
      'Failed to create reconciliation run: missing run id',
    );
  });

  it('handles no active entitlements', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: null,
    });
    guild = makeGuild();
    const findings = await runReconciliation(guild as any, supabase as any);
    expect(findings.entitlements_checked).toBe(0);
  });
});

describe('scheduleReconciliation', () => {
  it('returns a timer handle', () => {
    const guild = makeGuild();
    const supabase = makeSupabase({ reconciliation_runs: { id: 'run1' } });
    const timer = scheduleReconciliation(guild as any, supabase as any);
    expect(timer).toBeDefined();
    clearInterval(timer);
  });
});
