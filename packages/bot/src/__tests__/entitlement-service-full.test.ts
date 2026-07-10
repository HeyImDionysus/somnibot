/**
 * Entitlement Service — Full tests
 *
 * Tests grant, revoke, suspend, reactivate lifecycle.
 * Verifies DB writes, role grants/revocations, event emission,
 * audit logging, and edge cases (missing data, errors).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { EntitlementService } from '../features/commerce/entitlement-service.js';
import { MockCollection } from './helpers/discord-mocks.js';

function supaChain(data: any = null, error: any = null) {
  const c: any = {};
  const methods = ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte',
    'in','is','or','not','order','limit','range','match','ilike','like','filter','contains',
    'textSearch','head','overlaps','single','maybeSingle'];
  for (const m of methods) c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = undefined;
  return c;
}

function makeMember(id: string, roleIds: string[] = []) {
  const roles = new MockCollection();
  for (const r of roleIds) roles.set(r, { id: r });
  return {
    id,
    roles: {
      cache: roles,
      add: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  };
}

function makeGuild(members: any[] = []) {
  const memberMap = new MockCollection();
  for (const m of members) memberMap.set(m.id, m);
  return {
    id: 'g1',
    members: {
      cache: memberMap,
      fetch: vi.fn(async (id: string) => {
        if (memberMap.has(id)) return memberMap.get(id);
        throw new Error('Unknown Member');
      }),
    },
  } as any;
}

function makeSupabase(tableResponses: Record<string, { data: any; error: any }> = {}) {
  return {
    from: vi.fn((table: string) => {
      const resp = tableResponses[table];
      if (resp) return supaChain(resp.data, resp.error);
      return supaChain();
    }),
  } as any;
}

const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EntitlementService.grant', () => {
  it('creates entitlement record, grants roles, emits event', async () => {
    const member = makeMember('u1', []);
    const guild = makeGuild([member]);
    const supabase = makeSupabase({
      entitlements: { data: { id: 'ent1' }, error: null },
      audit_logs: { data: null, error: null },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.grant({
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test Product',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1', 'r2'],
      grantedChannelIds: [],
    });

    expect(result).toBe('ent1');
    expect(supabase.from).toHaveBeenCalledWith('entitlements');
    expect(member.roles.add).toHaveBeenCalledWith('r1', 'Commerce: entitlement granted');
    expect(member.roles.add).toHaveBeenCalledWith('r2', 'Commerce: entitlement granted');
    expect(eventBus.emit).toHaveBeenCalledWith('entitlement.granted', 'g1', expect.objectContaining({
      discordId: 'u1',
      entitlementId: 'ent1',
      productId: 'prod1',
    }));
  });

  it('returns null when DB insert fails', async () => {
    const guild = makeGuild([makeMember('u1')]);
    const supabase = makeSupabase({
      entitlements: { data: null, error: { message: 'DB error' } },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.grant({
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: [],
      grantedChannelIds: [],
    });

    expect(result).toBeNull();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('handles member not found gracefully during role grant', async () => {
    const guild = makeGuild([]); // no members
    const supabase = makeSupabase({
      entitlements: { data: { id: 'ent1' }, error: null },
      audit_logs: { data: null, error: null },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.grant({
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u-nonexistent',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    });

    expect(result).toBe('ent1'); // Still creates DB record
  });

  it('skips role grant when no role IDs provided', async () => {
    const member = makeMember('u1');
    const guild = makeGuild([member]);
    const supabase = makeSupabase({
      entitlements: { data: { id: 'ent1' }, error: null },
      audit_logs: { data: null, error: null },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    await service.grant({
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'subscription',
      source: 'purchase',
      grantedRoleIds: [],
      grantedChannelIds: [],
    });

    expect(member.roles.add).not.toHaveBeenCalled();
  });
});

describe('EntitlementService.revoke', () => {
  it('revokes entitlement, removes roles, emits event', async () => {
    const member = makeMember('u1', ['r1', 'r2']);
    const guild = makeGuild([member]);

    // Need per-table responses
    const entData = {
      id: 'ent1',
      customer_id: 'cust1',
      product_id: 'prod1',
      granted_role_ids: ['r1', 'r2'],
      license_key_id: null,
      products: { name: 'Test Product' },
    };

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'entitlements') {
          const chain = supaChain(entData);
          // update call should succeed
          chain.update = vi.fn(() => {
            const c2 = supaChain();
            c2.eq = vi.fn(() => c2);
            c2.then = (resolve: any) => resolve({ error: null });
            return c2;
          });
          return chain;
        }
        if (table === 'customers') return supaChain({ discord_id: 'u1' });
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    } as any;

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.revoke('ent1', 'cancelled');

    expect(result).toBe(true);
    expect(member.roles.remove).toHaveBeenCalledWith('r1', 'Commerce: entitlement revoked');
    expect(member.roles.remove).toHaveBeenCalledWith('r2', 'Commerce: entitlement revoked');
    expect(eventBus.emit).toHaveBeenCalledWith('entitlement.revoked', 'g1', expect.objectContaining({
      entitlementId: 'ent1',
      reason: 'cancelled',
    }));
  });

  it('returns false when entitlement not found', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase({
      entitlements: { data: null, error: null },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.revoke('ent-nonexistent', 'expired');
    expect(result).toBe(false);
  });

  it('deactivates license sessions when license_key_id is set', async () => {
    const member = makeMember('u1', ['r1']);
    const guild = makeGuild([member]);

    const licenseSessChain = supaChain();

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'entitlements') {
          const chain = supaChain({
            id: 'ent1',
            customer_id: 'cust1',
            product_id: 'prod1',
            granted_role_ids: ['r1'],
            license_key_id: 'lk1',
            products: { name: 'Test' },
          });
          chain.update = vi.fn(() => {
            const c2 = supaChain();
            c2.eq = vi.fn(() => c2);
            c2.then = (resolve: any) => resolve({ error: null });
            return c2;
          });
          return chain;
        }
        if (table === 'customers') return supaChain({ discord_id: 'u1' });
        if (table === 'license_sessions') return licenseSessChain;
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    } as any;

    const service = new EntitlementService(guild, supabase, eventBus);
    await service.revoke('ent1', 'refund');

    expect(supabase.from).toHaveBeenCalledWith('license_sessions');
  });

  it('deactivates sessions without filtering on the nonexistent guild_id column and surfaces update errors', async () => {
    const member = makeMember('u1', ['r1']);
    const guild = makeGuild([member]);

    const licenseSessChain = supaChain();
    licenseSessChain.then = (resolve: any) => resolve({ error: { message: 'boom' } });

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'entitlements') {
          const chain = supaChain({
            id: 'ent1',
            customer_id: 'cust1',
            product_id: 'prod1',
            granted_role_ids: ['r1'],
            license_key_id: 'lk1',
            products: { name: 'Test' },
          });
          chain.update = vi.fn(() => {
            const c2 = supaChain();
            c2.eq = vi.fn(() => c2);
            c2.then = (resolve: any) => resolve({ error: null });
            return c2;
          });
          return chain;
        }
        if (table === 'customers') return supaChain({ discord_id: 'u1' });
        if (table === 'license_sessions') return licenseSessChain;
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    } as any;

    const service = new EntitlementService(guild, supabase, eventBus);
    // A failed session deactivation must not fail the revocation itself
    // (status + roles already handled) — but it must be checked, not
    // fire-and-forget.
    const result = await service.revoke('ent1', 'refund');
    expect(result).toBe(true);

    expect(licenseSessChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ active: false, deactivation_reason: 'entitlement_revoked' }),
    );
    expect(licenseSessChain.eq).toHaveBeenCalledWith('license_key_id', 'lk1');
    expect(licenseSessChain.eq).toHaveBeenCalledWith('active', true);
    // license_sessions has NO guild_id column — filtering on it makes
    // PostgREST reject the whole update, silently leaving every session of
    // the revoked entitlement active.
    expect(licenseSessChain.eq).not.toHaveBeenCalledWith('guild_id', expect.anything());
  });
});

describe('EntitlementService grace-alert lifecycle (suspend → revoke)', () => {
  const entData = {
    id: 'ent1',
    customer_id: 'cust1',
    product_id: 'prod1',
    order_id: 'ord1',
    granted_role_ids: ['r1'],
    license_key_id: null,
    products: { name: 'Test Product' },
  };

  /**
   * Stateful in-memory `alerts` table: insert enforces the partial unique
   * index uniq_alerts_unresolved_entitlement_grace (one unresolved grace
   * alert per entitlement → 23505 on duplicates) and update applies the
   * patch to every row matching the captured eq filters — so the test
   * exercises the real raise/resolve semantics instead of just call shapes.
   */
  function makeLifecycleSupabase() {
    const alertRows: any[] = [];

    const alertsChain: any = supaChain();
    alertsChain.insert = vi.fn(async (row: any) => {
      const dup = alertRows.find(
        (r) =>
          r.alert_type === row.alert_type &&
          r.resolved === false &&
          r.metadata?.entitlement_id === row.metadata?.entitlement_id,
      );
      if (dup) return { error: { code: '23505', message: 'duplicate key' } };
      alertRows.push({ ...row, resolved: false });
      return { error: null };
    });
    alertsChain.update = vi.fn((patch: any) => {
      const filters: Array<[string, unknown]> = [];
      const c2: any = {};
      c2.eq = vi.fn((k: string, v: unknown) => {
        filters.push([k, v]);
        return c2;
      });
      c2.then = (resolve: any) => {
        for (const r of alertRows) {
          const matches = filters.every(([k, v]) =>
            k === 'metadata->>entitlement_id' ? r.metadata?.entitlement_id === v : r[k] === v,
          );
          if (matches) Object.assign(r, patch);
        }
        resolve({ data: null, error: null });
      };
      return c2;
    });

    // One entitlements chain serving both flows: suspend's guarded
    // UPDATE ... SELECT and revoke's SELECT ... single() + UPDATE.
    const entChain: any = supaChain(entData);
    entChain.update = vi.fn(() => {
      const c2: any = supaChain();
      c2.then = (resolve: any) => resolve({ data: [entData], error: null });
      return c2;
    });

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'entitlements') return entChain;
        if (table === 'alerts') return alertsChain;
        if (table === 'customers') return supaChain({ discord_id: 'u1' });
        return supaChain();
      }),
    } as any;

    return { supabase, alertRows };
  }

  const unresolvedGrace = (rows: any[]) =>
    rows.filter((r) => r.alert_type === 'entitlement_grace_period' && r.resolved === false);

  it('suspend raises the alert, revoke resolves it — zero unresolved grace alerts remain', async () => {
    const member = makeMember('u1', ['r1']);
    const guild = makeGuild([member]);
    const { supabase, alertRows } = makeLifecycleSupabase();
    const service = new EntitlementService(guild, supabase, eventBus);

    expect(await service.suspend('ent1', 3)).toBe(true);
    expect(unresolvedGrace(alertRows)).toHaveLength(1);

    expect(await service.revoke('ent1', 'cancelled')).toBe(true);
    expect(unresolvedGrace(alertRows)).toHaveLength(0);

    // Resolved, not deleted — the operator trail is preserved.
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].resolved).toBe(true);
    expect(alertRows[0].resolved_at).toEqual(expect.any(String));
  });

  it('revoke resolves the alert with entitlement-scoped, unresolved-only filters', async () => {
    const member = makeMember('u1', ['r1']);
    const guild = makeGuild([member]);

    const alertsUpdateChain: any = supaChain();
    alertsUpdateChain.then = (resolve: any) => resolve({ data: null, error: null });
    const alertsChain: any = supaChain();
    alertsChain.update = vi.fn(() => alertsUpdateChain);

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'entitlements') {
          const chain = supaChain(entData);
          chain.update = vi.fn(() => {
            const c2: any = supaChain();
            c2.then = (resolve: any) => resolve({ error: null });
            return c2;
          });
          return chain;
        }
        if (table === 'alerts') return alertsChain;
        if (table === 'customers') return supaChain({ discord_id: 'u1' });
        return supaChain();
      }),
    } as any;

    const service = new EntitlementService(guild, supabase, eventBus);
    expect(await service.revoke('ent1', 'refund')).toBe(true);

    expect(alertsChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ resolved: true, resolved_at: expect.any(String) }),
    );
    expect(alertsUpdateChain.eq).toHaveBeenCalledWith('guild_id', 'g1');
    expect(alertsUpdateChain.eq).toHaveBeenCalledWith('alert_type', 'entitlement_grace_period');
    expect(alertsUpdateChain.eq).toHaveBeenCalledWith('metadata->>entitlement_id', 'ent1');
    expect(alertsUpdateChain.eq).toHaveBeenCalledWith('resolved', false);
  });

  it('a failed alert resolve is non-fatal — the revocation itself still succeeds', async () => {
    const member = makeMember('u1', ['r1']);
    const guild = makeGuild([member]);

    const alertsUpdateChain: any = supaChain();
    alertsUpdateChain.then = (resolve: any) =>
      resolve({ data: null, error: { message: 'alerts table unavailable' } });
    const alertsChain: any = supaChain();
    alertsChain.update = vi.fn(() => alertsUpdateChain);

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'entitlements') {
          const chain = supaChain(entData);
          chain.update = vi.fn(() => {
            const c2: any = supaChain();
            c2.then = (resolve: any) => resolve({ error: null });
            return c2;
          });
          return chain;
        }
        if (table === 'alerts') return alertsChain;
        if (table === 'customers') return supaChain({ discord_id: 'u1' });
        return supaChain();
      }),
    } as any;

    const service = new EntitlementService(guild, supabase, eventBus);
    expect(await service.revoke('ent1', 'expired')).toBe(true);
    expect(alertsChain.update).toHaveBeenCalled();
  });
});

