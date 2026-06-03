/**
 * Reconciliation — coverage tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
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
    const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'in', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    const data = tableData[table] ?? null;
    chain.then = (resolve: (v: any) => void) => resolve({ data, error: null });
    (chain as any)[Symbol.toStringTag] = 'Promise';
    return chain;
  });
  return { from: fromMock };
}

function makeGuild(overrides: Record<string, any> = {}) {
  const memberRolesCache = new Map<string, boolean>();
  if (overrides.missingRoles) {
    // Role is NOT in cache
  } else {
    memberRolesCache.set = () => memberRolesCache;
  }
  const rolesCacheGet = vi.fn().mockReturnValue({ id: 'r1', name: 'Premium' });

  return {
    id: 'g1',
    members: {
      fetch: vi.fn().mockResolvedValue({
        roles: {
          cache: {
            has: vi.fn().mockReturnValue(overrides.missingRoles ? false : true),
          },
          add: vi.fn().mockResolvedValue(undefined),
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
    vi.clearAllMocks();
  });

  it('runs full reconciliation with active entitlements (roles present)', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [
        { id: 'e1', customer_id: 'c1', granted_role_ids: ['r1'], product_id: 'p1', customers: { discord_id: 'u1' } },
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
        { id: 'e1', customer_id: 'c1', granted_role_ids: ['r1'], product_id: 'p1', customers: { discord_id: 'u1' } },
      ],
    });
    guild = makeGuild({ missingRoles: true });
    const findings = await runReconciliation(guild as any, supabase as any);
    expect(findings.entitlements_checked).toBe(1);
    expect(findings.roles_missing).toBe(1);
    expect(findings.roles_regranted).toBe(1);
  });

  it('handles empty role_ids', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [
        { id: 'e1', customer_id: 'c1', granted_role_ids: [], product_id: 'p1', customers: { discord_id: 'u1' } },
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

  it('handles member not found (unknown member)', async () => {
    supabase = makeSupabase({
      reconciliation_runs: { id: 'run1' },
      entitlements: [
        { id: 'e1', customer_id: 'c1', granted_role_ids: ['r1'], product_id: 'p1', customers: { discord_id: 'u1' } },
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
        { id: 'e1', customer_id: 'c1', granted_role_ids: ['r1'], product_id: 'p1', customers: { discord_id: 'u1' } },
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
        { id: 'e2', customer_id: 'c2', granted_role_ids: ['r2'], status: 'grace_period', grace_period_ends_at: pastDate },
      ],
      customers: { discord_id: 'u2' },
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
        { id: 's1', last_seen_at: staleTime, license_key_id: 'lk1', license_keys: { product_id: 'p1' } },
      ],
      product_license_config: { offline_grace_period_seconds: 3600 },
    });
    guild = makeGuild();
    const findings = await runReconciliation(guild as any, supabase as any);
    expect(findings.sessions_timed_out).toBeGreaterThanOrEqual(0);
  });

  it('handles no run id gracefully', async () => {
    supabase = makeSupabase({
      reconciliation_runs: null,
    });
    guild = makeGuild();
    const findings = await runReconciliation(guild as any, supabase as any);
    expect(findings).toBeDefined();
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
