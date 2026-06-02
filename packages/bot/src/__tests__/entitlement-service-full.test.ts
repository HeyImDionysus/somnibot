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
});

describe('EntitlementService.suspend', () => {
  it('sets grace_period status and returns true', async () => {
    const guild = makeGuild();
    const updateChain = supaChain();
    updateChain.then = (resolve: any) => resolve({ error: null });

    const supabase = {
      from: vi.fn((table: string) => {
        const chain = supaChain();
        chain.update = vi.fn(() => updateChain);
        return chain;
      }),
    } as any;

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.suspend('ent1', 5);
    expect(result).toBe(true);
  });

  it('returns false on DB error', async () => {
    const guild = makeGuild();
    const updateChain = supaChain(null, { message: 'DB error' });
    updateChain.then = (resolve: any) => resolve({ error: { message: 'DB error' } });

    const supabase = {
      from: vi.fn(() => {
        const chain = supaChain();
        chain.update = vi.fn(() => updateChain);
        return chain;
      }),
    } as any;

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await service.suspend('ent1');
    expect(result).toBe(false);
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
});