describe('EntitlementService.suspend', () => {
  const suspendedRow = { id: 'ent1', customer_id: 'cust1', product_id: 'prod1', order_id: 'ord1' };

  /**
   * Wire a supabase mock for the guarded suspend UPDATE ... SELECT flow.
   * `updateResult` scripts the awaited result of the entitlements update
   * chain; alert/audit inserts are captured for assertions.
   */
  function makeSuspendSupabase(opts: {
    updateResult?: { data: any; error: any };
    alertInsertError?: any;
    alertRefreshResult?: { error: any };
  } = {}) {
    const updateChain = supaChain();
    updateChain.then = (resolve: any) =>
      resolve(opts.updateResult ?? { data: [suspendedRow], error: null });

    const alertsChain = supaChain();
    alertsChain.insert = vi.fn(async () => ({ error: opts.alertInsertError ?? null }));
    // The refresh-on-duplicate path (23505) does update(...).eq()×4 and awaits
    // the terminal eq(). Return an awaitable chain so it resolves cleanly and
    // the update payload/filters can be asserted.
    const alertsUpdateChain = supaChain();
    alertsUpdateChain.eq = vi.fn(() => alertsUpdateChain);
    alertsUpdateChain.then = (resolve: any) => resolve(opts.alertRefreshResult ?? { error: null });
    alertsChain.update = vi.fn(() => alertsUpdateChain);

    const auditChain = supaChain();
    auditChain.insert = vi.fn(async () => ({ error: null }));

    const entitlementsChain = supaChain();
    entitlementsChain.update = vi.fn(() => updateChain);

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'entitlements') return entitlementsChain;
        if (table === 'alerts') return alertsChain;
        if (table === 'audit_logs') return auditChain;
        return supaChain();
      }),
    } as any;

    return { supabase, updateChain, alertsChain, alertsUpdateChain, auditChain, entitlementsChain };
  }

  it('transitions the entitlement to grace_period guarded on active status and returns true', async () => {
    const guild = makeGuild();
    const { supabase, updateChain, entitlementsChain } = makeSuspendSupabase();

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.suspend('ent1', 5);

    expect(result).toBe(true);
    expect(entitlementsChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'grace_period',
        grace_period_ends_at: expect.any(String),
      }),
    );
    // Guarded transition: a replayed/late suspension webhook must never pull
    // an expired or cancelled entitlement back into grace_period.
    expect(updateChain.eq).toHaveBeenCalledWith('status', 'active');
  });

  it('raises a deduped operator alert so the decaying entitlement is visible', async () => {
    const guild = makeGuild();
    const { supabase, alertsChain } = makeSuspendSupabase();

    const service = new EntitlementService(guild, supabase, eventBus);
    await service.suspend('ent1', 3);

    expect(alertsChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        guild_id: 'g1',
        alert_type: 'entitlement_grace_period',
        severity: 'warning',
        title: expect.any(String),
        metadata: expect.objectContaining({
          entitlement_id: 'ent1',
          customer_id: 'cust1',
          product_id: 'prod1',
          grace_period_ends_at: expect.any(String),
        }),
      }),
    );
  });

  it('writes an audit trail entry for the grace transition', async () => {
    const guild = makeGuild();
    const { supabase, auditChain } = makeSuspendSupabase();

    const service = new EntitlementService(guild, supabase, eventBus);
    await service.suspend('ent1', 3);

    expect(auditChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        guild_id: 'g1',
        actor_type: 'system',
        action: 'entitlement.grace_period_started',
        target_type: 'entitlement',
        target_id: 'ent1',
      }),
    );
  });

  it('treats a 23505 on the alert insert as dedupe success (unique-index-tolerant)', async () => {
    const guild = makeGuild();
    const { supabase } = makeSuspendSupabase({
      alertInsertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.suspend('ent1');
    expect(result).toBe(true);
  });

  it('refreshes the stale duplicate alert in place on a 23505 so operators see the current deadline (W2 codex)', async () => {
    const guild = makeGuild();
    const { supabase, alertsChain, alertsUpdateChain } = makeSuspendSupabase({
      // A prior recovery's resolve failed non-fatally, leaving a stale
      // unresolved alert; this re-suspension re-enters grace and collides.
      alertInsertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.suspend('ent1', 3);
    expect(result).toBe(true);

    // The stale alert must be rewritten with the freshly-committed deadline —
    // not left carrying the old message/metadata deadline.
    expect(alertsChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('ent1'),
        severity: 'warning',
        metadata: expect.objectContaining({
          entitlement_id: 'ent1',
          grace_period_ends_at: expect.any(String),
          source: 'entitlement_service.suspend',
        }),
      }),
    );
    // Scoped to the still-open alert for exactly this entitlement.
    expect(alertsUpdateChain.eq).toHaveBeenCalledWith('metadata->>entitlement_id', 'ent1');
    expect(alertsUpdateChain.eq).toHaveBeenCalledWith('resolved', false);
  });

  it('does NOT refresh (no duplicate) when the alert insert succeeds cleanly', async () => {
    const guild = makeGuild();
    const { supabase, alertsChain } = makeSuspendSupabase();

    const service = new EntitlementService(guild, supabase, eventBus);
    await service.suspend('ent1', 3);

    expect(alertsChain.insert).toHaveBeenCalledTimes(1);
    expect(alertsChain.update).not.toHaveBeenCalled();
  });

  it('still returns true when the alert write genuinely fails — the suspension itself committed', async () => {
    const guild = makeGuild();
    const { supabase } = makeSuspendSupabase({
      alertInsertError: { code: '42501', message: 'permission denied' },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.suspend('ent1');
    expect(result).toBe(true);
  });

  it('returns false and raises no alert when the entitlement is not active (zero rows matched)', async () => {
    const guild = makeGuild();
    const { supabase, alertsChain } = makeSuspendSupabase({ updateResult: { data: [], error: null } });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.suspend('ent1');

    expect(result).toBe(false);
    expect(alertsChain.insert).not.toHaveBeenCalled();
  });

  it('returns false on DB error', async () => {
    const guild = makeGuild();
    const { supabase, alertsChain } = makeSuspendSupabase({
      updateResult: { data: null, error: { message: 'DB error' } },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.suspend('ent1');

    expect(result).toBe(false);
    expect(alertsChain.insert).not.toHaveBeenCalled();
  });
});

describe('EntitlementService.reactivate', () => {
  it('sets active status and re-grants roles', async () => {
    const member = makeMember('u1', []);
    const guild = makeGuild([member]);

    const entData = {
      id: 'ent1',
      customer_id: 'cust1',
      granted_role_ids: ['r1'],
    };

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'entitlements') {
          const chain = supaChain(entData);
          chain.update = vi.fn(() => {
            const c2 = supaChain();
            c2.eq = vi.fn(() => c2);
            c2.then = (resolve: any) => resolve({ error: null });
            return c2;
          });
          return chain;
        }
        if (table === 'customers') return supaChain({ discord_id: 'u1' });
        return supaChain();
      }),
    } as any;

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.reactivate('ent1');
    expect(result).toBe(true);
    expect(member.roles.add).toHaveBeenCalledWith('r1', 'Commerce: entitlement granted');
  });

  it('returns false when entitlement not found', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase({
      entitlements: { data: null, error: null },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.reactivate('ent-missing');
    expect(result).toBe(false);
  });

  it('returns false on DB update error', async () => {
    const guild = makeGuild();

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'entitlements') {
          const chain = supaChain({ id: 'ent1', customer_id: 'c1', granted_role_ids: [] });
          chain.update = vi.fn(() => {
            const c2 = supaChain();
            c2.eq = vi.fn(() => c2);
            c2.then = (resolve: any) => resolve({ error: { message: 'fail' } });
            return c2;
          });
          return chain;
        }
        return supaChain();
      }),
    } as any;

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.reactivate('ent1');
    expect(result).toBe(false);
  });

  it('resolves the outstanding grace-period operator alert on reactivation', async () => {
    const member = makeMember('u1', []);
    const guild = makeGuild([member]);

    const alertsUpdateChain = supaChain();
    alertsUpdateChain.then = (resolve: any) => resolve({ data: null, error: null });
    const alertsChain = supaChain();
    alertsChain.update = vi.fn(() => alertsUpdateChain);

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'entitlements') {
          const chain = supaChain({ id: 'ent1', customer_id: 'cust1', granted_role_ids: [] });
          chain.update = vi.fn(() => {
            const c2 = supaChain();
            c2.eq = vi.fn(() => c2);
            c2.then = (resolve: any) => resolve({ error: null });
            return c2;
          });
          return chain;
        }
        if (table === 'alerts') return alertsChain;
        if (table === 'customers') return supaChain({ discord_id: 'u1' });
        return supaChain();
      }),
    } as any;

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.reactivate('ent1');

    expect(result).toBe(true);
    expect(alertsChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ resolved: true, resolved_at: expect.any(String) }),
    );
    expect(alertsUpdateChain.eq).toHaveBeenCalledWith('alert_type', 'entitlement_grace_period');
    expect(alertsUpdateChain.eq).toHaveBeenCalledWith('metadata->>entitlement_id', 'ent1');
    expect(alertsUpdateChain.eq).toHaveBeenCalledWith('resolved', false);
  });
});
