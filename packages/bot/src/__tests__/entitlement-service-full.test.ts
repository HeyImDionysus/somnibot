/**
 * Entitlement Service — Full tests
 *
 * Tests grant, revoke, suspend, reactivate lifecycle.
 * Verifies DB writes, role grants/revocations, event emission,
 * audit logging, and edge cases (missing data, errors).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { EntitlementService } from '../features/commerce/entitlement-service.js';
import { MockCollection } from './helpers/discord-mocks.js';

const TEST_ROLE_CLAIM = {
  actionId: '33333333-3333-4333-8333-333333333333',
  claimToken: '44444444-4444-4444-8444-444444444444',
};

function grantClaimed(
  service: EntitlementService,
  options: Parameters<EntitlementService['grant']>[0],
) {
  return service.grant({ ...options, roleDeliveryClaim: TEST_ROLE_CLAIM });
}

function reactivateClaimed(
  service: EntitlementService,
  entitlementId: string,
  contract: Parameters<EntitlementService['reactivate']>[1],
) {
  return service.reactivate(entitlementId, contract, TEST_ROLE_CLAIM);
}

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
      add: vi.fn(async (roleId: string) => {
        roles.set(roleId, { id: roleId });
      }),
      remove: vi.fn(async (roleId: string) => {
        roles.delete(roleId);
      }),
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
      fetch: vi.fn(async (input: string | { user: string }) => {
        const id = typeof input === 'string' ? input : input.user;
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

function purchaseGrantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ent1',
    guild_id: 'g1',
    customer_id: 'cust1',
    product_id: 'prod1',
    plan_id: null,
    order_id: 'ord1',
    type: 'one_time',
    status: 'active',
    source: 'purchase',
    granted_role_ids: ['r1'],
    granted_channel_ids: [],
    ...overrides,
  };
}

function purchaseOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord1',
    guild_id: 'g1',
    customer_id: 'cust1',
    product_id: 'prod1',
    plan_id: null,
    status: 'completed',
    ...overrides,
  };
}

function makeRoleDeliveryRpc(input: {
  ownerProof?: 'confirmed' | 'pending' | 'none';
  ownerProofError?: { message: string } | null;
  lifecycleResult?: Record<string, unknown> | null;
  lifecycleError?: { message: string } | null;
} = {}) {
  const reservedRoleIds = new Set<string>();
  const ownedRoleIds = new Set<string>();
  const completedRoleIds = new Set<string>();
  let permanentRoleIds: string[] = [];
  return vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'commerce_apply_subscription_entitlement_lifecycle') {
      return {
        data: input.lifecycleResult === undefined
          ? {
            disposition: args.p_entitlement_id === null ? 'created' : 'advanced',
            entitlement_id: args.p_entitlement_id ?? 'ent1',
            status: 'active',
            expires_at: args.p_expires_at,
            lifecycle_generation: 1,
          }
          : input.lifecycleResult,
        error: input.lifecycleError ?? null,
      };
    }
    if (name === 'commerce_classify_live_role_owner') {
      return {
        data: input.ownerProof ?? 'none',
        error: input.ownerProofError ?? null,
      };
    }
    if (name === 'commerce_begin_role_delivery_attempt') {
      permanentRoleIds = Array.isArray(args.p_permanent_role_ids)
        ? args.p_permanent_role_ids.filter((roleId): roleId is string => typeof roleId === 'string')
        : [];
      return {
        data: {
          intent_id: '11111111-1111-4111-8111-111111111111',
          intent_state: 'open',
          mutation_token: '22222222-2222-4222-8222-222222222222',
          may_mutate: true,
          contract_live: true,
          delivery_confirmed: false,
          cleanup_needed: false,
          outward_generation_id: '55555555-5555-4555-8555-555555555555',
        },
        error: null,
      };
    }
    if (name === 'commerce_assert_role_delivery_attempt_live') {
      return { data: { intent_state: 'open', may_mutate: true }, error: null };
    }
    if (name === 'commerce_attach_permanent_role_delivery') {
      const roleId = String(args.p_role_id);
      const roleWasPresent = args.p_role_was_present === true;
      if (ownedRoleIds.has(roleId)) {
        return {
          data: {
            intent_state: 'open', may_mutate: true, owns_removal: true,
            claim_newly_acquired: false, disposition: 'owned_replay',
          },
          error: null,
        };
      }
      if (reservedRoleIds.has(roleId)) {
        return {
          data: {
            intent_state: 'open', may_mutate: true, owns_removal: false,
            claim_newly_acquired: false, disposition: 'reserved_replay',
          },
          error: null,
        };
      }
      if (roleWasPresent) {
        return {
          data: {
            intent_state: 'open', may_mutate: true, owns_removal: false,
            claim_newly_acquired: false, disposition: 'manual_baseline',
          },
          error: null,
        };
      }
      reservedRoleIds.add(roleId);
      return {
        data: {
          intent_state: 'open', may_mutate: true, owns_removal: false,
          claim_newly_acquired: true, disposition: 'reserve_add',
        },
        error: null,
      };
    }
    if (name === 'commerce_release_unconsumed_permanent_role_claim') {
      reservedRoleIds.delete(String(args.p_role_id));
      return {
        data: {
          intent_state: 'open',
          released: true,
          cleanup_needed: false,
          settled: false,
          may_mutate: true,
        },
        error: null,
      };
    }
    if (name === 'commerce_confirm_permanent_role_delivery') {
      const roleId = String(args.p_role_id);
      const promoted = reservedRoleIds.delete(roleId);
      if (promoted) ownedRoleIds.add(roleId);
      if (ownedRoleIds.has(roleId)) completedRoleIds.add(roleId);
      return {
        data: {
          intent_state: 'open',
          promoted,
          owns_removal: ownedRoleIds.has(roleId),
        },
        error: null,
      };
    }
    if (name === 'commerce_confirm_permanent_role_baseline') {
      const roleId = String(args.p_role_id);
      const replay = completedRoleIds.has(roleId);
      completedRoleIds.add(roleId);
      return {
        data: {
          intent_state: 'open',
          confirmed: true,
          disposition: replay ? 'baseline_replay' : 'manual_baseline',
        },
        error: null,
      };
    }
    if (name === 'commerce_finish_role_delivery_attempt') {
      const hasReservations = reservedRoleIds.size > 0;
      const authorityEmpty = !hasReservations && ownedRoleIds.size === 0;
      const allRolesComplete = permanentRoleIds.every((roleId) => completedRoleIds.has(roleId));
      const live = args.p_outcome === 'live' && allRolesComplete && !hasReservations;
      const compensated = args.p_outcome === 'compensated' && authorityEmpty;
      const disposition = live || compensated
        ? authorityEmpty ? 'settled' : 'confirmed_open'
        : hasReservations
          ? 'operator_held'
          : authorityEmpty ? 'safe_retry' : 'safe_retry_owned';
      return {
        data: {
          intent_state: live || compensated
            ? authorityEmpty ? 'settled' : 'open'
            : hasReservations ? 'operator_required' : 'open',
          settled: (live || compensated) && authorityEmpty,
          authority_empty: authorityEmpty,
          disposition,
        },
        error: null,
      };
    }
    if (name === 'commerce_begin_role_delivery_cleanup') {
      return {
        data: {
          intent_state: 'cleanup_required',
          may_mutate: true,
          cleanup_mutation_token: '55555555-5555-4555-8555-555555555555',
        },
        error: null,
      };
    }
    if (name === 'commerce_get_role_delivery_cleanup') {
      return {
        data: {
          intent_id: '11111111-1111-4111-8111-111111111111',
          guild_id: 'g1',
          entitlement_id: 'ent1',
          customer_id: 'cust1',
          discord_id: 'u1',
          owned_role_ids: [...ownedRoleIds],
          temporary_role_grant_ids: [],
        },
        error: null,
      };
    }
    if (name === 'commerce_finish_role_delivery_cleanup') {
      reservedRoleIds.clear();
      ownedRoleIds.clear();
      return {
        data: { intent_state: 'settled', settled: true },
        error: null,
      };
    }
    return { data: null, error: null };
  });
}

function purchaseGrantSupabase(input: {
  verification?: Record<string, unknown> | null | (() => Record<string, unknown> | null);
  verificationError?: { message: string } | null | (() => { message: string } | null);
  entitlementOwners?: Array<Record<string, unknown>>;
  ownershipError?: { message: string } | null;
  orderVerification?: Record<string, unknown> | null | (() => Record<string, unknown> | null);
  orderVerificationError?: { message: string } | null;
  ownerOrderVerification?: Record<string, unknown> | null;
  ownerOrderVerificationError?: { message: string } | null;
  customerVerification?: Record<string, unknown> | null | (() => Record<string, unknown> | null);
  customerVerificationError?: { message: string } | null;
  grantedRoleIds?: string[];
  planId?: string | null;
  entitlementType?: 'one_time' | 'subscription';
} = {}) {
  let entitlementCall = 0;
  const hasConfiguredOwner = (input.entitlementOwners ?? []).some((owner) => {
    if (owner.source !== 'purchase' && owner.source !== null) return true;
    return input.ownerOrderVerification?.status === 'completed';
  });
  const rpc = makeRoleDeliveryRpc({
    ownerProof: hasConfiguredOwner ? 'confirmed' : 'none',
    ownerProofError: input.ownershipError,
  });
  const supabase = {
    rpc,
    from: vi.fn((table: string) => {
      if (table === 'entitlements') {
        entitlementCall += 1;
        if (entitlementCall === 1 && input.entitlementType !== 'subscription') {
          return supaChain({ id: 'ent1' });
        }
        const chain = supaChain();
        chain.maybeSingle = vi.fn(async () => {
          const configured = typeof input.verification === 'function'
            ? input.verification()
            : input.verification;
          const configuredError = typeof input.verificationError === 'function'
            ? input.verificationError()
            : input.verificationError;
          return {
            data: configured === undefined
              ? purchaseGrantRow({
                plan_id: input.planId ?? null,
                type: input.entitlementType ?? 'one_time',
                granted_role_ids: input.grantedRoleIds ?? ['r1'],
              })
              : configured,
            error: configuredError ?? null,
          };
        });
        chain.limit = vi.fn(async () => ({
          data: input.entitlementOwners ?? [],
          error: input.ownershipError ?? null,
        }));
        return chain;
      }
      if (table === 'orders') {
        let orderId = '';
        const chain = supaChain();
        chain.eq = vi.fn((column: string, value: unknown) => {
          if (column === 'id') orderId = String(value);
          return chain;
        });
        chain.maybeSingle = vi.fn(async () => {
          if (orderId === 'ord1') {
          const configured = typeof input.orderVerification === 'function'
            ? input.orderVerification()
            : input.orderVerification;
            return {
              data: configured === undefined
                ? purchaseOrderRow({ plan_id: input.planId ?? null })
                : configured,
              error: input.orderVerificationError ?? null,
            };
          }
          return {
            data: input.ownerOrderVerification ?? null,
            error: input.ownerOrderVerificationError ?? null,
          };
        });
        return chain;
      }
      if (table === 'customers') {
        const configured = typeof input.customerVerification === 'function'
          ? input.customerVerification()
          : input.customerVerification;
        return supaChain(
          configured === undefined
            ? { id: 'cust1', guild_id: 'g1', discord_id: 'u1' }
            : configured,
          input.customerVerificationError ?? null,
        );
      }
      return supaChain();
    }),
  } as any;
  return { supabase, rpc };
}

function purchaseReactivateSupabase(input: {
  entitlement?: Record<string, unknown> | null;
  entitlementError?: { message: string } | null;
  lifecycleResult?: Record<string, unknown> | null;
  lifecycleError?: { message: string } | null;
  verification?: Record<string, unknown> | null | (() => Record<string, unknown> | null);
  verificationError?: { message: string } | null | (() => { message: string } | null);
  orderVerification?: Record<string, unknown> | null | (() => Record<string, unknown> | null);
  orderVerificationError?: { message: string } | null | (() => { message: string } | null);
  customerVerification?: Record<string, unknown> | null | (() => Record<string, unknown> | null);
  customerVerificationError?: { message: string } | null;
  entitlementOwners?: Array<Record<string, unknown>>;
  ownerOrderVerification?: Record<string, unknown> | null;
  alertsChain?: any;
} = {}) {
  const defaultEntitlement = {
    ...purchaseGrantRow({
      plan_id: 'plan1',
      type: 'subscription',
      status: 'grace_period',
      expires_at: '2026-07-29T00:00:00.000Z',
    }),
    granted_role_ids: ['r1'],
  };
  const entitlement = input.entitlement === undefined
    ? defaultEntitlement
    : input.entitlement;
  const exactEntitlement = entitlement ?? defaultEntitlement;
  let entitlementCall = 0;
  let customerCall = 0;
  const supabase = {
    rpc: makeRoleDeliveryRpc({
      lifecycleResult: input.lifecycleResult,
      lifecycleError: input.lifecycleError,
    }),
    from: vi.fn((table: string) => {
      if (table === 'entitlements') {
        entitlementCall += 1;
        if (entitlementCall === 1) {
          return supaChain(entitlement, input.entitlementError ?? null);
        }
        if (entitlementCall >= 2) {
          const configured = typeof input.verification === 'function'
            ? input.verification()
            : input.verification;
          const configuredError = typeof input.verificationError === 'function'
            ? input.verificationError()
            : input.verificationError;
          return supaChain(
            configured === undefined
              ? {
                ...exactEntitlement,
                status: 'active',
                grace_period_ends_at: null,
                expires_at: '2026-08-29T00:00:00.000Z',
              }
              : configured,
            configuredError ?? null,
          );
        }
        const ownership = supaChain();
        ownership.limit = vi.fn(async () => ({
          data: input.entitlementOwners ?? [],
          error: null,
        }));
        return ownership;
      }
      if (table === 'customers') {
        customerCall += 1;
        const configured = typeof input.customerVerification === 'function'
          ? input.customerVerification()
          : input.customerVerification;
        return supaChain(
          configured === undefined
            ? { id: 'cust1', guild_id: 'g1', discord_id: 'u1' }
            : configured,
          input.customerVerificationError ?? null,
        );
      }
      if (table === 'orders') {
        const configured = typeof input.orderVerification === 'function'
          ? input.orderVerification()
          : input.orderVerification;
        const configuredError = typeof input.orderVerificationError === 'function'
          ? input.orderVerificationError()
          : input.orderVerificationError;
        return supaChain(
          configured === undefined
            ? purchaseOrderRow({ plan_id: 'plan1' })
            : configured,
          configuredError ?? null,
        );
      }
      if (table === 'alerts') return input.alertsChain ?? supaChain();
      return supaChain();
    }),
  } as any;
  return { supabase, getCustomerCalls: () => customerCall };
}

function subscriptionReactivationContract(overrides: Record<string, unknown> = {}) {
  return {
    customerId: 'cust1',
    productId: 'prod1',
    orderId: 'ord1',
    planId: 'plan1',
    discordId: 'u1',
    grantedRoleIds: ['r1'],
    grantedChannelIds: [],
    expiresAt: '2026-08-29T00:00:00.000Z',
    entitlementType: 'subscription' as const,
    ...overrides,
  };
}

function sharedRoleOwner(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    guild_id: 'g1',
    customer_id: 'cust1',
    product_id: `prod-${id}`,
    order_id: `ord-${id}`,
    status: 'active',
    source: 'purchase',
    granted_role_ids: ['r1'],
    ...overrides,
  };
}

function sharedOwnerParent(
  owner: Record<string, unknown>,
  status: string,
) {
  return {
    id: owner.order_id,
    guild_id: 'g1',
    customer_id: 'cust1',
    product_id: owner.product_id,
    status,
  };
}

async function runOwnedRoleCleanup(
  service: EntitlementService,
  roleIds: string[] = ['r1'],
): Promise<boolean> {
  try {
    await service.reconcileOwnedPurchaseRoleCleanup({
      intentId: 'intent-cleanup',
      entitlementId: 'ent-manual',
      customerId: 'cust1',
      discordId: 'u1',
      ownedRoleIds: roleIds,
      temporaryRoleGrantIds: [],
    });
    return true;
  } catch {
    return false;
  }
}

function sharedOwnerRevocationSupabase(input: {
  owners: Array<Record<string, unknown>>;
  targetRoleIds?: string[];
  ownerSnapshots?: Array<Array<Record<string, unknown>>>;
  classificationStates?: unknown[];
  parentOrders?: Map<string, Record<string, unknown> | null>;
  ownerPageErrorCalls?: number[];
  parentErrorCalls?: number[];
}) {
  let entitlementCall = 0;
  let ownerPageCall = 0;
  let parentCall = 0;
  const ownerGtValues: string[] = [];
  const targetEntitlement = {
    id: 'ent-manual',
    customer_id: 'cust1',
    product_id: 'prod-manual',
    source: 'manual',
    granted_role_ids: input.targetRoleIds ?? ['r1'],
    license_key_id: null,
    products: { name: 'Manual access' },
  };
  const supabase = {
    rpc: vi.fn(async (name: string) => {
      if (name !== 'commerce_classify_live_role_owner') {
        return { data: null, error: null };
      }
      ownerPageCall += 1;
      if (input.ownerPageErrorCalls?.includes(ownerPageCall)) {
        return { data: null, error: { message: 'owner lookup unavailable' } };
      }
      const scriptedState = input.classificationStates?.[ownerPageCall - 1];
      if (scriptedState !== undefined) {
        return { data: scriptedState, error: null };
      }
      const owners = input.ownerSnapshots?.[ownerPageCall - 1] ?? input.owners;
      for (const owner of owners) {
        if (owner.source !== 'purchase' && owner.source !== null) {
          return { data: 'confirmed', error: null };
        }
        if (typeof owner.order_id !== 'string') continue;
        parentCall += 1;
        if (input.parentErrorCalls?.includes(parentCall)) {
          return { data: null, error: { message: 'parent lookup unavailable' } };
        }
        if (input.parentOrders?.get(owner.order_id)?.status === 'completed') {
          return { data: 'confirmed', error: null };
        }
      }
      return { data: 'none', error: null };
    }),
    from: vi.fn((table: string) => {
      if (table === 'entitlements') {
        entitlementCall += 1;
        if (entitlementCall === 1) return supaChain(targetEntitlement);
        if (entitlementCall === 2) return supaChain();

        let afterId: string | null = null;
        const chain = supaChain();
        chain.gt = vi.fn((column: string, value: unknown) => {
          if (column === 'id') {
            afterId = String(value);
            ownerGtValues.push(afterId);
          }
          return chain;
        });
        chain.limit = vi.fn(async (pageSize: number) => {
          ownerPageCall += 1;
          if (input.ownerPageErrorCalls?.includes(ownerPageCall)) {
            return { data: null, error: { message: 'owner lookup unavailable' } };
          }
          const owners = input.ownerSnapshots?.[ownerPageCall - 1] ?? input.owners;
          const start = afterId === null
            ? 0
            : owners.findIndex((owner) => String(owner.id) > afterId!);
          return {
            data: start === -1 ? [] : owners.slice(start, start + pageSize),
            error: null,
          };
        });
        return chain;
      }
      if (table === 'customers') {
        return supaChain({ id: 'cust1', guild_id: 'g1', discord_id: 'u1' });
      }
      if (table === 'orders') {
        let orderId = '';
        const chain = supaChain();
        chain.eq = vi.fn((column: string, value: unknown) => {
          if (column === 'id') orderId = String(value);
          return chain;
        });
        chain.maybeSingle = vi.fn(async () => {
          parentCall += 1;
          if (input.parentErrorCalls?.includes(parentCall)) {
            return { data: null, error: { message: 'parent lookup unavailable' } };
          }
          return {
            data: input.parentOrders?.get(orderId) ?? null,
            error: null,
          };
        });
        return chain;
      }
      return supaChain();
    }),
  } as any;
  return {
    supabase,
    ownerGtValues,
    getOwnerPageCallCount: () => ownerPageCall,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('EntitlementService.grant', () => {
  it.each(['manual', 'giveaway', 'automation'] as const)(
    'rejects a %s grant before storage or Discord mutation',
    async (source) => {
      const member = makeMember('u1');
      const guild = makeGuild([member]);
      const supabase = makeSupabase();
      const service = new EntitlementService(guild, supabase, eventBus);

      await expect(service.grant({
        customerId: 'cust1',
        productId: 'prod1',
        productName: 'Test Product',
        orderId: 'ord1',
        discordId: 'u1',
        type: 'one_time',
        source,
        grantedRoleIds: ['r1'],
        grantedChannelIds: [],
      } as unknown as Parameters<EntitlementService['grant']>[0])).rejects.toThrow(
        'requires the atomic non-commerce RPC',
      );

      expect(supabase.from).not.toHaveBeenCalled();
      expect(member.roles.add).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    },
  );

  it('rejects a paid grant without an exact action claim before the entitlement insert', async () => {
    const guild = makeGuild([makeMember('u1')]);
    const supabase = makeSupabase();
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(service.grant({
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test Product',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).rejects.toThrow('requires an exact action claim');

    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('releases a newly acquired claim when a manual role appears on the forced second read', async () => {
    const member = makeMember('u1');
    const guild = makeGuild([member]);
    let fetchCall = 0;
    guild.members.fetch = vi.fn(async () => {
      fetchCall += 1;
      if (fetchCall === 2) member.roles.cache.set('r1', { id: 'r1' });
      return member;
    });
    const { supabase, rpc } = purchaseGrantSupabase();
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test Product',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).resolves.toBe('ent1');

    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      'commerce_release_unconsumed_permanent_role_claim',
      expect.objectContaining({ p_role_id: 'r1' }),
    );
  });

  it('holds ownership without auto-removal when an add error is followed by ambiguous presence', async () => {
    const member = makeMember('u1');
    member.roles.add.mockRejectedValue(new Error('timeout after request'));
    const guild = makeGuild([member]);
    let fetchCall = 0;
    guild.members.fetch = vi.fn(async () => {
      fetchCall += 1;
      if (fetchCall === 3) member.roles.cache.set('r1', { id: 'r1' });
      return member;
    });
    const { supabase, rpc } = purchaseGrantSupabase();
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test Product',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).rejects.toThrow('add result is uncertain');

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith(
      'commerce_release_unconsumed_permanent_role_claim',
      expect.anything(),
    );
  });

  it('releases the claim when an add error is followed by confirmed absence', async () => {
    const member = makeMember('u1');
    member.roles.add.mockRejectedValue(new Error('definitive add failure'));
    const guild = makeGuild([member]);
    const { supabase, rpc } = purchaseGrantSupabase();
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test Product',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).rejects.toThrow('definitive add failure');

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      'commerce_release_unconsumed_permanent_role_claim',
      expect.objectContaining({ p_role_id: 'r1' }),
    );
  });

  it('preserves confirmed partial delivery for same-action retry and releases only the failed reservation', async () => {
    const member = makeMember('u1');
    member.roles.add.mockImplementation(async (roleId: string) => {
      if (roleId === 'r2') throw new Error('second role rejected');
      member.roles.cache.set(roleId, { id: roleId });
    });
    const guild = makeGuild([member]);
    const { supabase, rpc } = purchaseGrantSupabase({ grantedRoleIds: ['r1', 'r2'] });
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test Product',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1', 'r2'],
      grantedChannelIds: [],
    })).rejects.toThrow('second role rejected');

    expect(member.roles.remove).not.toHaveBeenCalled();
    const releasedRoles = rpc.mock.calls
      .filter(([name]) => name === 'commerce_release_unconsumed_permanent_role_claim')
      .map(([, args]) => args.p_role_id)
      .sort();
    expect(releasedRoles).toEqual(['r2']);
    expect(member.roles.cache.has('r1')).toBe(true);
    expect(member.roles.cache.has('r2')).toBe(false);
  });

  it('creates the entitlement and roles with one direct audit path', async () => {
    const member = makeMember('u1', []);
    const guild = makeGuild([member]);
    const { supabase } = purchaseGrantSupabase({ grantedRoleIds: ['r1', 'r2'] });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await grantClaimed(service, {
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
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      'entitlement.granted',
      expect.anything(),
      expect.anything(),
    );
  });

  it('returns null when DB insert fails', async () => {
    const guild = makeGuild([makeMember('u1')]);
    const supabase = makeSupabase({
      entitlements: { data: null, error: { message: 'DB error' } },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await grantClaimed(service, {
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

  it('propagates member lookup failure so the durable entitlement can be retried', async () => {
    const guild = makeGuild([]); // no members
    const { supabase } = purchaseGrantSupabase({
      customerVerification: {
        id: 'cust1', guild_id: 'g1', discord_id: 'u-nonexistent',
      },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u-nonexistent',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).rejects.toThrow('Unknown Member');
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('fails when Discord acknowledges an add but a fresh read does not confirm the role', async () => {
    const member = makeMember('u1');
    member.roles.add.mockImplementation(async () => undefined);
    const guild = makeGuild([member]);
    const { supabase } = purchaseGrantSupabase();
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).rejects.toThrow('Discord did not confirm');
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('skips role grant when no role IDs provided', async () => {
    const member = makeMember('u1');
    const guild = makeGuild([member]);
    const { supabase } = purchaseGrantSupabase({
      grantedRoleIds: [],
      planId: 'plan1',
      entitlementType: 'subscription',
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    await grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      planId: 'plan1',
      discordId: 'u1',
      type: 'subscription',
      source: 'purchase',
      grantedRoleIds: [],
      grantedChannelIds: [],
      expiresAt: '2026-08-29T00:00:00.000Z',
    });

    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it('reports success only after a fresh read confirms the purchase and parent order are live', async () => {
    const member = makeMember('u1');
    const guild = makeGuild([member]);
    const { supabase } = purchaseGrantSupabase();
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).resolves.toBe('ent1');

    expect(member.roles.add).toHaveBeenCalledWith('r1', 'Commerce: entitlement granted');
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      'entitlement.granted',
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not mutate a manual role when the exact paid grant is already terminal at the pre-add fence', async () => {
    const member = makeMember('u1', ['r1']);
    const guild = makeGuild([member]);
    const { supabase } = purchaseGrantSupabase({
      verification: purchaseGrantRow({ status: 'expired' }),
      orderVerification: purchaseOrderRow({ status: 'refunded' }),
    });
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).rejects.toThrow('is terminal; delivery was safely skipped');

    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.cache.has('r1')).toBe(true);
  });

  it.each([
    { label: 'before confirmation with both roles already present', initial: ['r1', 'r2'], refundAfterAdd: 0 },
    { label: 'after the first role add', initial: [], refundAfterAdd: 1 },
    { label: 'after the second role add', initial: [], refundAfterAdd: 2 },
    { label: 'after adding the one missing role', initial: ['r1'], refundAfterAdd: 1 },
  ])('removes all unowned paid access when a refund wins $label', async ({ initial, refundAfterAdd }) => {
    const member = makeMember('u1', initial);
    let refundWon = refundAfterAdd === 0;
    let addCount = 0;
    member.roles.add.mockImplementation(async (roleId: string) => {
      member.roles.cache.set(roleId, { id: roleId });
      addCount += 1;
      if (addCount === refundAfterAdd) refundWon = true;
    });
    const guild = makeGuild([member]);
    const { supabase } = purchaseGrantSupabase({
      verification: () => purchaseGrantRow({
        status: refundWon ? 'expired' : 'active',
        granted_role_ids: ['r1', 'r2'],
      }),
      orderVerification: () => purchaseOrderRow({ status: refundWon ? 'refunded' : 'completed' }),
    });
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1', 'r2'],
      grantedChannelIds: [],
    })).rejects.toThrow('is terminal; delivery was safely skipped');

    expect(refundWon).toBe(true);
    expect([...member.roles.cache.keys()].sort()).toEqual([...initial].sort());
    const introduced = ['r1', 'r2'].filter((roleId) => !initial.includes(roleId));
    expect(member.roles.remove.mock.calls.map(([roleId]) => roleId).sort()).toEqual(introduced.sort());
    for (const roleId of introduced) {
      expect(member.roles.remove).toHaveBeenCalledWith(
        roleId,
        'Commerce: unresolved delivery intent 11111111-1111-4111-8111-111111111111 cleanup',
      );
    }
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'lookup error', verification: purchaseGrantRow(), verificationError: { message: 'database unavailable' } },
    { label: 'malformed lookup', verification: null, verificationError: null },
  ])('preserves durable role authority for exact same-action retry on $label', async ({ verification, verificationError }) => {
    for (const initial of [[], ['r1'], ['r2'], ['r1', 'r2']] as string[][]) {
      const member = makeMember('u1', initial);
      const guild = makeGuild([member]);
      let verificationRead = 0;
      const { supabase } = purchaseGrantSupabase({
        grantedRoleIds: ['r1', 'r2'],
        verification: () => {
          verificationRead += 1;
          return verificationRead === 1
            ? purchaseGrantRow({ granted_role_ids: ['r1', 'r2'] })
            : verification;
        },
        verificationError: () => verificationRead === 1 ? null : verificationError,
      });
      const service = new EntitlementService(guild, supabase, eventBus);

      await expect(grantClaimed(service, {
        customerId: 'cust1',
        productId: 'prod1',
        productName: 'Test',
        orderId: 'ord1',
        discordId: 'u1',
        type: 'one_time',
        source: 'purchase',
        grantedRoleIds: ['r1', 'r2'],
        grantedChannelIds: [],
      })).rejects.toThrow();

      expect([...member.roles.cache.keys()].sort()).toEqual(['r1', 'r2']);
      expect(member.roles.remove).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
      vi.resetAllMocks();
    }
  });

  it('preserves an introduced role when another live entitlement wins concurrently before compensation', async () => {
    const member = makeMember('u1', []);
    const guild = makeGuild([member]);
    let verificationRead = 0;
    const { supabase } = purchaseGrantSupabase({
      verification: () => verificationRead++ === 0 ? purchaseGrantRow() : null,
      entitlementOwners: [{
        id: 'ent-concurrent-owner',
        guild_id: 'g1',
        customer_id: 'cust1',
        product_id: 'prod-concurrent',
        order_id: null,
        status: 'active',
        source: 'manual',
        granted_role_ids: ['r1'],
      }],
    });
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).rejects.toThrow('verification');

    expect(member.roles.add).toHaveBeenCalledWith('r1', 'Commerce: entitlement granted');
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.cache.has('r1')).toBe(true);
  });

  it('fails closed and preserves the role when post-delivery verification is unavailable', async () => {
    const member = makeMember('u1', []);
    const guild = makeGuild([member]);
    let verificationRead = 0;
    const { supabase } = purchaseGrantSupabase({
      verification: () => verificationRead++ === 0 ? purchaseGrantRow() : null,
      ownershipError: { message: 'ownership database unavailable' },
    });
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).rejects.toThrow('verification');

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.cache.has('r1')).toBe(true);
  });

  it('preserves exact delivered authority for retry when customer identity changes mid-attempt', async () => {
    const member = makeMember('u1', []);
    const guild = makeGuild([member]);
    let customerRead = 0;
    const { supabase } = purchaseGrantSupabase({
      customerVerification: () => ({
        id: 'cust1',
        guild_id: 'g1',
        discord_id: customerRead++ === 0 ? 'u1' : 'u2',
      }),
      entitlementOwners: [{
        id: 'ent-other-live',
        guild_id: 'g1',
        customer_id: 'cust1',
        product_id: 'prod-other',
        order_id: null,
        status: 'active',
        source: 'manual',
        granted_role_ids: ['r1'],
      }],
    });
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).rejects.toThrow('is terminal; delivery was safely skipped');

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.cache.has('r1')).toBe(true);
  });

  it('preserves and retries when post-delivery contract proof becomes unavailable', async () => {
    const member = makeMember('u1', []);
    const guild = makeGuild([member]);
    let verificationRead = 0;
    const { supabase } = purchaseGrantSupabase({
      verification: () => verificationRead++ === 0 ? purchaseGrantRow() : null,
      ownershipError: { message: 'owner proof unavailable' },
    });
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).rejects.toThrow('verification');

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.cache.has('r1')).toBe(true);
  });

  it('preserves a terminal purchase role while another non-paid live entitlement owns it', async () => {
    const member = makeMember('u1', ['r1']);
    const guild = makeGuild([member]);
    const { supabase, rpc } = purchaseGrantSupabase({
      verification: purchaseGrantRow({ status: 'expired' }),
      orderVerification: purchaseOrderRow({ status: 'refunded' }),
      entitlementOwners: [{
        id: 'ent-shared',
        guild_id: 'g1',
        customer_id: 'cust1',
        product_id: 'prod-shared',
        order_id: null,
        status: 'active',
        source: 'manual',
        granted_role_ids: ['r1'],
      }],
    });
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).rejects.toThrow('is terminal; delivery was safely skipped');

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.cache.has('r1')).toBe(true);
    expect(rpc).not.toHaveBeenCalledWith(
      'commerce_classify_live_role_owner',
      expect.any(Object),
    );
  });

  it.each([
    { parentStatus: 'completed', retained: true },
    { parentStatus: 'refunded', retained: true },
  ])(
    'treats a paid shared owner with parent order $parentStatus as retained=$retained',
    async ({ parentStatus, retained }) => {
      const member = makeMember('u1', ['r1']);
      const guild = makeGuild([member]);
      const { supabase } = purchaseGrantSupabase({
        verification: purchaseGrantRow({ status: 'expired' }),
        orderVerification: purchaseOrderRow({ status: 'refunded' }),
        entitlementOwners: [{
          id: 'ent-shared',
          guild_id: 'g1',
          customer_id: 'cust1',
          product_id: 'prod-shared',
          order_id: 'ord-shared',
          status: 'active',
          source: 'purchase',
          granted_role_ids: ['r1'],
        }],
        ownerOrderVerification: purchaseOrderRow({
          id: 'ord-shared',
          product_id: 'prod-shared',
          status: parentStatus,
        }),
      });
      const service = new EntitlementService(guild, supabase, eventBus);

      await expect(grantClaimed(service, {
        customerId: 'cust1',
        productId: 'prod1',
        productName: 'Test',
        orderId: 'ord1',
        discordId: 'u1',
        type: 'one_time',
        source: 'purchase',
        grantedRoleIds: ['r1'],
        grantedChannelIds: [],
      })).rejects.toThrow('is terminal; delivery was safely skipped');

      expect(member.roles.cache.has('r1')).toBe(retained);
      expect(member.roles.remove).toHaveBeenCalledTimes(retained ? 0 : 1);
    },
  );

  it.each([
    { label: 'entitlement product', verification: purchaseGrantRow({ product_id: 'other-product' }), order: purchaseOrderRow() },
    { label: 'entitlement order', verification: purchaseGrantRow({ order_id: 'other-order' }), order: purchaseOrderRow() },
    { label: 'parent customer', verification: purchaseGrantRow(), order: purchaseOrderRow({ customer_id: 'other-customer' }) },
    { label: 'parent product', verification: purchaseGrantRow(), order: purchaseOrderRow({ product_id: 'other-product' }) },
  ])('rejects a mismatched exact purchase contract component: $label', async ({ verification, order }) => {
    const member = makeMember('u1');
    const guild = makeGuild([member]);
    const { supabase } = purchaseGrantSupabase({
      verification,
      orderVerification: order,
    });
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(grantClaimed(service, {
      customerId: 'cust1',
      productId: 'prod1',
      productName: 'Test',
      orderId: 'ord1',
      discordId: 'u1',
      type: 'one_time',
      source: 'purchase',
      grantedRoleIds: ['r1'],
      grantedChannelIds: [],
    })).rejects.toThrow('malformed or mismatched data');

    expect(member.roles.cache.has('r1')).toBe(false);
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});

describe('EntitlementService.revoke', () => {
  const OBSERVED_AT = '2026-07-13T12:00:00.000Z';
  const COMMITTED_AT = '2026-07-13T12:00:01.000Z';
  const TRANSITION_ID = '11111111-1111-4111-8111-111111111111';

  function revokeEvidence(overrides: Record<string, unknown> = {}) {
    return {
      disposition: 'applied',
      transition_id: TRANSITION_ID,
      entitlement_id: 'ent1',
      guild_id: 'g1',
      customer_id: 'cust1',
      discord_id: '10000000000000001',
      product_id: 'prod1',
      product_name: 'Test Product',
      license_key_id: null,
      role_ids: ['10000000000000002'],
      status: 'cancelled',
      updated_at: COMMITTED_AT,
      ...overrides,
    };
  }

  function makeExactRevokeSupabase(options: {
    observation?: Record<string, unknown> | null;
    evidence?: Record<string, unknown>;
    rpcError?: { message: string } | null;
  } = {}) {
    const observation = options.observation === undefined
      ? { id: 'ent1', guild_id: 'g1', status: 'active', updated_at: OBSERVED_AT }
      : options.observation;
    const rpc = vi.fn(async () => ({
      data: options.evidence ?? revokeEvidence(),
      error: options.rpcError ?? null,
    }));
    const from = vi.fn((table: string) =>
      table === 'entitlements' ? supaChain(observation) : supaChain());
    return { supabase: { from, rpc } as any, from, rpc };
  }

  it('accepts exact winning evidence without duplicating the RPC-owned audit', async () => {
    const { supabase, from, rpc } = makeExactRevokeSupabase();
    const service = new EntitlementService(makeGuild(), supabase, eventBus);

    const result = await service.revoke('ent1', 'cancelled');

    expect(result).toEqual({
      disposition: 'applied',
      transitionId: TRANSITION_ID,
      status: 'cancelled',
    });
    expect(rpc).toHaveBeenCalledWith('commerce_revoke_entitlement_exact', {
      p_entitlement_id: 'ent1',
      p_guild_id: 'g1',
      p_expected_status: 'active',
      p_expected_updated_at: OBSERVED_AT,
      p_reason: 'cancelled',
    });
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      'entitlement.revoked',
      expect.anything(),
      expect.anything(),
    );
    expect(from).not.toHaveBeenCalledWith('audit_logs');
    expect(from).not.toHaveBeenCalledWith('license_sessions');
    expect(from).not.toHaveBeenCalledWith('alerts');
  });

  it('returns a terminal replay as a no-op without event or client-side audit', async () => {
    const { supabase, from } = makeExactRevokeSupabase({
      observation: {
        id: 'ent1', guild_id: 'g1', status: 'cancelled', updated_at: COMMITTED_AT,
      },
      evidence: revokeEvidence({
        disposition: 'noop',
        transition_id: null,
        status: 'cancelled',
      }),
    });
    const service = new EntitlementService(makeGuild(), supabase, eventBus);

    expect(await service.revoke('ent1', 'cancelled')).toEqual({
      disposition: 'noop', transitionId: null, status: 'cancelled',
    });
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalledWith('audit_logs');
  });

  it('surfaces a changed live row as stale and performs no side effects', async () => {
    const { supabase } = makeExactRevokeSupabase({
      evidence: revokeEvidence({
        disposition: 'stale',
        transition_id: null,
        status: 'suspended',
      }),
    });
    const service = new EntitlementService(makeGuild(), supabase, eventBus);

    expect(await service.revoke('ent1', 'cancelled')).toEqual({
      disposition: 'stale', transitionId: null, status: 'suspended',
    });
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('fails closed on malformed winning evidence', async () => {
    const { supabase } = makeExactRevokeSupabase({
      evidence: revokeEvidence({ transition_id: null }),
    });
    const service = new EntitlementService(makeGuild(), supabase, eventBus);

    expect(await service.revoke('ent1', 'cancelled')).toEqual({
      disposition: 'failed', transitionId: null, status: null,
    });
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('defers manual cleanup for a delayed pending paid grant without Discord mutation', async () => {
    const member = makeMember('u1', ['r1']);
    const guild = makeGuild([member]);
    const entData = {
      id: 'ent-manual',
      customer_id: 'cust1',
      product_id: 'prod1',
      source: 'manual',
      granted_role_ids: ['r1'],
      license_key_id: null,
      products: { name: 'Manual access' },
    };
    const rpc = vi.fn(async () => ({ data: 'pending', error: null }));
    const supabase = {
      rpc,
      from: vi.fn((table: string) => {
        if (table === 'entitlements') {
          const chain = supaChain(entData);
          chain.limit = vi.fn(async () => ({ data: [], error: null }));
          chain.update = vi.fn(() => {
            const updated = supaChain();
            updated.eq = vi.fn(() => updated);
            updated.then = (resolve: any) => resolve({ error: null });
            return updated;
          });
          return chain;
        }
        if (table === 'customers') {
          return supaChain({ id: 'cust1', guild_id: 'g1', discord_id: 'u1' });
        }
        return supaChain();
      }),
    } as any;

    const service = new EntitlementService(guild, supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(false);
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      'commerce_classify_live_role_owner',
      expect.objectContaining({
        p_guild_id: 'g1',
        p_discord_id: 'u1',
        p_role_id: 'r1',
      }),
    );
  });

  it('preserves a manual entitlement role still owned by a live paid entitlement', async () => {
    const member = makeMember('u1', ['r1']);
    const guild = makeGuild([member]);
    const entData = {
      id: 'ent-manual',
      customer_id: 'cust1',
      product_id: 'prod-manual',
      source: 'manual',
      granted_role_ids: ['r1'],
      license_key_id: null,
      products: { name: 'Manual access' },
    };
    const supabase = {
      rpc: vi.fn(async (name: string) => ({
        data: name === 'commerce_classify_live_role_owner' ? 'confirmed' : null,
        error: null,
      })),
      from: vi.fn((table: string) => {
        if (table === 'entitlements') {
          const chain = supaChain(entData);
          chain.limit = vi.fn(async () => ({
            data: [{
              id: 'ent-paid',
              guild_id: 'g1',
              customer_id: 'cust1',
              product_id: 'prod-paid',
              order_id: 'ord-paid',
              status: 'active',
              source: 'purchase',
              granted_role_ids: ['r1'],
            }],
            error: null,
          }));
          chain.update = vi.fn(() => {
            const updated = supaChain();
            updated.then = (resolve: any) => resolve({ error: null });
            return updated;
          });
          return chain;
        }
        if (table === 'customers') {
          return supaChain({ id: 'cust1', guild_id: 'g1', discord_id: 'u1' });
        }
        if (table === 'orders') {
          return supaChain({
            id: 'ord-paid',
            guild_id: 'g1',
            customer_id: 'cust1',
            product_id: 'prod-paid',
            status: 'completed',
          });
        }
        return supaChain();
      }),
    } as any;

    const service = new EntitlementService(guild, supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(true);
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  it.each([
    { validSource: 'manual', validParentStatus: null },
    { validSource: 'purchase', validParentStatus: 'completed' },
  ])(
    'continues past an invalid first paid owner to a later valid $validSource owner',
    async ({ validSource, validParentStatus }) => {
      const invalidOwner = sharedRoleOwner('ent-000');
      const validOwner = sharedRoleOwner('ent-001', validSource === 'manual'
        ? { source: 'manual', order_id: null }
        : {});
      const parentOrders = new Map<string, Record<string, unknown> | null>([
        [String(invalidOwner.order_id), sharedOwnerParent(invalidOwner, 'refunded')],
      ]);
      if (validParentStatus !== null) {
        parentOrders.set(
          String(validOwner.order_id),
          sharedOwnerParent(validOwner, validParentStatus),
        );
      }
      const { supabase } = sharedOwnerRevocationSupabase({
        owners: [invalidOwner, validOwner],
        parentOrders,
      });
      const member = makeMember('u1', ['r1']);
      const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

      expect(await runOwnedRoleCleanup(service)).toBe(true);
      expect(member.roles.cache.has('r1')).toBe(true);
      expect(member.roles.remove).not.toHaveBeenCalled();
    },
  );

  it('repairs a missing role when another exact live owner protects it', async () => {
    const owner = sharedRoleOwner('ent-001');
    const { supabase } = sharedOwnerRevocationSupabase({
      owners: [owner],
      parentOrders: new Map([
        [String(owner.order_id), sharedOwnerParent(owner, 'completed')],
      ]),
    });
    const member = makeMember('u1');
    const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(true);
    expect(member.roles.cache.has('r1')).toBe(true);
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.add).toHaveBeenCalledTimes(1);
    expect(member.roles.add).toHaveBeenCalledWith(
      'r1',
      'Commerce: repair exact retained role owner',
    );
  });

  it('compensates only a stale repair add when confirmed ownership disappears', async () => {
    const { supabase } = sharedOwnerRevocationSupabase({
      owners: [],
      classificationStates: ['confirmed', 'confirmed', 'confirmed', 'none', 'none'],
    });
    const member = makeMember('u1');
    const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(true);
    expect(member.roles.cache.has('r1')).toBe(false);
    expect(member.roles.add).toHaveBeenCalledTimes(1);
    expect(member.roles.remove).toHaveBeenCalledTimes(1);
    expect(member.roles.remove).toHaveBeenCalledWith(
      'r1',
      'Commerce: compensate stale confirmed-owner repair',
    );
  });

  it('compensates a committed repair add whose acknowledgement is lost when ownership disappears', async () => {
    const { supabase } = sharedOwnerRevocationSupabase({
      owners: [],
      classificationStates: ['confirmed', 'confirmed', 'confirmed', 'none', 'none'],
    });
    const member = makeMember('u1');
    member.roles.add = vi.fn(async (roleId: string) => {
      member.roles.cache.set(roleId, { id: roleId });
      throw new Error('Discord response was lost after committed add');
    });
    const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(true);
    expect(member.roles.cache.has('r1')).toBe(false);
    expect(member.roles.add).toHaveBeenCalledTimes(1);
    expect(member.roles.remove).toHaveBeenCalledTimes(1);
    expect(member.roles.remove).toHaveBeenCalledWith(
      'r1',
      'Commerce: compensate stale confirmed-owner repair',
    );
  });

  it('accepts a committed repair add whose acknowledgement is lost while ownership stays confirmed', async () => {
    const { supabase } = sharedOwnerRevocationSupabase({
      owners: [],
      classificationStates: ['confirmed', 'confirmed', 'confirmed', 'confirmed'],
    });
    const member = makeMember('u1');
    member.roles.add = vi.fn(async (roleId: string) => {
      member.roles.cache.set(roleId, { id: roleId });
      throw new Error('Discord response was lost after committed add');
    });
    const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(true);
    expect(member.roles.cache.has('r1')).toBe(true);
    expect(member.roles.add).toHaveBeenCalledTimes(1);
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  it('restores a role when a new exact owner appears after removal', async () => {
    const owner = sharedRoleOwner('ent-001');
    const { supabase } = sharedOwnerRevocationSupabase({
      owners: [],
      ownerSnapshots: [[], [owner], [owner], [owner], [owner]],
      parentOrders: new Map([
        [String(owner.order_id), sharedOwnerParent(owner, 'completed')],
      ]),
    });
    const member = makeMember('u1', ['r1']);
    const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(true);
    expect(member.roles.cache.has('r1')).toBe(true);
    expect(member.roles.remove).toHaveBeenCalledTimes(1);
    expect(member.roles.add).toHaveBeenCalledTimes(1);
    expect(member.roles.add).toHaveBeenCalledWith(
      'r1',
      'Commerce: repair role for concurrent exact owner',
    );
  });

  it('defers without adding when ownership becomes provisional after removal', async () => {
    const { supabase } = sharedOwnerRevocationSupabase({
      owners: [],
      classificationStates: ['none', 'pending'],
    });
    const member = makeMember('u1', ['r1']);
    const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(false);
    expect(member.roles.cache.has('r1')).toBe(false);
    expect(member.roles.remove).toHaveBeenCalledTimes(1);
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('does not invent access when ownership becomes provisional after an absent role', async () => {
    const { supabase } = sharedOwnerRevocationSupabase({
      owners: [],
      classificationStates: ['none', 'pending'],
    });
    const member = makeMember('u1');
    const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(false);
    expect(member.roles.cache.has('r1')).toBe(false);
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('does not add access when Discord removal confirmation is unavailable', async () => {
    const { supabase } = sharedOwnerRevocationSupabase({ owners: [] });
    const member = makeMember('u1', ['r1']);
    const guild = makeGuild([member]);
    let fetchCount = 0;
    guild.members.fetch = vi.fn(async () => {
      fetchCount += 1;
      // The cleanup performs two forced pre-removal reads, then the removal
      // confirmation read that this test makes unavailable.
      if (fetchCount === 3) throw new Error('confirmation unavailable');
      return member;
    });
    const service = new EntitlementService(guild, supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(false);
    expect(member.roles.cache.has('r1')).toBe(false);
    expect(member.roles.remove).toHaveBeenCalledTimes(1);
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(guild.members.fetch).toHaveBeenCalledTimes(3);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('repairs a lost-ack removal only while another exact owner remains confirmed', async () => {
    const { supabase } = sharedOwnerRevocationSupabase({
      owners: [],
      classificationStates: ['none', 'confirmed', 'confirmed', 'confirmed', 'confirmed'],
    });
    const member = makeMember('u1', ['r1']);
    member.roles.remove = vi.fn(async (roleId: string) => {
      member.roles.cache.delete(roleId);
      throw new Error('Discord response was lost after commit');
    });
    const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(false);
    expect(member.roles.cache.has('r1')).toBe(true);
    expect(member.roles.remove).toHaveBeenCalledTimes(1);
    expect(member.roles.add).toHaveBeenCalledTimes(1);
    expect(member.roles.add).toHaveBeenCalledWith(
      'r1',
      'Commerce: repair confirmed owner after removal uncertainty',
    );
  });

  it.each([
    ['pending', 'pending'],
    ['unknown', false],
  ])('does not restore a lost-ack removal from %s ownership', async (_label, uncertainty) => {
    const { supabase } = sharedOwnerRevocationSupabase({
      owners: [],
      classificationStates: ['none', uncertainty],
    });
    const member = makeMember('u1', ['r1']);
    member.roles.remove = vi.fn(async (roleId: string) => {
      member.roles.cache.delete(roleId);
      throw new Error('Discord response was lost after commit');
    });
    const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(false);
    expect(member.roles.cache.has('r1')).toBe(false);
    expect(member.roles.remove).toHaveBeenCalledTimes(1);
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it('rejects malformed ownership classification before Discord mutation', async () => {
    const { supabase } = sharedOwnerRevocationSupabase({
      owners: [],
      classificationStates: [false],
    });
    const member = makeMember('u1', ['r1']);
    const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(false);
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'a later role is provisional',
      classificationStates: ['none', 'pending'],
      ownerPageErrorCalls: [] as number[],
    },
    {
      label: 'a later role classification fails',
      classificationStates: ['none'],
      ownerPageErrorCalls: [2],
    },
  ])(
    'finishes the full ownership preflight before mutation when $label',
    async ({ classificationStates, ownerPageErrorCalls }) => {
      const { supabase } = sharedOwnerRevocationSupabase({
        owners: [],
        targetRoleIds: ['r1', 'r2'],
        classificationStates,
        ownerPageErrorCalls,
      });
      const member = makeMember('u1', ['r1', 'r2']);
      const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

      expect(await runOwnedRoleCleanup(service, ['r1', 'r2'])).toBe(false);
      expect(member.roles.cache.has('r1')).toBe(true);
      expect(member.roles.cache.has('r2')).toBe(true);
      expect(member.roles.remove).not.toHaveBeenCalled();
      expect(member.roles.add).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    },
  );

  it('revalidates confirmed ownership around retained-role convergence', async () => {
    const owners = Array.from({ length: 251 }, (_, index) => (
      sharedRoleOwner(`ent-${String(index).padStart(4, '0')}`)
    ));
    const parentOrders = new Map<string, Record<string, unknown> | null>();
    for (const [index, owner] of owners.entries()) {
      parentOrders.set(
        String(owner.order_id),
        sharedOwnerParent(owner, index === owners.length - 1 ? 'completed' : 'refunded'),
      );
    }
    const {
      supabase,
      ownerGtValues,
      getOwnerPageCallCount,
    } = sharedOwnerRevocationSupabase({ owners, parentOrders });
    const member = makeMember('u1', ['r1']);
    const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(true);
    expect(member.roles.cache.has('r1')).toBe(true);
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(getOwnerPageCallCount()).toBe(3);
    expect(ownerGtValues).toEqual([]);
  });

  it('removes the role only after every entitlement candidate lacks live ownership proof', async () => {
    const missingOrderOwner = sharedRoleOwner('ent-000', { order_id: null });
    const refundedOwner = sharedRoleOwner('ent-001');
    const missingParentOwner = sharedRoleOwner('ent-002');
    const { supabase, getOwnerPageCallCount } = sharedOwnerRevocationSupabase({
      owners: [missingOrderOwner, refundedOwner, missingParentOwner],
      parentOrders: new Map([
        [String(refundedOwner.order_id), sharedOwnerParent(refundedOwner, 'refunded')],
        [String(missingParentOwner.order_id), null],
      ]),
    });
    const member = makeMember('u1', ['r1']);
    const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

    expect(await runOwnedRoleCleanup(service)).toBe(true);
    expect(member.roles.cache.has('r1')).toBe(false);
    expect(member.roles.remove).toHaveBeenCalledTimes(1);
    expect(member.roles.remove).toHaveBeenCalledWith(
      'r1',
      'Commerce: unresolved delivery intent intent-cleanup cleanup',
    );
    expect(getOwnerPageCallCount()).toBe(2);
  });

  it.each([
    {
      label: 'candidate-page lookup fails before removal',
      ownerPageErrorCalls: [1],
      parentErrorCalls: [],
      expectedRemoveCalls: 0,
      expectedRepairCalls: 0,
    },
    {
      label: 'paid-parent lookup fails before removal',
      ownerPageErrorCalls: [],
      parentErrorCalls: [1],
      expectedRemoveCalls: 0,
      expectedRepairCalls: 0,
    },
    {
      label: 'candidate-page lookup fails after removal',
      ownerPageErrorCalls: [2],
      parentErrorCalls: [],
      expectedRemoveCalls: 1,
      expectedRepairCalls: 0,
    },
    {
      label: 'paid-parent lookup fails after removal',
      ownerPageErrorCalls: [],
      parentErrorCalls: [2],
      expectedRemoveCalls: 1,
      expectedRepairCalls: 0,
    },
  ])(
    'fails safe when $label',
    async ({ ownerPageErrorCalls, parentErrorCalls, expectedRemoveCalls, expectedRepairCalls }) => {
      const invalidOwner = sharedRoleOwner('ent-000');
      const { supabase } = sharedOwnerRevocationSupabase({
        owners: [invalidOwner],
        parentOrders: new Map([
          [String(invalidOwner.order_id), sharedOwnerParent(invalidOwner, 'refunded')],
        ]),
        ownerPageErrorCalls,
        parentErrorCalls,
      });
      const member = makeMember('u1', ['r1']);
      const service = new EntitlementService(makeGuild([member]), supabase, eventBus);

      expect(await runOwnedRoleCleanup(service)).toBe(false);
      expect(member.roles.cache.has('r1')).toBe(expectedRemoveCalls === 0);
      expect(member.roles.remove).toHaveBeenCalledTimes(expectedRemoveCalls);
      expect(member.roles.add).toHaveBeenCalledTimes(expectedRepairCalls);
      expect(eventBus.emit).not.toHaveBeenCalled();
    },
  );

  it('distinguishes an absent observation without invoking transition authority', async () => {
    const { supabase, rpc } = makeExactRevokeSupabase({ observation: null });
    const service = new EntitlementService(makeGuild(), supabase, eventBus);

    expect(await service.revoke('ent-nonexistent', 'expired')).toEqual({
      disposition: 'not_found', transitionId: null, status: null,
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('returns failure on an RPC error without event or fallback side effects', async () => {
    const { supabase, from } = makeExactRevokeSupabase({
      rpcError: { message: 'transaction rolled back' },
    });
    const service = new EntitlementService(makeGuild(), supabase, eventBus);

    expect(await service.revoke('ent1', 'refund')).toEqual({
      disposition: 'failed', transitionId: null, status: null,
    });
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalledWith('license_sessions');
    expect(from).not.toHaveBeenCalledWith('audit_logs');
    expect(from).not.toHaveBeenCalledWith('alerts');
  });
});

describe('EntitlementService grace-alert lifecycle (suspend → revoke)', () => {
  const entData = {
    id: 'ent1',
    guild_id: 'g1',
    customer_id: 'cust1',
    product_id: 'prod1',
    order_id: 'ord1',
    status: 'active',
    updated_at: '2026-07-13T12:00:00.000Z',
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

    // One entitlements chain serves suspend's guarded UPDATE ... SELECT and
    // revoke's observation. The RPC mock represents the atomic database side
    // (including resolving the alert) rather than a post-commit client write.
    const entChain: any = supaChain(entData);
    entChain.update = vi.fn(() => {
      const c2: any = supaChain();
      c2.then = (resolve: any) => resolve({ data: [entData], error: null });
      return c2;
    });

    const rpc = vi.fn(async () => {
      for (const row of alertRows) {
        if (row.alert_type === 'entitlement_grace_period' && row.resolved === false) {
          row.resolved = true;
          row.resolved_at = '2026-07-13T12:00:01.000Z';
        }
      }
      return {
        data: {
          disposition: 'applied',
          transition_id: '11111111-1111-4111-8111-111111111111',
          entitlement_id: 'ent1',
          guild_id: 'g1',
          customer_id: 'cust1',
          discord_id: '10000000000000001',
          product_id: 'prod1',
          product_name: 'Test Product',
          license_key_id: null,
          role_ids: ['10000000000000002'],
          status: 'cancelled',
          updated_at: '2026-07-13T12:00:01.000Z',
        },
        error: null,
      };
    });
    const supabase = {
      rpc,
      from: vi.fn((table: string) => {
        if (table === 'entitlements') return entChain;
        if (table === 'alerts') return alertsChain;
        if (table === 'customers') return supaChain({ discord_id: 'u1' });
        return supaChain();
      }),
    } as any;

    return { supabase, alertRows, rpc };
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

    expect(await service.revoke('ent1', 'cancelled')).toEqual({
      disposition: 'applied',
      transitionId: '11111111-1111-4111-8111-111111111111',
      status: 'cancelled',
    });
    expect(unresolvedGrace(alertRows)).toHaveLength(0);

    // Resolved, not deleted — the operator trail is preserved.
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].resolved).toBe(true);
    expect(alertRows[0].resolved_at).toEqual(expect.any(String));
  });

  it('does not perform a second client-side alert update after the RPC commits', async () => {
    const { supabase, rpc } = makeLifecycleSupabase();
    const service = new EntitlementService(makeGuild(), supabase, eventBus);

    const result = await service.revoke('ent1', 'cancelled');

    expect(result.disposition).toBe('applied');
    expect(rpc).toHaveBeenCalledWith(
      'commerce_revoke_entitlement_exact',
      expect.objectContaining({
        p_entitlement_id: 'ent1',
        p_expected_status: 'active',
        p_expected_updated_at: '2026-07-13T12:00:00.000Z',
      }),
    );
    // The only alerts access in the lifecycle fixture belongs to suspend(); a
    // revoke by itself delegates alert resolution to the database transaction.
    expect(supabase.from).not.toHaveBeenCalledWith('alerts');
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
  it('rejects malformed or mismatched channel vectors before lifecycle mutation', async () => {
    const malformed = purchaseReactivateSupabase();
    const malformedService = new EntitlementService(makeGuild(), malformed.supabase, eventBus);

    await expect(reactivateClaimed(
      malformedService,
      'ent1',
      subscriptionReactivationContract({ grantedChannelIds: ['channel-1', 'channel-1'] }),
    )).rejects.toThrow('Subscription reactivation channel vector');
    expect(malformed.supabase.rpc).not.toHaveBeenCalled();

    const mismatched = purchaseReactivateSupabase({
      entitlement: purchaseGrantRow({
        plan_id: 'plan1',
        type: 'subscription',
        status: 'grace_period',
        expires_at: '2026-07-29T00:00:00.000Z',
        granted_channel_ids: ['channel-other'],
      }),
    });
    const mismatchedService = new EntitlementService(makeGuild(), mismatched.supabase, eventBus);

    await expect(reactivateClaimed(
      mismatchedService,
      'ent1',
      subscriptionReactivationContract({ grantedChannelIds: ['channel-1'] }),
    )).rejects.toThrow('entitlement identity mismatch');
    expect(mismatched.supabase.rpc).not.toHaveBeenCalled();
  });

  it('sets active status and re-grants a paid role only after exact purchase verification', async () => {
    const member = makeMember('u1', []);
    const guild = makeGuild([member]);
    const { supabase } = purchaseReactivateSupabase();

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await reactivateClaimed(service, 'ent1', subscriptionReactivationContract());
    expect(result).toBe(true);
    expect(member.roles.add).toHaveBeenCalledWith('r1', 'Commerce: entitlement granted');
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalledWith('orders');
  });

  it('compensates a paid role introduced by reactivation when a refund wins after the add', async () => {
    const member = makeMember('u1');
    const guild = makeGuild([member]);
    let verificationRead = 0;
    let orderRead = 0;
    const { supabase } = purchaseReactivateSupabase({
      verification: () => purchaseGrantRow({
        plan_id: 'plan1',
        type: 'subscription',
        status: verificationRead++ <= 1 ? 'active' : 'expired',
        expires_at: '2026-08-29T00:00:00.000Z',
      }),
      orderVerification: () => purchaseOrderRow({
        plan_id: 'plan1',
        status: orderRead++ === 0 ? 'completed' : 'refunded',
      }),
    });
    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(reactivateClaimed(service, 'ent1', subscriptionReactivationContract())).rejects.toThrow(
      'is terminal; delivery was safely skipped',
    );

    expect(member.roles.add).toHaveBeenCalledWith('r1', 'Commerce: entitlement granted');
    expect(member.roles.remove).toHaveBeenCalledWith(
      'r1',
      'Commerce: unresolved delivery intent 11111111-1111-4111-8111-111111111111 cleanup',
    );
    expect(member.roles.cache.has('r1')).toBe(false);
  });

  it.each([
    { label: 'lookup error', verification: purchaseGrantRow(), verificationError: { message: 'database unavailable' } },
    { label: 'malformed lookup', verification: null, verificationError: null },
  ])(
    'preserves exact delivered authority for retry after paid reactivation on $label',
    async ({ verification, verificationError }) => {
      const member = makeMember('u1', ['r-existing']);
      const guild = makeGuild([member]);
      const entitlement = {
        ...purchaseGrantRow({
          plan_id: 'plan1',
          type: 'subscription',
          status: 'grace_period',
          expires_at: '2026-08-29T00:00:00.000Z',
        }),
        granted_role_ids: ['r-existing', 'r-new'],
      };
      let verificationRead = 0;
      const { supabase } = purchaseReactivateSupabase({
        entitlement,
        verification: () => {
          verificationRead += 1;
          return verificationRead <= 2
            ? { ...entitlement, status: 'active', grace_period_ends_at: null }
            : verification;
        },
        verificationError: () => verificationRead <= 2 ? null : verificationError,
      });
      const service = new EntitlementService(guild, supabase, eventBus);

      await expect(reactivateClaimed(service,
        'ent1',
        subscriptionReactivationContract({ grantedRoleIds: ['r-existing', 'r-new'] }),
      )).rejects.toThrow();

      expect(member.roles.cache.has('r-existing')).toBe(true);
      expect(member.roles.cache.has('r-new')).toBe(true);
      expect(member.roles.remove).not.toHaveBeenCalled();
    },
  );

  it('returns false when entitlement not found', async () => {
    const guild = makeGuild();
    const supabase = makeSupabase({
      entitlements: { data: null, error: null },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await reactivateClaimed(service,
      'ent-missing',
      subscriptionReactivationContract(),
    );
    expect(result).toBe(false);
  });

  it('rejects reactivation when the exact guild-scoped customer identity is missing', async () => {
    const guild = makeGuild([makeMember('u1', [])]);
    const { supabase } = purchaseReactivateSupabase({ customerVerification: null });

    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(reactivateClaimed(service, 'ent1', subscriptionReactivationContract())).rejects.toThrow('customer identity');
    expect(guild.members.fetch).not.toHaveBeenCalled();
  });

  it('rejects reactivation when Discord does not confirm the restored role', async () => {
    const roleAdd = vi.fn().mockResolvedValue({});
    const member = {
      id: 'u1',
      roles: {
        cache: new MockCollection(),
        add: roleAdd,
        remove: vi.fn(),
      },
    };
    const guild = {
      id: 'g1',
      members: { fetch: vi.fn().mockResolvedValue(member) },
    } as any;
    const { supabase } = purchaseReactivateSupabase();

    const service = new EntitlementService(guild, supabase, eventBus);

    await expect(reactivateClaimed(service, 'ent1', subscriptionReactivationContract())).rejects.toThrow('Discord did not confirm');
    expect(roleAdd).toHaveBeenCalledWith('r1', 'Commerce: entitlement granted');
    expect(guild.members.fetch).toHaveBeenCalledTimes(3);
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  it('rejects on lifecycle transition error', async () => {
    const guild = makeGuild();
    const { supabase } = purchaseReactivateSupabase({
      lifecycleError: { message: 'fail' },
    });

    const service = new EntitlementService(guild, supabase, eventBus);
    await expect(
      reactivateClaimed(service, 'ent1', subscriptionReactivationContract()),
    ).rejects.toThrow('Failed to advance subscription entitlement lifecycle: fail');
  });

  it('resolves the outstanding grace-period operator alert on reactivation', async () => {
    const member = makeMember('u1', []);
    const guild = makeGuild([member]);

    const alertsUpdateChain = supaChain();
    // resolveOwnerAlert (X1/M2) awaits `.select('id')` on the update chain to
    // count how many rows it resolved (recovery notice only when > 0).
    alertsUpdateChain.select = vi.fn(async () => ({ data: [{ id: 'a1' }], error: null }));
    const alertsChain = supaChain();
    alertsChain.update = vi.fn(() => alertsUpdateChain);
    const { supabase } = purchaseReactivateSupabase({ alertsChain });

    const service = new EntitlementService(guild, supabase, eventBus);
    const result = await reactivateClaimed(service, 'ent1', subscriptionReactivationContract());

    expect(result).toBe(true);
    expect(alertsChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ resolved: true, resolved_at: expect.any(String) }),
    );
    expect(alertsUpdateChain.eq).toHaveBeenCalledWith('alert_type', 'entitlement_grace_period');
    // Entitlement narrowing now goes through the shared resolveOwnerAlert
    // metadata-subset match instead of a raw ->> filter.
    expect(alertsUpdateChain.contains).toHaveBeenCalledWith('metadata', { entitlement_id: 'ent1' });
    expect(alertsUpdateChain.eq).toHaveBeenCalledWith('resolved', false);
  });
});
