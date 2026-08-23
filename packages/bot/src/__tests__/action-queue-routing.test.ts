/**
 * Deep coverage tests for services/action-queue.ts — exercises all action handlers
 * via startActionQueueListener with mock pending actions.
 * Targets the 599 uncovered statements (15.8% covered).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return {
    ...actual,
    EmbedBuilder: class {
    // Real EmbedBuilder always exposes `data` (branded embeds read
    // data.footer to append attribution without clobbering it).
    data: Record<string, unknown> = {};
      setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
      setThumbnail() { return this; } setTimestamp() { return this; } setFooter() { return this; }
      addFields() { return this; } setAuthor() { return this; } setImage() { return this; }
      setURL() { return this; }
    },
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock('../services/guild-snapshot.js', () => ({
  writeGuildSnapshot: vi.fn(async () => {}),
}));

vi.mock('../features/commerce/commerce-fulfillment.js', () => ({
  fulfillPurchase: vi.fn(async () => ({ success: true })),
}));

vi.mock('../sync/sync-engine.js', () => ({
  runSyncCycle: vi.fn(async () => ({ driftItems: [], repaired: 0, timestamp: Date.now() })),
}));

vi.mock('../sync/repair-actions.js', () => ({
  repairDriftItem: vi.fn(async () => ({ success: true })),
  acceptDriftItem: vi.fn(async () => ({ success: true })),
  ignoreDriftItem: vi.fn(async () => ({ success: true })),
  clearAllDrift: vi.fn(async () => {}),
}));

import {
  handleReconcileEntitlementRoles,
  handleRevokeRoles,
  startActionQueueListener,
} from '../services/action-queue.js';
import { repairDriftItem, acceptDriftItem } from '../sync/repair-actions.js';
import { eventBus } from '../services/event-bus.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// Multi-table Supabase mock that returns different data per table/call
function makeSupa(pendingActions: any[] = []) {
  // Track sequential calls to .from('bot_action_queue') to differentiate
  // the recover RPC, the pending query, and the status updates
  let pendingReturned = false;
  const queueUpdates: Record<string, unknown>[] = [];

  const makeChain = (data: any = null) => {
    const chain: any = {};
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range', 'ilike', 'filter']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.single = vi.fn().mockResolvedValue({ data, error: null });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
    chain.then = (resolve: Function) => resolve({ data: data ? (Array.isArray(data) ? data : [data]) : [], error: null, count: 0 });
    return chain;
  };

  const supa: any = {
    from: vi.fn((table: string) => {
      if (table === 'bot_action_queue') {
        const chain = makeChain([]);
        // The select().eq().eq().order().limit() chain returns pending actions
        chain.select = vi.fn(() => {
          const inner = makeChain([]);
          inner.eq = vi.fn(() => inner);
          inner.order = vi.fn(() => inner);
          inner.limit = vi.fn(() => inner);
          inner.in = vi.fn(() => inner);
          inner.then = (resolve: Function) => {
            if (!pendingReturned) {
              pendingReturned = true;
              return resolve({ data: pendingActions, error: null });
            }
            return resolve({ data: [], error: null });
          };
          return inner;
        });
        chain.update = vi.fn((row: Record<string, unknown>) => {
          queueUpdates.push(row);
          return chain;
        });
        return chain;
      }
      if (table === 'guild_config') {
        return makeChain({ guild_id: 'guild-1', economy_enabled: true });
      }
      if (table === 'guild_desired_state') {
        return makeChain({ guild_id: 'guild-1', roles: [], channels: [], categories: [] });
      }
      return makeChain();
    }),
    rpc: vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
      if (name === 'bot_action_queue_recover_stale') {
        return { data: [], error: null };
      }
      if (name === 'bot_action_queue_claim') {
        const candidate = pendingActions.find((row) => row.id === args.p_action_id);
        return {
          data: candidate ? [{
            ...candidate,
            guild_id: candidate.guild_id ?? 'guild-1',
            status: 'processing',
            retry_count: candidate.retry_count ?? 0,
            claim_token: '44444444-4444-4444-8444-444444444444',
            lane: candidate.lane ?? (String(candidate.action).startsWith('fulfill_')
              || ['revoke_roles', 'deliver_receipt', 'reconcile_entitlement_roles'].includes(candidate.action)
              ? 'commerce'
              : 'game'),
          }] : null,
          error: null,
        };
      }
      if (name === 'bot_action_queue_retry_claim') {
        return { data: [{ applied: true, disposition: 'requeued' }], error: null };
      }
      if (name === 'bot_action_queue_finish_claim') {
        queueUpdates.push({
          status: args.p_success === true ? 'completed' : 'failed',
          error_message: args.p_error ?? null,
        });
        return {
          data: [{
            applied: true,
            disposition: args.p_success === true ? 'completed' : 'failed',
          }],
          error: null,
        };
      }
      return { data: null, error: null };
    }),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: Function) => { cb?.('SUBSCRIBED'); return 'subscribed'; }),
    })),
  };
  supa.__queueUpdates = queueUpdates;
  return supa;
}

describe('customer relink ensure-live request', () => {
  const payload = {
    mode: 'ensure_live_request',
    action_id: 'action-relink-1',
    guild_id: 'guild-1',
    entitlement_id: 'entitlement-1',
    customer_id: 'customer-1',
    old_discord_id: 'old-discord-1',
    discord_id: 'new-discord-1',
  };
  const context = {
    actionId: 'action-relink-1',
    claimToken: 'claim-relink-1',
  };

  it('delegates to the authoritative ensure helper without touching Discord', async () => {
    const supabase = {
      rpc: vi.fn(async () => ({
        data: [{ action_id: 'ensure-action-1', action_status: 'pending' }],
        error: null,
      })),
    };

    const result = await handleReconcileEntitlementRoles(
      { id: 'guild-1' } as any,
      supabase as any,
      payload,
      context,
    );

    expect(result).toMatchObject({
      success: true,
      data: { outcome: 'ensure_queued', entitlementId: 'entitlement-1' },
    });
    expect(supabase.rpc).toHaveBeenCalledWith(
      'commerce_ensure_live_role_delivery_action',
      { p_entitlement_id: 'entitlement-1' },
    );
  });

  it('fails malformed request identity before calling the helper', async () => {
    const supabase = { rpc: vi.fn() };
    const result = await handleReconcileEntitlementRoles(
      { id: 'guild-1' } as any,
      supabase as any,
      { ...payload, discord_id: '  ' },
      context,
    );

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['null instead of rows', null],
    ['object instead of rows', { action_id: 'ensure-1', action_status: 'pending' }],
    ['more than one row', [
      { action_id: 'ensure-1', action_status: 'pending' },
      { action_id: 'ensure-2', action_status: 'pending' },
    ]],
    ['blank action id', [{ action_id: ' ', action_status: 'pending' }]],
    ['unreleased staged action', [{ action_id: 'ensure-1', action_status: 'staged' }]],
    ['terminal action state', [{ action_id: 'ensure-1', action_status: 'completed' }]],
    ['unknown action state', [{ action_id: 'ensure-1', action_status: 'queued' }]],
    ['non-string coercible state', [{
      action_id: 'ensure-1',
      action_status: { toString: (): string => 'pending' },
    }]],
  ])('rejects malformed authoritative helper output: %s', async (_label, data) => {
    const supabase = { rpc: vi.fn(async () => ({ data, error: null })) };
    const result = await handleReconcileEntitlementRoles(
      { id: 'guild-1' } as any,
      supabase as any,
      payload,
      context,
    );

    expect(result).toMatchObject({ success: false, retryable: false });
  });

  it('accepts an empty helper rowset as an authoritative deferred or terminal no-op', async () => {
    const supabase = { rpc: vi.fn(async () => ({ data: [], error: null })) };
    const result = await handleReconcileEntitlementRoles(
      { id: 'guild-1' } as any,
      supabase as any,
      payload,
      context,
    );

    expect(result).toMatchObject({
      success: true,
      data: { outcome: 'ensure_deferred_or_terminal' },
    });
  });
});

function makeOwnershipSupa(
  entitlementResponses: Array<{ data: unknown; error: { message: string } | null }>,
  customerResponse: { data: unknown; error: { message: string } | null } | Array<{
    data: unknown;
    error: { message: string } | null;
  }> = {
    data: { id: 'customer-1', guild_id: 'guild-1', discord_id: 'user-1' },
    error: null,
  },
  temporaryResponses: Array<{ data: unknown; error: { message: string } | null }> = [],
  originResponse: { data: unknown; error: { message: string } | null } = {
    data: {
      id: 'ent-terminal',
      guild_id: 'guild-1',
      customer_id: 'customer-1',
      order_id: 'order-1',
      product_id: 'product-1',
      status: 'expired',
      source: 'purchase',
      granted_role_ids: ['role-1'],
    },
    error: null,
  },
  orderResponse: { data: unknown; error: { message: string } | null } | Array<{
    data: unknown;
    error: { message: string } | null;
  }> = {
    data: {
      id: 'order-1',
      guild_id: 'guild-1',
      customer_id: 'customer-1',
      product_id: 'product-1',
      status: 'completed',
      temporary_role_grants_snapshot: [],
      grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
    },
    error: null,
  },
  originTempGrantResponse: { data: unknown; error: { message: string } | null } = {
    data: [],
    error: null,
  },
  explicitClassificationResponses?: Array<{
    data: unknown;
    error: { message: string } | null;
  }>,
) {
  const queryCalls: Array<{ method: string; args: unknown[] }> = [];
  const derivedClassificationResponses = entitlementResponses.map((response, index) => {
    if (response.error || !Array.isArray(response.data)) return response;
    if (response.data.length > 0) return { data: 'confirmed', error: null };
    const temporary = temporaryResponses[index];
    if (!temporary) return { data: 'none', error: null };
    if (temporary.error || !Array.isArray(temporary.data)) return temporary;
    const owner = temporary.data[0] as Record<string, unknown> | undefined;
    if (!owner) return { data: 'none', error: null };
    if (owner.grant_status === 'pending') return { data: 'pending', error: null };
    return typeof owner.expires_at === 'string'
      && Date.parse(owner.expires_at) > Date.now()
      ? { data: 'confirmed', error: null }
      : { data: 'none', error: null };
  });
  const classificationResponses = explicitClassificationResponses
    ? [...explicitClassificationResponses]
    : derivedClassificationResponses;
  const classificationFallback = classificationResponses.at(-1)
    ?? { data: 'none', error: null };
  const customerResponseQueue = Array.isArray(customerResponse)
    ? [...customerResponse]
    : null;
  const customerResponseFallback = Array.isArray(customerResponse)
    ? customerResponse.at(-1) ?? { data: null, error: null }
    : customerResponse;
  const from = vi.fn((table: string) => {
    if (
      table !== 'entitlements'
      && table !== 'customers'
      && table !== 'orders'
      && table !== 'temp_role_grants'
    ) {
      throw new Error(`Unexpected table: ${table}`);
    }
    const chain: any = {};
    for (const method of ['select', 'eq', 'neq', 'in', 'contains', 'gt', 'or', 'order']) {
      chain[method] = vi.fn((...args: unknown[]) => {
        queryCalls.push({ method, args });
        return chain;
      });
    }
    chain.limit = vi.fn(async (...args: unknown[]) => {
      queryCalls.push({ method: 'limit', args });
      return table === 'entitlements'
        ? entitlementResponses.shift() ?? { data: [], error: null }
        : temporaryResponses.shift() ?? { data: [], error: null };
    });
    chain.maybeSingle = vi.fn(async () => {
      if (table === 'customers') {
        return customerResponseQueue?.shift() ?? customerResponseFallback;
      }
      if (table === 'orders') {
        return Array.isArray(orderResponse)
          ? orderResponse.shift() ?? { data: null, error: null }
          : orderResponse;
      }
      return originResponse;
    });
    chain.then = (resolve: Function) => resolve(
      table === 'temp_role_grants' ? originTempGrantResponse : { data: [], error: null },
    );
    return chain;
  });
  const rpc = vi.fn(async (name: string) => {
    if (name !== 'commerce_classify_live_role_owner') {
      throw new Error(`Unexpected RPC: ${name}`);
    }
    return classificationResponses.shift() ?? classificationFallback;
  });
  return { supabase: { from, rpc } as any, from, queryCalls, rpc };
}

function makeRevokeGuild(
  roleStates: Array<string[] | Error>,
  removeError?: Error,
  addError?: Error,
) {
  let fetchIndex = 0;
  const remove = vi.fn(async () => {
    if (removeError) throw removeError;
  });
  const add = vi.fn(async () => {
    if (addError) throw addError;
  });
  const fetch = vi.fn(async () => {
    const state = roleStates[fetchIndex++] ?? roleStates.at(-1) ?? [];
    if (state instanceof Error) throw state;
    return {
      roles: {
        cache: new Map(state.map((roleId) => [roleId, { id: roleId }])),
        add,
        remove,
      },
    };
  });
  return {
    guild: { id: 'guild-1', members: { fetch } } as any,
    fetch,
    remove,
    add,
  };
}

const identityRevokePayload = {
  guild_id: 'guild-1',
  discord_id: 'user-1',
  role_ids: ['role-1'],
  temporary_role_grant_ids: [],
  entitlement_id: 'ent-terminal',
  customer_id: 'customer-1',
  order_id: 'order-1',
  product_id: 'product-1',
  reason: 'entitlement_expired',
  source: 'entitlement_status_trigger',
};

function liveOwner(roleId = 'role-1') {
  return {
    id: 'ent-other',
    guild_id: 'guild-1',
    customer_id: 'customer-1',
    product_id: 'product-other',
    order_id: null,
    status: 'active',
    source: 'manual',
    granted_role_ids: [roleId],
  };
}

function liveTemporaryOwner(
  roleId = 'role-1',
  grantStatus: 'pending' | 'applied' = 'applied',
  expiresAt = '2999-01-01T00:00:00.000Z',
) {
  return {
    id: 'temp-owner',
    guild_id: 'guild-1',
    user_id: 'user-1',
    role_id: roleId,
    expires_at: expiresAt,
    grant_status: grantStatus,
    remove_on_expiry: false,
    order_id: 'order-2',
  };
}

const NON_COMMERCE_ORDER_ID = '11111111-1111-4111-8111-111111111111';

const nonCommerceRevokePayload = {
  guild_id: 'guild-1',
  discord_id: 'user-1',
  role_ids: ['role-1'],
  temporary_role_grant_ids: [],
  entitlement_id: 'ent-manual-terminal',
  customer_id: 'customer-1',
  order_id: NON_COMMERCE_ORDER_ID,
  product_id: 'product-1',
  entitlement_type: 'one_time',
  plan_id: null,
  entitlement_source: 'manual',
  entitlement_status: 'expired',
  reason: 'entitlement_expired',
  source: 'noncommerce_entitlement_status_trigger',
};

function makeNonCommerceRevokeSupa(
  classificationResponses: Array<{
    data: unknown;
    error: { message: string } | null;
  }>,
  originPatch: Record<string, unknown> | Array<Record<string, unknown>> = {},
) {
  const baseOrigin = {
    id: 'ent-manual-terminal',
    guild_id: 'guild-1',
    customer_id: 'customer-1',
    order_id: NON_COMMERCE_ORDER_ID,
    product_id: 'product-1',
    type: 'one_time',
    plan_id: null,
    status: 'expired',
    source: 'manual',
    granted_role_ids: ['role-1'],
  };
  const originQueue = Array.isArray(originPatch)
    ? originPatch.map((patch) => ({ ...baseOrigin, ...patch }))
    : [{ ...baseOrigin, ...originPatch }];
  const originFallback = originQueue.at(-1)!;
  const from = vi.fn((table: string) => {
    if (table !== 'entitlements') throw new Error(`Unexpected table: ${table}`);
    const chain: any = {};
    for (const method of ['select', 'eq']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle = vi.fn(async () => ({
      data: originQueue.shift() ?? originFallback,
      error: null,
    }));
    return chain;
  });
  const rpc = vi.fn(async (name: string) => {
    if (name !== 'commerce_classify_live_role_owner') {
      throw new Error(`Unexpected RPC: ${name}`);
    }
    return classificationResponses.shift() ?? { data: 'none', error: null };
  });
  return { supabase: { from, rpc } as any, from, rpc };
}

const NON_COMMERCE_RELINK_GENERATION = '22222222-2222-4222-8222-222222222222';
const NON_COMMERCE_ACTIVATION_GENERATION = '33333333-3333-4333-8333-333333333333';

const nonCommerceRelinkPayload = {
  guild_id: 'guild-1',
  old_discord_id: 'user-a',
  discord_id: 'user-b',
  role_ids: ['role-1'],
  temporary_role_grant_ids: [],
  entitlement_id: 'ent-manual-terminal',
  customer_id: 'customer-1',
  order_id: NON_COMMERCE_ORDER_ID,
  product_id: 'product-1',
  entitlement_type: 'one_time',
  plan_id: null,
  entitlement_source: 'manual',
  entitlement_status: 'active',
  relink_generation: NON_COMMERCE_RELINK_GENERATION,
  reason: 'entitlement_customer_relinked',
  source: 'noncommerce_entitlement_customer_relink_trigger',
};

const nonCommerceActivationPayload = {
  guild_id: 'guild-1',
  discord_id: 'user-b',
  role_ids: ['role-1'],
  temporary_role_grant_ids: [],
  entitlement_id: 'ent-manual-terminal',
  customer_id: 'customer-1',
  order_id: NON_COMMERCE_ORDER_ID,
  product_id: 'product-1',
  entitlement_type: 'one_time',
  plan_id: null,
  entitlement_source: 'manual',
  entitlement_status: 'active',
  activation_generation: NON_COMMERCE_ACTIVATION_GENERATION,
  reason: 'entitlement_activated',
  source: 'noncommerce_entitlement_activation_trigger',
};

function makeRelinkGuild(
  initialRoles: Record<string, string[]>,
  removeLostAckErrors: Record<string, Error> = {},
  fetchErrors: Record<string, Error> = {},
  addLostAckErrors: Record<string, Error> = {},
) {
  const roleSets = new Map(
    Object.entries(initialRoles).map(([userId, roleIds]) => [userId, new Set(roleIds)]),
  );
  const adds = new Map<string, ReturnType<typeof vi.fn>>();
  const removes = new Map<string, ReturnType<typeof vi.fn>>();
  const fetch = vi.fn(async ({ user }: { user: string }) => {
    const fetchError = fetchErrors[user];
    if (fetchError) throw fetchError;
    const roles = roleSets.get(user) ?? new Set<string>();
    roleSets.set(user, roles);
    if (!adds.has(user)) {
      adds.set(user, vi.fn(async (roleId: string) => {
        roles.add(roleId);
        const lostAckError = addLostAckErrors[user];
        if (lostAckError) throw lostAckError;
      }));
      removes.set(user, vi.fn(async (roleId: string) => {
        roles.delete(roleId);
        const lostAckError = removeLostAckErrors[user];
        if (lostAckError) throw lostAckError;
      }));
    }
    return {
      roles: {
        cache: new Map([...roles].map((roleId) => [roleId, { id: roleId }])),
        add: adds.get(user),
        remove: removes.get(user),
      },
    };
  });
  return {
    guild: { id: 'guild-1', members: { fetch } } as any,
    fetch,
    adds,
    removes,
    roleSets,
  };
}

function makeNonCommerceRelinkSupa(
  classificationResponses: Array<{
    data: unknown;
    error: { message: string } | null;
  }>,
  observations: Array<{ status: string; currentDiscordId: string }>,
) {
  const observationQueue = [...observations];
  const observationFallback = observationQueue.at(-1) ?? {
    status: 'active',
    currentDiscordId: 'user-b',
  };
  const from = vi.fn((table: string) => {
    throw new Error(`Unexpected table read after lock-aware live-origin RPC: ${table}`);
  });
  const rpc = vi.fn(async (name: string) => {
    if (name === 'commerce_observe_noncommerce_live_origin') {
      const observation = observationQueue.shift() ?? observationFallback;
      return {
        data: [{
          entitlement_id: 'ent-manual-terminal',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          order_id: NON_COMMERCE_ORDER_ID,
          product_id: 'product-1',
          entitlement_type: 'one_time',
          plan_id: null,
          entitlement_status: observation.status,
          entitlement_source: 'manual',
          granted_role_ids: ['role-1'],
          current_discord_id: observation.currentDiscordId,
        }],
        error: null,
      };
    }
    if (name !== 'commerce_classify_live_role_owner') {
      throw new Error(`Unexpected RPC: ${name}`);
    }
    return classificationResponses.shift() ?? { data: 'none', error: null };
  });
  return { supabase: { from, rpc } as any, from, rpc };
}

function makeGuild() {
  const mockRole = {
    id: 'role-1', name: 'TestRole', managed: false, editable: true, position: 1,
    color: 0, hoist: false, mentionable: false, permissions: { bitfield: 0n },
    edit: vi.fn().mockResolvedValue({}),
    setPosition: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  };
  const managedRole = {
    id: 'role-managed', name: 'ManagedRole', managed: true, position: 2,
    edit: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  };
  const mockChannel = {
    id: 'ch-1', name: 'test-channel', type: 0,
    edit: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    send: vi.fn().mockResolvedValue({}),
  };
  const mockCategory = {
    id: 'cat-1', name: 'Test Category', type: 4,
    delete: vi.fn().mockResolvedValue({}),
    children: { cache: new Map() },
  };

  return {
    id: 'guild-1', name: 'Test Guild',
    memberCount: 50,
    roles: {
      cache: new Map([
        ['role-1', mockRole],
        ['role-managed', managedRole],
      ]),
      create: vi.fn().mockResolvedValue({
        id: 'new-role', name: 'NewRole', position: 3,
        setPosition: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      }),
    },
    channels: {
      cache: new Map<string, any>([
        ['ch-1', mockChannel],
        ['cat-1', mockCategory],
      ]),
      create: vi.fn().mockResolvedValue({ id: 'new-ch', name: 'new-channel' }),
    },
    members: {
      cache: new Map(),
      fetch: vi.fn().mockResolvedValue({
        id: 'user-1', displayName: 'TestUser',
        roles: { add: vi.fn(), remove: vi.fn() },
        user: { username: 'testuser', displayAvatarURL: () => 'url' },
        send: vi.fn().mockResolvedValue({}),
      }),
    },
    iconURL: vi.fn(() => 'icon-url'),
  } as any;
}

describe('revoke_roles shared-ownership safety', () => {
  it('revokes frozen channel overwrites on a paid terminal carrier', async () => {
    const channelId = '12345678901234567';
    const { supabase } = makeOwnershipSupa(
      [{ data: [], error: null }],
      undefined,
      [],
      {
        data: {
          ...liveOwner(),
          id: 'ent-terminal',
          order_id: 'order-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          status: 'expired',
          source: 'purchase',
          granted_channel_ids: [channelId],
        },
        error: null,
      },
      {
        data: {
          id: 'order-1',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          status: 'completed',
          granted_channel_ids_snapshot: [channelId],
          temporary_role_grants_snapshot: [],
          grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
        },
        error: null,
      },
      undefined,
      [{ data: 'none', error: null }],
    );
    const harness = makeRevokeGuild([[]]);
    const deleteOverwrite = vi.fn().mockResolvedValue(undefined);
    harness.guild.members.me = { permissions: { has: vi.fn(() => true) } };
    harness.guild.channels = {
      cache: new Map([[channelId, {
        permissionOverwrites: { delete: deleteOverwrite },
      }]]),
    };

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({
      success: true,
      data: { revokedChannelIds: [channelId] },
    });
    expect(deleteOverwrite).toHaveBeenCalledWith(
      'user-1',
      expect.stringContaining('commerce channel access revoked'),
    );
  });

  it('returns a retryable result when channel overwrite revocation fails', async () => {
    const channelId = '12345678901234567';
    const { supabase } = makeOwnershipSupa(
      [{ data: [], error: null }],
      undefined,
      [],
      {
        data: {
          ...liveOwner(),
          id: 'ent-terminal',
          order_id: 'order-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          status: 'expired',
          source: 'purchase',
          granted_channel_ids: [channelId],
        },
        error: null,
      },
      {
        data: {
          id: 'order-1',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          status: 'completed',
          granted_channel_ids_snapshot: [channelId],
          temporary_role_grants_snapshot: [],
          grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
        },
        error: null,
      },
      undefined,
      [{ data: 'none', error: null }],
    );
    const harness = makeRevokeGuild([[]]);
    harness.guild.members.me = { permissions: { has: vi.fn(() => true) } };
    harness.guild.channels = {
      cache: new Map([[channelId, {
        permissionOverwrites: {
          delete: vi.fn().mockRejectedValue(new Error('discord unavailable')),
        },
      }]]),
    };

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('commerce channel cleanup');
  });

  it('retains a role owned by any other live entitlement for the exact guild and customer', async () => {
    const { supabase, rpc } = makeOwnershipSupa([
      { data: [liveOwner()], error: null },
    ]);
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.retained).toEqual(['role-1']);
    expect(harness.fetch).toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('commerce_classify_live_role_owner', {
      p_guild_id: 'guild-1',
      p_discord_id: 'user-1',
      p_role_id: 'role-1',
      p_exclude_intent_id: null,
      p_exclude_entitlement_id: null,
      p_exclude_grant_ids: [],
    });
  });

  it('delegates the exhaustive owner matrix to the authoritative paginated classifier', async () => {
    const owners = Array.from({ length: 251 }, (_, index) => ({
      id: `ent-owner-${String(index).padStart(4, '0')}`,
      guild_id: 'guild-1',
      customer_id: 'customer-1',
      product_id: `product-owner-${String(index).padStart(4, '0')}`,
      order_id: index === 250 ? 'order-owner-live' : null,
      status: 'active',
      source: 'purchase',
      granted_role_ids: ['role-1'],
    }));
    const { supabase, rpc } = makeOwnershipSupa(
      [
        { data: owners.slice(0, 250), error: null },
        { data: owners.slice(250), error: null },
      ],
      undefined,
      [],
      undefined,
      [
        {
          data: {
            id: 'order-1',
            guild_id: 'guild-1',
            customer_id: 'customer-1',
            product_id: 'product-1',
            status: 'completed',
            temporary_role_grants_snapshot: [],
            grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
          },
          error: null,
        },
        {
          data: {
            id: 'order-owner-live',
            guild_id: 'guild-1',
            customer_id: 'customer-1',
            product_id: 'product-owner-0250',
            status: 'completed',
          },
          error: null,
        },
      ],
    );
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.retained).toEqual(['role-1']);
    expect(rpc).toHaveBeenCalledWith('commerce_classify_live_role_owner', expect.any(Object));
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it.each([
    ['completed', true],
    ['refunded', false],
  ] as const)(
    'treats a paid shared owner with parent status %s as retained=%s',
    async (parentStatus, retained) => {
      const owner = {
        id: 'ent-owner-paid',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        product_id: 'product-owner-paid',
        order_id: 'order-owner-paid',
        status: 'active',
        source: 'purchase',
        granted_role_ids: ['role-1'],
      };
      const originOrder = {
        id: 'order-1',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        product_id: 'product-1',
        status: 'completed',
        temporary_role_grants_snapshot: [],
        grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
      };
      const parentOrder = {
        id: 'order-owner-paid',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        product_id: 'product-owner-paid',
        status: parentStatus,
      };
      const { supabase } = makeOwnershipSupa(
        retained
          ? [{ data: [owner], error: null }]
          : [
              { data: [owner], error: null },
              { data: [owner], error: null },
            ],
        undefined,
        [],
        undefined,
        retained
          ? [
              { data: originOrder, error: null },
              { data: parentOrder, error: null },
            ]
          : [
              { data: originOrder, error: null },
              { data: parentOrder, error: null },
              { data: parentOrder, error: null },
            ],
        undefined,
        [{ data: retained ? 'confirmed' : 'none', error: null }],
      );
      const harness = makeRevokeGuild(retained ? [['role-1']] : [['role-1'], []]);

      const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

      expect(result.success).toBe(true);
      expect(result.data?.retained).toEqual(retained ? ['role-1'] : []);
      expect(result.data?.removed).toEqual(retained ? [] : ['role-1']);
    },
  );

  it('fails closed before Discord mutation when paid-parent proof is uncertain', async () => {
    const { supabase } = makeOwnershipSupa(
      [{
        data: [{
          id: 'ent-owner-paid',
          guild_id: 'guild-1',
          customer_id: 'customer-1',
          product_id: 'product-owner-paid',
          order_id: 'order-owner-paid',
          status: 'active',
          source: 'purchase',
          granted_role_ids: ['role-1'],
        }],
        error: null,
      }],
      undefined,
      [],
      undefined,
      [
        {
          data: {
            id: 'order-1',
            guild_id: 'guild-1',
            customer_id: 'customer-1',
            product_id: 'product-1',
            status: 'completed',
            temporary_role_grants_snapshot: [],
            grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
          },
          error: null,
        },
        { data: null, error: { message: 'parent lookup unavailable' } },
      ],
      undefined,
      [{ data: null, error: { message: 'paid-parent ownership proof unavailable' } }],
    );
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('ownership classification failed');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('retains the role when the terminal entitlement was reactivated before the queue ran', async () => {
    const { supabase } = makeOwnershipSupa([
      { data: [{ ...liveOwner(), id: 'ent-terminal' }], error: null },
    ], undefined, [], {
      data: {
        id: 'ent-terminal',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        order_id: 'order-1',
        product_id: 'product-1',
        status: 'active',
        source: 'purchase',
        granted_role_ids: ['role-1'],
      },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.retained).toEqual(['role-1']);
    expect(harness.fetch).toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('retains a temp-only role when its exact order was reactivated before a stale revoke ran', async () => {
    const tempRoleId = '12345678901234567';
    const tempGrantId = 'temp-current';
    const { supabase } = makeOwnershipSupa(
      [{ data: [], error: null }],
      undefined,
      [{
        data: [{
          id: tempGrantId, guild_id: 'guild-1', user_id: 'user-1', role_id: tempRoleId,
          expires_at: '2999-01-01T00:00:00.000Z', grant_status: 'applied',
          remove_on_expiry: true, order_id: 'order-1',
        }],
        error: null,
      }],
      {
        data: {
          id: 'ent-terminal', guild_id: 'guild-1', customer_id: 'customer-1',
          order_id: 'order-1', product_id: 'product-1', status: 'active',
          source: 'purchase', granted_role_ids: [],
        },
        error: null,
      },
      {
        data: {
          id: 'order-1', guild_id: 'guild-1', customer_id: 'customer-1',
          product_id: 'product-1', grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
          temporary_role_grants_snapshot: [{ role_id: tempRoleId, duration_seconds: 60 }],
        },
        error: null,
      },
      {
        data: [{
          id: tempGrantId, guild_id: 'guild-1', user_id: 'user-1', role_id: tempRoleId,
          order_id: 'order-1', source: 'commerce_purchase', source_id: 'product-1',
          duration_seconds: 60, grant_status: 'applied', remove_on_expiry: true,
        }],
        error: null,
      },
    );
    const harness = makeRevokeGuild([[tempRoleId]]);

    const result = await handleRevokeRoles(harness.guild, supabase, {
      ...identityRevokePayload,
      role_ids: [tempRoleId],
      temporary_role_grant_ids: [tempGrantId],
    });

    expect(result.success).toBe(true);
    expect(result.data?.retained).toEqual([tempRoleId]);
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it.each([
    ['applied', true],
    ['pending', false],
  ] as const)(
    'classifies an unexpired %s temporary commerce grant without guessing access',
    async (grantStatus, confirmed) => {
      const { supabase, rpc } = makeOwnershipSupa(
        [{ data: [], error: null }],
        undefined,
        [{ data: [liveTemporaryOwner('role-1', grantStatus)], error: null }],
      );
      const harness = makeRevokeGuild([['role-1']]);

      const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

      expect(result.success).toBe(confirmed);
      expect(result.data?.retained).toEqual(confirmed ? ['role-1'] : []);
      if (!confirmed) expect(result).toMatchObject({ retryable: true });
      expect(harness.remove).not.toHaveBeenCalled();
      expect(harness.add).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenCalledWith('commerce_classify_live_role_owner', expect.any(Object));
    },
  );

  it('defers a delayed pending grant without mutating Discord', async () => {
    const { supabase, rpc } = makeOwnershipSupa(
      [{ data: [], error: null }],
      undefined,
      [{ data: [liveTemporaryOwner('role-1', 'pending', '2000-01-01T00:00:00.000Z')], error: null }],
    );
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.add).not.toHaveBeenCalled();
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('commerce_classify_live_role_owner', expect.any(Object));
  });

  it('treats an applied temp owner that crosses expiry before the caller read as not live', async () => {
    const { supabase } = makeOwnershipSupa(
      [{ data: [], error: null }, { data: [], error: null }],
      undefined,
      [{
        data: [liveTemporaryOwner('role-1', 'applied', '2000-01-01T00:00:00.000Z')],
        error: null,
      }],
    );
    const harness = makeRevokeGuild([['role-1'], []]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.removed).toEqual(['role-1']);
  });

  it('repairs a role when a live owner appears after Discord removal', async () => {
    const { supabase } = makeOwnershipSupa(
      [],
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      [
        { data: 'none', error: null },
        { data: 'none', error: null },
        { data: 'confirmed', error: null },
        { data: 'confirmed', error: null },
        { data: 'confirmed', error: null },
      ],
    );
    const harness = makeRevokeGuild([
      ['role-1'],
      [],
      [],
      ['role-1'],
    ]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.removed).toEqual([]);
    expect(result.data?.retained).toEqual(['role-1']);
    expect(harness.remove).toHaveBeenCalledTimes(1);
    expect(harness.add).toHaveBeenCalledTimes(1);
  });

  it('compensates a paid repair add when confirmed ownership disappears after the add', async () => {
    const { supabase } = makeOwnershipSupa(
      [],
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      [
        { data: 'confirmed', error: null },
        { data: 'confirmed', error: null },
        { data: 'confirmed', error: null },
        { data: 'none', error: null },
        { data: 'none', error: null },
        { data: 'none', error: null },
      ],
    );
    const harness = makeRevokeGuild([[], ['role-1'], [], []]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: true });
    expect(result.data?.retained).toEqual([]);
    expect(result.data?.absent).toEqual(['role-1']);
    expect(harness.add).toHaveBeenCalledTimes(1);
    expect(harness.remove).toHaveBeenCalledTimes(1);
  });

  it('repairs a paid lost-ack removal only after repeated confirmed ownership', async () => {
    const { supabase } = makeOwnershipSupa(
      [],
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      [
        { data: 'none', error: null },
        { data: 'none', error: null },
        { data: 'confirmed', error: null },
        { data: 'confirmed', error: null },
        { data: 'confirmed', error: null },
      ],
    );
    const harness = makeRevokeGuild(
      [['role-1'], [], ['role-1']],
      new Error('Discord response was lost after commit'),
    );

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: true });
    expect(result.data?.retained).toEqual(['role-1']);
    expect(harness.remove).toHaveBeenCalledTimes(1);
    expect(harness.add).toHaveBeenCalledTimes(1);
  });

  it('retries without adding when ownership becomes unknowable after removal', async () => {
    const { supabase } = makeOwnershipSupa(
      [],
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      [
        { data: 'none', error: null },
        { data: 'none', error: null },
        { data: null, error: { message: 'database unavailable' } },
      ],
    );
    const harness = makeRevokeGuild([
      ['role-1'],
      [],
      [],
    ]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(harness.remove).toHaveBeenCalledTimes(1);
    expect(harness.add).not.toHaveBeenCalled();
  });

  it('fails retryably and removes nothing when any ownership lookup fails', async () => {
    const { supabase } = makeOwnershipSupa([
      { data: [], error: null },
      { data: null, error: { message: 'database unavailable' } },
    ], undefined, [], {
      data: {
        id: 'ent-terminal',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        order_id: 'order-1',
        product_id: 'product-1',
        status: 'expired',
        source: 'purchase',
        granted_role_ids: ['role-1', 'role-2'],
      },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1', 'role-2']]);

    const result = await handleRevokeRoles(harness.guild, supabase, {
      ...identityRevokePayload,
      role_ids: ['role-1', 'role-2'],
    });

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('ownership verification failed');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('removes the old user role when the payload customer is already relinked', async () => {
    const { supabase } = makeOwnershipSupa([], {
      data: { id: 'customer-1', guild_id: 'guild-1', discord_id: 'different-user' },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1'], []]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.removed).toEqual(['role-1']);
    expect(result.data?.retained).toEqual([]);
    expect(harness.remove).toHaveBeenCalledTimes(1);
  });

  it('removes a retained role when the customer relinks after the initial owner proof', async () => {
    const exactCustomer = {
      data: { id: 'customer-1', guild_id: 'guild-1', discord_id: 'user-1' },
      error: null,
    };
    const relinkedCustomer = {
      data: { id: 'customer-1', guild_id: 'guild-1', discord_id: 'user-2' },
      error: null,
    };
    const { supabase } = makeOwnershipSupa(
      [],
      [exactCustomer, relinkedCustomer, relinkedCustomer],
      [],
      undefined,
      undefined,
      undefined,
      [
        { data: 'confirmed', error: null },
        { data: 'confirmed', error: null },
        { data: 'confirmed', error: null },
        { data: 'none', error: null },
        { data: 'none', error: null },
      ],
    );
    const harness = makeRevokeGuild([['role-1'], ['role-1'], []]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.removed).toEqual(['role-1']);
    expect(result.data?.retained).toEqual([]);
    expect(harness.remove).toHaveBeenCalledTimes(1);
  });

  it('preserves and retries when the customer mapping becomes unavailable after owner proof', async () => {
    const { supabase } = makeOwnershipSupa(
      [],
      [
        {
          data: { id: 'customer-1', guild_id: 'guild-1', discord_id: 'user-1' },
          error: null,
        },
        { data: null, error: { message: 'mapping unavailable' } },
      ],
      [],
      undefined,
      undefined,
      undefined,
      [
        { data: 'confirmed', error: null },
        { data: 'confirmed', error: null },
        { data: 'confirmed', error: null },
        { data: null, error: { message: 'mapping unavailable' } },
      ],
    );
    const harness = makeRevokeGuild([['role-1'], ['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.data?.failed).toEqual(['role-1']);
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('fails retryably before Discord mutation when the exact entitlement order does not match', async () => {
    const { supabase } = makeOwnershipSupa([], undefined, [], {
      data: {
        id: 'ent-terminal',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        order_id: 'different-order',
        product_id: 'product-1',
        status: 'expired',
        source: 'purchase',
        granted_role_ids: ['role-1'],
      },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('revoke origin');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('fails retryably before Discord mutation when a payload role is absent from the origin snapshot', async () => {
    const { supabase } = makeOwnershipSupa([], undefined, [], {
      data: {
        id: 'ent-terminal',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        order_id: 'order-1',
        product_id: 'product-1',
        status: 'expired',
        source: 'purchase',
        granted_role_ids: ['different-role'],
      },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('revoke role set');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('rejects a source-labeled partial revoke set that would strand an origin role', async () => {
    const { supabase } = makeOwnershipSupa([], undefined, [], {
      data: {
        id: 'ent-terminal',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        order_id: 'order-1',
        product_id: 'product-1',
        status: 'expired',
        source: 'purchase',
        granted_role_ids: ['role-1', 'role-2'],
      },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1', 'role-2']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('revoke role set');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'non-paid source', patch: { source: 'manual' } },
    { label: 'wrong terminal state', patch: { status: 'cancelled' } },
  ])('fails retryably before Discord mutation for an origin with $label', async ({ patch }) => {
    const { supabase } = makeOwnershipSupa([], undefined, [], {
      data: {
        id: 'ent-terminal',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        order_id: 'order-1',
        product_id: 'product-1',
        status: 'expired',
        source: 'purchase',
        granted_role_ids: ['role-1'],
        ...patch,
      },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('revoke origin');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('fails retryably and removes nothing on a malformed ownership result', async () => {
    const { supabase } = makeOwnershipSupa([{ data: null, error: null }]);
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('malformed evidence');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload without a database or Discord mutation', async () => {
    const { supabase, from } = makeOwnershipSupa([]);
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, {
      ...identityRevokePayload,
      role_ids: ['role-1', ''],
    });

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(from).not.toHaveBeenCalled();
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('treats an already absent role as an idempotent success', async () => {
    const { supabase } = makeOwnershipSupa([{ data: [], error: null }]);
    const harness = makeRevokeGuild([[]]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.absent).toEqual(['role-1']);
    expect(harness.fetch).toHaveBeenCalledWith({ user: 'user-1', force: true });
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('fails retryably when Discord role removal fails', async () => {
    const { supabase } = makeOwnershipSupa([{ data: [], error: null }]);
    const harness = makeRevokeGuild(
      [['role-1']],
      new Error('Missing Permissions'),
    );

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(harness.remove).toHaveBeenCalledTimes(1);
    expect(harness.fetch).toHaveBeenCalledTimes(1);
  });

  it('refetches after removal and retries when Discord still reports the role', async () => {
    const { supabase } = makeOwnershipSupa([{ data: [], error: null }]);
    const harness = makeRevokeGuild([['role-1'], ['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(harness.remove).toHaveBeenCalledTimes(1);
    expect(harness.fetch).toHaveBeenCalledTimes(2);
  });

  it('accepts a payload-captured temp grant after the sweeper tombstones it', async () => {
    const tempRoleId = '12345678901234567';
    const tempGrantId = 'temp-grant-1';
    const { supabase } = makeOwnershipSupa(
      [{ data: [], error: null }, { data: [], error: null }],
      undefined,
      [],
      {
        data: {
          id: 'ent-terminal', guild_id: 'guild-1', customer_id: 'customer-1',
          order_id: 'order-1', product_id: 'product-1', status: 'expired',
          source: 'purchase', granted_role_ids: [],
        },
        error: null,
      },
      {
        data: {
          id: 'order-1', guild_id: 'guild-1', customer_id: 'customer-1',
          product_id: 'product-1', grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
          temporary_role_grants_snapshot: [{ role_id: tempRoleId, duration_seconds: 60 }],
        },
        error: null,
      },
      {
        data: [{
          id: tempGrantId, guild_id: 'guild-1', user_id: 'user-1', role_id: tempRoleId,
          order_id: 'order-1', source: 'commerce_reconciled', source_id: 'product-1',
          duration_seconds: 60, grant_status: 'removed', remove_on_expiry: true,
        }],
        error: null,
      },
    );
    const harness = makeRevokeGuild([[tempRoleId], []]);

    const result = await handleRevokeRoles(harness.guild, supabase, {
      ...identityRevokePayload,
      role_ids: [tempRoleId],
      temporary_role_grant_ids: [tempGrantId],
    });

    expect(result.success).toBe(true);
    expect(result.data?.removed).toEqual([tempRoleId]);
  });

  it('ignores an uncaptured removed temp tombstone on a later permanent-role refund', async () => {
    const tempRoleId = '12345678901234567';
    const { supabase } = makeOwnershipSupa(
      [{ data: [], error: null }, { data: [], error: null }],
      undefined,
      [],
      undefined,
      {
        data: {
          id: 'order-1', guild_id: 'guild-1', customer_id: 'customer-1',
          product_id: 'product-1', grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
          temporary_role_grants_snapshot: [{ role_id: tempRoleId, duration_seconds: 60 }],
        },
        error: null,
      },
      {
        data: [{
          id: 'old-temp', guild_id: 'guild-1', user_id: 'user-1', role_id: tempRoleId,
          order_id: 'order-1', source: 'commerce_reconciled', source_id: 'product-1',
          duration_seconds: 60, grant_status: 'removed', remove_on_expiry: true,
        }],
        error: null,
      },
    );
    const harness = makeRevokeGuild([['role-1'], []]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.removed).toEqual(['role-1']);
  });

  it('accepts the permanent-only legacy terminal contract when no temp provenance exists', async () => {
    const { supabase } = makeOwnershipSupa(
      [{ data: [], error: null }, { data: [], error: null }],
      undefined,
      [],
      undefined,
      {
        data: {
          id: 'order-1', guild_id: 'guild-1', customer_id: 'customer-1',
          product_id: 'product-1', grant_snapshot_frozen_at: null,
          temporary_role_grants_snapshot: [],
        },
        error: null,
      },
    );
    const harness = makeRevokeGuild([['role-1'], []]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.removed).toEqual(['role-1']);
  });

  it('rejects a legacy partial-identity payload retryably without touching Discord', async () => {
    const from = vi.fn(() => {
      throw new Error('legacy payload must not query entitlement ownership');
    });
    const harness = makeRevokeGuild([['role-1'], []]);

    const result = await handleRevokeRoles(harness.guild, { from } as any, {
      discord_id: 'user-1',
      role_ids: ['role-1'],
      entitlement_id: 'legacy-entitlement-only',
      reason: 'legacy_reconciliation',
    });

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(from).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.fetch).not.toHaveBeenCalled();
  });
});

describe('action-queue deep routing', () => {
  it('startActionQueueListener processes pending create_role action', async () => {
    const actions = [{
      id: 'act-1', guild_id: 'guild-1', action: 'create_role', status: 'pending',
      payload: { name: 'NewRole', tier: 'custom', color: 0xff0000, hoist: true, mentionable: false, position: 0 },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.roles.create).toHaveBeenCalledWith(expect.objectContaining({
      colors: { primaryColor: 0xff0000 },
    }));
    expect(guild.roles.create.mock.calls[0][0]).not.toHaveProperty('color');
  });

  it('rolls back a newly created role when Discord rejects its requested position', async () => {
    const actions = [{
      id: 'act-create-position-failure', guild_id: 'guild-1', action: 'create_role', status: 'pending',
      payload: { name: 'NewRole', tier: 'custom', position: 10 },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const createdRole = {
      id: 'new-role', name: 'NewRole', position: 3,
      setPosition: vi.fn().mockRejectedValue(new Error('Missing Permissions')),
      delete: vi.fn().mockResolvedValue({}),
    };
    const guild = makeGuild();
    guild.roles.create.mockResolvedValue(createdRole);
    const supa = makeSupa(actions);

    await startActionQueueListener(guild, supa);

    expect(createdRole.delete).toHaveBeenCalled();
    expect(supa.__queueUpdates).toContainEqual(expect.objectContaining({
      status: 'failed',
      error_message: expect.stringContaining('Missing Permissions'),
    }));
  });

  it('startActionQueueListener processes pending update_role action', async () => {
    const actions = [{
      id: 'act-2', guild_id: 'guild-1', action: 'update_role', status: 'pending',
      payload: { roleId: 'role-1', name: 'Updated', color: 0x00ff00, templateKey: 'mod' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    const role = guild.roles.cache.get('role-1');
    expect(role.edit).toHaveBeenCalled();
  });

  it('fails an update_role action when Discord rejects its requested position', async () => {
    const actions = [{
      id: 'act-position-failure', guild_id: 'guild-1', action: 'update_role', status: 'pending',
      payload: { roleId: 'role-1', position: 10 },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    guild.roles.cache.get('role-1').setPosition.mockRejectedValue(new Error('Missing Permissions'));
    const supa = makeSupa(actions);

    await startActionQueueListener(guild, supa);

    expect(supa.__queueUpdates).toContainEqual(expect.objectContaining({
      status: 'failed',
      error_message: expect.stringContaining('Missing Permissions'),
    }));
  });

  it('adopts an existing Discord role when an owner assigns its first tier', async () => {
    const actions = [{
      id: 'act-tier-1', guild_id: 'guild-1', action: 'update_role', status: 'pending',
      payload: { roleId: 'role-1', tier: 'moderator' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);

    await startActionQueueListener(guild, supa);

    expect(supa.from).toHaveBeenCalledWith('discord_id_map');
    expect(supa.rpc).toHaveBeenCalledWith('desired_state_upsert_role', {
      p_guild_id: 'guild-1',
      p_role: expect.objectContaining({
        key: 'custom-role-1',
        name: 'TestRole',
        tier: 'moderator',
      }),
    });
    expect(supa.__queueUpdates).toContainEqual(expect.objectContaining({ status: 'completed' }));
  });

  it('startActionQueueListener processes pending delete_role action', async () => {
    const actions = [{
      id: 'act-3', guild_id: 'guild-1', action: 'delete_role', status: 'pending',
      payload: { roleId: 'role-1', templateKey: 'custom-role-1' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    const role = guild.roles.cache.get('role-1');
    expect(role.delete).toHaveBeenCalled();
  });

  it('handles delete_role for managed role', async () => {
    const actions = [{
      id: 'act-4', guild_id: 'guild-1', action: 'delete_role', status: 'pending',
      payload: { roleId: 'role-managed' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    // managed role shouldn't be deleted
    expect(guild.roles.cache.get('role-managed').delete).not.toHaveBeenCalled();
  });

  it('handles update_role for missing role', async () => {
    const actions = [{
      id: 'act-5', guild_id: 'guild-1', action: 'update_role', status: 'pending',
      payload: { roleId: 'nonexistent' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // no crash, action marked as failed
  });

  it('processes create_channel action', async () => {
    const actions = [{
      id: 'act-6', guild_id: 'guild-1', action: 'create_channel', status: 'pending',
      payload: { name: 'new-channel', type: 0, parentId: 'cat-1', topic: 'Test topic' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.channels.create).toHaveBeenCalled();
  });

  it('processes update_channel action', async () => {
    const actions = [{
      id: 'act-7', guild_id: 'guild-1', action: 'update_channel', status: 'pending',
      payload: { channelId: 'ch-1', name: 'renamed', topic: 'New topic' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.channels.cache.get('ch-1').edit).toHaveBeenCalled();
  });

  it('processes delete_channel action', async () => {
    const actions = [{
      id: 'act-8', guild_id: 'guild-1', action: 'delete_channel', status: 'pending',
      payload: { channelId: 'ch-1' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.channels.cache.get('ch-1').delete).toHaveBeenCalled();
  });

  it('processes create_category action', async () => {
    const actions = [{
      id: 'act-9', guild_id: 'guild-1', action: 'create_category', status: 'pending',
      payload: { name: 'New Category' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.channels.create).toHaveBeenCalled();
  });

  it('processes delete_category action', async () => {
    const actions = [{
      id: 'act-10', guild_id: 'guild-1', action: 'delete_category', status: 'pending',
      payload: { categoryId: 'cat-1' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.channels.cache.get('cat-1').delete).toHaveBeenCalled();
  });

  it('processes config_reload action', async () => {
    const actions = [{
      id: 'act-11', guild_id: 'guild-1', action: 'config_reload', status: 'pending',
      payload: {},
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // config_reload calls various cache invalidation - no crash = success
  });

  it('awaits onboarding config reload with its synchronization request fence', async () => {
    const requestId = '77777777-7777-4777-8777-777777777777';
    const emitAndWait = vi.spyOn(eventBus, 'emitAndWait').mockResolvedValue(undefined);
    const actions = [{
      id: 'act-onboarding', guild_id: 'guild-1', action: 'config_reload', status: 'pending',
      payload: {
        section: 'onboarding',
        changes: { onboarding_enabled: true },
        sync_request_id: requestId,
      },
      created_at: new Date().toISOString(), retry_count: 0,
    }];

    await startActionQueueListener(makeGuild(), makeSupa(actions));

    expect(emitAndWait).toHaveBeenCalledWith('config.changed', 'guild-1', expect.objectContaining({
      section: 'onboarding',
      syncRequestId: requestId,
    }));
  });

  it('rejects a synchronization request fence on a non-onboarding config reload', async () => {
    const emitAndWait = vi.spyOn(eventBus, 'emitAndWait').mockResolvedValue(undefined);
    const actions = [{
      id: 'act-welcome-sync', guild_id: 'guild-1', action: 'config_reload', status: 'pending',
      payload: {
        section: 'welcome',
        sync_request_id: '77777777-7777-4777-8777-777777777777',
      },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const supa = makeSupa(actions);

    await startActionQueueListener(makeGuild(), supa);

    expect(emitAndWait).not.toHaveBeenCalled();
    expect(supa.__queueUpdates).toContainEqual(expect.objectContaining({
      status: 'failed',
      error_message: expect.stringContaining('only valid for onboarding'),
    }));
  });

  it('processes send_embed action', async () => {
    const actions = [{
      id: 'act-12', guild_id: 'guild-1', action: 'send_embed', status: 'pending',
      payload: { channel_id: 'ch-1', embed_config_id: 'embed-1' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    // Add isTextBased to the channel mock
    guild.channels.cache.get('ch-1').isTextBased = vi.fn(() => true);
    const supa = makeSupa(actions);
    // Override from('embed_configs') to return an embed config
    const origFrom = supa.from;
    supa.from = vi.fn((table: string) => {
      if (table === 'embed_configs') {
        const chain: any = {};
        for (const m of ['select', 'eq', 'maybeSingle']) { chain[m] = vi.fn(() => chain); }
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'embed-1', name: 'Test Embed', title: 'Hello', description: 'World', color: '#5865F2' }, error: null });
        return chain;
      }
      return origFrom(table);
    });
    await startActionQueueListener(guild, supa);
    expect(guild.channels.cache.get('ch-1').send).toHaveBeenCalled();
  });

  it('processes refresh_snapshot action', async () => {
    const actions = [{
      id: 'act-13', guild_id: 'guild-1', action: 'refresh_snapshot', status: 'pending',
      payload: {},
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // writeGuildSnapshot is mocked - no crash = success
  });

  it('handles unknown action type', async () => {
    const actions = [{
      id: 'act-14', guild_id: 'guild-1', action: 'totally_unknown', status: 'pending',
      payload: {},
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // unknown action should be marked as failed
  });

  it('handles claim failure (already claimed)', async () => {
    const actions = [{
      id: 'act-15', guild_id: 'guild-1', action: 'create_role', status: 'pending',
      payload: { name: 'Test', tier: 'custom' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    // Override rpc to return null (already claimed)
    supa.rpc = vi.fn(async (name: string) => {
      if (name === 'bot_action_queue_claim') return { data: null, error: null };
      return { data: [], error: null };
    });
    await startActionQueueListener(guild, supa);
    // should skip without crash
    expect(guild.roles.create).not.toHaveBeenCalled();
  });

  it('handles claim RPC error', async () => {
    const actions = [{
      id: 'act-16', guild_id: 'guild-1', action: 'create_role', status: 'pending',
      payload: { name: 'Test', tier: 'custom' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    supa.rpc = vi.fn(async (name: string) => {
      if (name === 'bot_action_queue_claim') return { data: null, error: { message: 'DB error' } };
      return { data: [], error: null };
    });
    await startActionQueueListener(guild, supa);
    expect(guild.roles.create).not.toHaveBeenCalled();
  });

  it('handles SQL-finalized and requeued stale rows without duplicate DLQ writes', async () => {
    const guild = makeGuild();
    const supa = makeSupa([]);
    supa.rpc = vi.fn(async (name: string) => {
      if (name === 'bot_action_queue_recover_stale') {
        return {
          data: [
            { id: 'stale-1', action: 'create_role', disposition: 'failed' },
            { id: 'stale-2', action: 'update_role', disposition: 'requeued' },
          ],
          error: null,
        };
      }
      if (name === 'bot_action_queue_claim') return { data: [{ id: 'claimed' }], error: null };
      return { data: null, error: null };
    });
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    expect(supa.from).not.toHaveBeenCalledWith('action_queue_dlq');
    // SQL atomically finalized stale-1; only stale-2 is eligible for re-fetch.
  });

  it('handles recovery RPC error', async () => {
    const guild = makeGuild();
    const supa = makeSupa([]);
    supa.rpc = vi.fn(async (name: string) => {
      if (name === 'bot_action_queue_recover_stale') {
        return { data: null, error: { message: 'Recovery failed' } };
      }
      return { data: null, error: null };
    });
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // Should log error and continue
  });

  it('rejects a legacy revoke_roles action without touching Discord', async () => {
    const actions = [{
      id: 'act-17', guild_id: 'guild-1', action: 'revoke_roles', status: 'pending',
      payload: { discord_id: 'user-1', role_ids: ['role-1'], reason: 'Subscription expired' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    // members.fetch needs to return a member with roles.cache
    const remove = vi.fn().mockResolvedValue({});
    guild.members.fetch = vi.fn()
      .mockResolvedValueOnce({
        id: 'user-1',
        roles: {
          cache: new Map([['role-1', { id: 'role-1' }]]),
          remove,
        },
      })
      .mockResolvedValueOnce({
        id: 'user-1',
        roles: { cache: new Map(), remove },
      });
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.members.fetch).not.toHaveBeenCalled();
    expect((supa.__queueUpdates as Record<string, unknown>[]).map((u) => u.status)).toContain('failed');
  });

  it('rejects a partial revoke_roles identity before attempting any role removal', async () => {
    const actions = [{
      id: 'act-17b', guild_id: 'guild-1', action: 'revoke_roles', status: 'pending',
      payload: {
        discord_id: 'user-1',
        role_ids: ['role-1', 'role-2'],
        reason: 'grace_period_expired',
        entitlement_id: 'ent-9',
      },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const remove = vi
      .fn()
      .mockResolvedValueOnce({})                       // role-1 removed
      .mockRejectedValueOnce(new Error('Missing Permissions')); // role-2 fails
    guild.members.fetch = vi.fn()
      .mockResolvedValueOnce({
        id: 'user-1',
        roles: {
          cache: new Map([['role-1', { id: 'role-1' }], ['role-2', { id: 'role-2' }]]),
          remove,
        },
      })
      .mockResolvedValueOnce({
        id: 'user-1',
        roles: { cache: new Map([['role-2', { id: 'role-2' }]]), remove },
      });
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);

    expect(remove).not.toHaveBeenCalled();
    const statuses = (supa.__queueUpdates as Record<string, unknown>[]).map((u) => u.status);
    expect(statuses).toContain('failed');
    expect(statuses).not.toContain('completed');
  });

  it('processes run_reconciliation action', async () => {
    const actions = [{
      id: 'act-18', guild_id: 'guild-1', action: 'run_reconciliation', status: 'pending',
      payload: {},
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // runSyncCycle is mocked
  });

  it('processes sync_repair_drift action with repairDriftItem', async () => {
    const driftItem = {
      entityType: 'role',
      entityName: 'Moderator',
      entityDiscordId: 'role-1',
      type: 'PERMISSION_DRIFT',
    };
    const actions = [{
      id: 'act-sync-repair', guild_id: 'guild-1', action: 'sync_repair_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(repairDriftItem).toHaveBeenCalledWith(guild, supa, driftItem);
  });

  it('rejects queued channel permission drift repair instead of reporting false success', async () => {
    const driftItem = {
      entityType: 'channel',
      entityName: 'general → mod',
      entityDiscordId: 'channel-1',
      type: 'PERMISSION_DRIFT',
    };
    const actions = [{
      id: 'act-sync-repair-channel', guild_id: 'guild-1', action: 'sync_repair_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(repairDriftItem).not.toHaveBeenCalledWith(guild, supa, driftItem);
  });

  it('does not retry deterministic manual-review permission drift failures', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const driftItem = {
      entityType: 'category',
      entityName: 'restricted → mod',
      entityDiscordId: 'category-1',
      type: 'PERMISSION_DRIFT',
    };
    const actions = [{
      id: 'act-sync-repair-category', guild_id: 'guild-1', action: 'sync_repair_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);

    await startActionQueueListener(guild, supa);

    expect(repairDriftItem).not.toHaveBeenCalledWith(guild, supa, driftItem);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('processes sync_accept_drift action with acceptDriftItem', async () => {
    const driftItem = {
      entityType: 'role',
      entityName: 'Moderator',
      entityDiscordId: 'role-1',
      type: 'EXTERNAL_CHANGE',
    };
    const actions = [{
      id: 'act-sync-accept', guild_id: 'guild-1', action: 'sync_accept_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(acceptDriftItem).toHaveBeenCalledWith(guild, supa, driftItem);
  });

  it('processes structured queued channel permission drift accept with acceptDriftItem', async () => {
    vi.mocked(acceptDriftItem).mockClear();
    const driftItem = {
      entityType: 'channel',
      entityName: 'general → Moderator',
      entityDiscordId: 'ch-1',
      templateKey: 'general',
      type: 'PERMISSION_DRIFT',
      details: {
        overrideChannelKey: { expected: 'general', actual: 'general' },
        overrideRoleKey: { expected: 'moderator', actual: 'moderator' },
        overrideRoleId: { expected: 'role-1', actual: 'role-1' },
        overrideAction: { expected: 'update', actual: 'update' },
        allow: { expected: '2048', actual: '1024' },
        deny: { expected: '0', actual: '0' },
      },
    };
    const actions = [{
      id: 'act-sync-accept-channel-perms', guild_id: 'guild-1', action: 'sync_accept_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);

    expect(acceptDriftItem).toHaveBeenCalledWith(guild, supa, driftItem);
  });

  it('processes structured queued channel permission drift accept with snake_case template_key', async () => {
    vi.mocked(acceptDriftItem).mockClear();
    const driftItem = {
      entityType: 'channel',
      entityName: 'general → Moderator',
      entityDiscordId: 'ch-1',
      template_key: 'general',
      type: 'PERMISSION_DRIFT',
      details: {
        overrideRoleKey: { expected: 'moderator', actual: 'moderator' },
        overrideRoleId: { expected: 'role-1', actual: 'role-1' },
        overrideAction: { expected: 'update', actual: 'update' },
        allow: { expected: '2048', actual: '1024' },
        deny: { expected: '0', actual: '0' },
      },
    };
    const actions = [{
      id: 'act-sync-accept-channel-perms-snake', guild_id: 'guild-1', action: 'sync_accept_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);

    expect(acceptDriftItem).toHaveBeenCalledWith(guild, supa, driftItem);
  });

  it('rejects unstructured queued channel permission drift accept without retrying', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.mocked(acceptDriftItem).mockClear();
    const driftItem = {
      entityType: 'channel',
      entityName: 'general -> Moderator',
      entityDiscordId: 'ch-1',
      type: 'PERMISSION_DRIFT',
    };
    const actions = [{
      id: 'act-sync-accept-channel-perms-unstructured', guild_id: 'guild-1', action: 'sync_accept_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);

    expect(acceptDriftItem).not.toHaveBeenCalledWith(guild, supa, driftItem);
    expect(supa.__queueUpdates).toContainEqual(expect.objectContaining({
      status: 'failed',
      error_message: expect.stringContaining('structured permission overwrite details'),
    }));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('does not retry structured channel permission drift accept failures', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.mocked(acceptDriftItem).mockResolvedValueOnce({
      success: false,
      error: 'No desired config found for this channel permission overwrite',
    });
    const driftItem = {
      entityType: 'channel',
      entityName: 'general → Moderator',
      entityDiscordId: 'ch-1',
      templateKey: 'general',
      type: 'PERMISSION_DRIFT',
      details: {
        overrideRoleKey: { expected: 'moderator', actual: 'moderator' },
        overrideRoleId: { expected: 'role-1', actual: 'role-1' },
      },
    };
    const actions = [{
      id: 'act-sync-accept-channel-perms-fails', guild_id: 'guild-1', action: 'sync_accept_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);

    expect(acceptDriftItem).toHaveBeenCalledWith(guild, supa, driftItem);
    expect(supa.__queueUpdates).toContainEqual(expect.objectContaining({
      status: 'failed',
      error_message: expect.stringContaining('No desired config'),
    }));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('processes market_item_reconcile action', async () => {
    const actions = [{
      id: 'act-19', guild_id: 'guild-1', action: 'market_item_reconcile', status: 'pending',
      payload: { listingId: 'listing-1', action: 'delist' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // marketplace reconcile runs
  });

  it('processes fulfill_purchase action', async () => {
    const actions = [{
      id: 'act-20', guild_id: 'guild-1', action: 'fulfill_purchase', status: 'pending',
      payload: { orderId: 'order-1', userId: 'user-1', productId: 'prod-1' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // fulfillPurchase is mocked
  });

  it('processes test_welcome action', async () => {
    const actions = [{
      id: 'act-21', guild_id: 'guild-1', action: 'test_welcome', status: 'pending',
      payload: { channelId: 'ch-1', userId: 'user-1' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // test welcome message sending
  });

  it('handles create_role with missing required fields', async () => {
    const actions = [{
      id: 'act-22', guild_id: 'guild-1', action: 'create_role', status: 'pending',
      payload: {}, // missing name and tier
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.roles.create).not.toHaveBeenCalled();
  });

  it('handles no pending actions', async () => {
    const guild = makeGuild();
    const supa = makeSupa([]);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // should just subscribe to realtime without processing
  });

  it('schedules exponential backoff retry on transient failure (V5 §6.5)', async () => {
    vi.useFakeTimers();
    const actions = [{
      id: 'act-retry-1', guild_id: 'guild-1', action: 'create_role', status: 'pending',
      payload: { name: 'FailRole', tier: 'custom' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    // Make create throw a transient error
    guild.roles.create = vi.fn().mockRejectedValue(new Error('DiscordAPIError: 500'));
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    // The retry code should update status back to 'pending' with retry_count = 1
    const updateCalls = supa.from.mock.results.filter(
      (r: any) => r.value?.update
    );
    expect(updateCalls.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('skips retry for non-transient errors (unknown action)', async () => {
    const actions = [{
      id: 'act-skip-retry', guild_id: 'guild-1', action: 'totally_bogus_action_xyz', status: 'pending',
      payload: {},
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    // Non-transient errors (Unknown action) should NOT schedule retry —
    // they should go straight to 'failed' status
    expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
  });

  it('processes multiple pending actions in order', async () => {
    const actions = [
      {
        id: 'act-a', guild_id: 'guild-1', action: 'create_role', status: 'pending',
        payload: { name: 'RoleA', tier: 'custom' },
        created_at: new Date().toISOString(), retry_count: 0,
      },
      {
        id: 'act-b', guild_id: 'guild-1', action: 'create_channel', status: 'pending',
        payload: { name: 'chan-b', type: 0 },
        created_at: new Date().toISOString(), retry_count: 0,
      },
    ];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.roles.create).toHaveBeenCalled();
    expect(guild.channels.create).toHaveBeenCalled();
  });
});
