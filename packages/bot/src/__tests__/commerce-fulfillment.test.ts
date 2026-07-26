/**
 * Tests for services/commerce-fulfillment.ts — the post-payment
 * fulfillment pipeline handling purchases, subscriptions, cancellations,
 * and suspensions. 185 uncovered statements.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  // commerce-fulfillment reads the configured grace window via this shared
  // helper; the mock returns the default so the suspend flow proceeds.
  getGracePeriodDays: vi.fn(async () => 3),
  DEFAULT_GRACE_PERIOD_DAYS: 3,
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setColor() { return this; } setTitle() { return this; }
    setDescription() { return this; } setFooter() { return this; }
    setTimestamp() { return this; } addFields() { return this; }
  },
  Collection: class extends Map {},
}));

const {
  mockGrant,
  mockRevoke,
  mockSuspend,
  mockReactivate,
  mockEnsurePurchaseGrantedRoles,
  mockBeginRoleDelivery,
  mockFinishRoleDelivery,
  mockExecuteRoleCleanup,
} = vi.hoisted(() => ({
  mockGrant: vi.fn(async () => 'ent-123'),
  mockRevoke: vi.fn(async () => ({
    disposition: 'applied',
    transitionId: '11111111-1111-4111-8111-111111111111',
    status: 'cancelled',
  })),
  mockSuspend: vi.fn(async () => true),
  mockReactivate: vi.fn(async () => true),
  mockEnsurePurchaseGrantedRoles: vi.fn(async () => undefined),
  mockBeginRoleDelivery: vi.fn(async (_entitlementId, _contract, claim) => ({
    state: 'live',
    attempt: {
      ...claim,
      intentId: '11111111-1111-4111-8111-111111111111',
      mutationToken: '22222222-2222-4222-8222-222222222222',
    },
  })),
  mockFinishRoleDelivery: vi.fn(async () => ({
    state: 'open', settled: false, authorityEmpty: false, disposition: 'confirmed_open',
  })),
  mockExecuteRoleCleanup: vi.fn(async () => ({ state: 'settled', settled: true })),
}));

vi.mock('../features/commerce/entitlement-service.js', () => ({
  PurchaseRoleDeliveryTerminalNoopError: class extends Error {
    constructor(readonly entitlementId: string | null) { super('terminal noop'); }
  },
  EntitlementService: class {
    private activeAttempt: any = null;
    private confirmedReplay = false;
    grant = async (opts: any) => {
      const result = await (mockGrant as any)(opts);
      if (result && opts.roleDeliveryClaim) {
        this.activeAttempt = {
          ...opts.roleDeliveryClaim,
          intentId: '11111111-1111-4111-8111-111111111111',
          mutationToken: '22222222-2222-4222-8222-222222222222',
        };
      }
      return result;
    };
    revoke = mockRevoke;
    suspend = mockSuspend;
    reactivate = async (...args: any[]) => {
      const result = await (mockReactivate as any)(...args);
      if (result) {
        const claim = args[2];
        this.activeAttempt = claim ? {
          ...claim,
          intentId: '11111111-1111-4111-8111-111111111111',
          mutationToken: '22222222-2222-4222-8222-222222222222',
        } : null;
      }
      return result;
    };
    ensurePurchaseGrantedRoles = mockEnsurePurchaseGrantedRoles;
    beginPurchaseRoleDeliveryAttempt = async (...args: any[]) => {
      const result: any = await (mockBeginRoleDelivery as any)(...args);
      this.confirmedReplay = result?.state === 'confirmed_live';
      this.activeAttempt = result?.state === 'live' ? result.attempt : null;
      return result;
    };
    getActivePurchaseRoleDeliveryAttempt = () => this.activeAttempt;
    wasPurchaseRoleDeliveryConfirmedReplay = () => this.confirmedReplay;
    finishPurchaseRoleDeliveryAttempt = async (...args: any[]) => {
      const result = await (mockFinishRoleDelivery as any)(...args);
      this.activeAttempt = null;
      return result;
    };
    executeOwnedPurchaseRoleCleanup = async (...args: any[]) => {
      const result = await (mockExecuteRoleCleanup as any)(...args);
      if (result.settled) this.activeAttempt = null;
      return result;
    };
  },
}));

const { mockDeliverReceiptDM } = vi.hoisted(() => ({
  mockDeliverReceiptDM: vi.fn(async () => {}),
}));

vi.mock('../features/commerce/receipt-builder.js', () => ({
  sendReceiptDM: vi.fn(async () => true),
  deliverReceiptDM: mockDeliverReceiptDM,
}));

vi.mock('../services/fraud-detection.js', () => ({
  checkPurchaseVelocity: vi.fn(async () => ({ flagged: false })),
  checkPaymentPattern: vi.fn(async () => ({ flagged: false })),
  checkCriticalThreshold: vi.fn(async () => ({ flagged: false })),
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { CommerceFulfillmentService, type FulfillmentPayload } from '../services/commerce-fulfillment.js';
// Mocked above — imported here so the wiring test can override its return
// value and assert commerce-fulfillment threads it into suspend().
import { getGracePeriodDays } from '@somnibot/shared';

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of [
    'from',
    'select',
    'insert',
    'update',
    'delete',
    'upsert',
    'eq',
    'neq',
    'in',
    'gt',
    'contains',
    'order',
    'limit',
    'single',
    'maybeSingle',
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa(overrides: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => {
      const data = Object.hasOwn(overrides, table)
        ? overrides[table]
        : table === 'customers'
          ? { id: 'cust-1', guild_id: 'guild-1', discord_id: 'user-1' }
          : table === 'orders'
              ? {
                 id: 'order-1',
                 order_number: 'ORD-001',
                 guild_id: 'guild-1',
                 customer_id: 'cust-1',
                 product_id: 'prod-1',
                 plan_id: null,
                 paypal_subscription_id: null,
                amount_cents: 999,
                currency: 'USD',
                source: 'purchase',
                status: 'completed',
                granted_role_ids_snapshot: ['role-1'],
                granted_channel_ids_snapshot: [],
                temporary_role_grants_snapshot: [],
                grant_snapshot_frozen_at: '2026-07-11T00:00:00.000Z',
              }
          : null;
      return makeChain({ data, error: null });
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

function makeGuild() {
  return {
    id: 'guild-1', name: 'Test',
    members: { fetch: vi.fn().mockResolvedValue({ id: 'user-1', roles: { add: vi.fn(), remove: vi.fn() } }) },
    client: { users: { fetch: vi.fn().mockResolvedValue({ id: 'user-1', send: vi.fn() }) } },
  } as any;
}

function makeTemporaryRoleHarness(opts: {
  initialRoleIds?: string[];
  prepareError?: { message: string };
  prepareData?: (roleId: string, call: number) => unknown;
  fetchError?: Error;
  addError?: Error;
  removalIntentResults?: Array<{ data: unknown; error: unknown }>;
  acknowledgementResults?: Array<{ data: unknown; error: unknown }>;
  inspectionResults?: Array<{ data: unknown; error: unknown }>;
  reuseEntitlementOnRetry?: boolean;
  liveTemporaryOwners?: unknown[];
  liveTemporaryOwnerResults?: Array<{ data: unknown; error: unknown }>;
  liveEntitlementOwners?: unknown[];
  liveEntitlementParentOrders?: Map<string, unknown>;
  liveEntitlementOwnerPageErrors?: number[];
  liveEntitlementParentErrors?: number[];
  orderPlanId?: string | null;
  orderPaypalSubscriptionId?: string | null;
  orderGrantedRoleIds?: string[];
  orderTemporaryRoleGrants?: Array<{ role_id: string; duration_seconds: number }>;
  attachResults?: Array<{ data: unknown; error: unknown }>;
  promotionResults?: Array<{ data: unknown; error: unknown }>;
  releaseResults?: Array<{ data: unknown; error: unknown }>;
} = {}) {
  const heldRoleIds = new Set(opts.initialRoleIds ?? []);
  const operations: string[] = [];
  const tempUpdates: Array<Record<string, unknown>> = [];
  let acknowledgementCall = 0;
  let prepareCall = 0;
  let removalIntentCall = 0;
  let inspectionCall = 0;
  let entitlementLookup = 0;
  let entitlementOwnerPageCall = 0;
  let entitlementParentCall = 0;
  const entitlementOwnerGtValues: string[] = [];
  const grantDurations = new Map<string, number>();
  const reservedGrantIds = new Set<string>();
  const removalOwnedGrantIds = new Set<string>();

  const member: any = {
    id: 'user-1',
    roles: {
      cache: { has: (roleId: string) => heldRoleIds.has(roleId) },
      add: vi.fn(async (roleId: string) => {
        operations.push(`discord-add:${roleId}`);
        if (opts.addError) throw opts.addError;
        heldRoleIds.add(roleId);
        return member;
      }),
      remove: vi.fn(async (roleId: string) => {
        operations.push(`discord-remove:${roleId}`);
        heldRoleIds.delete(roleId);
        return member;
      }),
    },
  };
  const guild = makeGuild();
  guild.members.fetch = vi.fn(async () => {
    if (opts.fetchError) throw opts.fetchError;
    return member;
  });

  const supabase: any = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'commerce_attach_temp_role_delivery') {
        const scripted = opts.attachResults?.shift();
        if (scripted) return scripted;
        const grantId = String(args.p_grant_id ?? '');
        const roleId = String(args.p_role_id ?? '');
        operations.push(`delivery-attach:${grantId}`);
        const roleWasPresent = args.p_role_was_present === true;
        const transferablePredecessor = (opts.liveTemporaryOwners ?? []).some((owner) => {
          const row = owner as Record<string, unknown> | null;
          return row?.role_id === roleId && row.remove_on_expiry === true;
        });
        if (removalOwnedGrantIds.has(grantId)) {
          return {
            data: {
              intent_state: 'open', may_mutate: true, owns_removal: true,
              claim_newly_acquired: false, disposition: 'owned_replay',
            },
            error: null,
          };
        }
        if (reservedGrantIds.has(grantId)) {
          return {
            data: {
              intent_state: 'open', may_mutate: true, owns_removal: false,
              claim_newly_acquired: false, disposition: 'reserved_replay',
            },
            error: null,
          };
        }
        const ownershipPreexisting = (opts.orderGrantedRoleIds ?? []).includes(roleId)
          || transferablePredecessor;
        if (roleWasPresent && !ownershipPreexisting) {
          return {
            data: {
              intent_state: 'open', may_mutate: true, owns_removal: false,
              claim_newly_acquired: false, disposition: 'manual_baseline',
            },
            error: null,
          };
        }
        reservedGrantIds.add(grantId);
        const disposition = roleWasPresent ? 'reserve_inherited' : 'reserve_add';
        return {
          data: {
            intent_state: 'open',
            may_mutate: true,
            owns_removal: false,
            claim_newly_acquired: disposition === 'reserve_add',
            disposition,
          },
          error: null,
        };
      }
      if (name === 'commerce_confirm_temp_role_delivery') {
        const scripted = opts.promotionResults?.shift();
        if (scripted) return scripted;
        const grantId = String(args.p_grant_id ?? '');
        const promoted = reservedGrantIds.delete(grantId);
        if (promoted) removalOwnedGrantIds.add(grantId);
        operations.push(`delivery-promote:${grantId}`);
        const appliedAt = '2030-01-01T00:00:00.000Z';
        const durationSeconds = grantDurations.get(grantId) ?? 60;
        return {
          data: {
            intent_state: 'open',
            promoted,
            owns_removal: removalOwnedGrantIds.has(grantId),
            grant_status: 'applied',
            expires_at: new Date(Date.parse(appliedAt) + durationSeconds * 1_000).toISOString(),
          },
          error: null,
        };
      }
      if (name === 'commerce_release_unconsumed_temp_role_claim') {
        const scripted = opts.releaseResults?.shift();
        if (scripted) return scripted;
        const grantId = String(args.p_grant_id ?? '');
        reservedGrantIds.delete(grantId);
        operations.push(`ownership-release:${grantId}`);
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
      if (name === 'commerce_find_live_temp_role_owner') {
        const scripted = opts.liveTemporaryOwnerResults?.shift();
        if (scripted) return scripted;
        const rawOwner = opts.liveTemporaryOwners?.[0] as Record<string, unknown> | undefined;
        return {
          data: rawOwner ? {
            remove_on_expiry: false,
            order_id: 'order-other',
            ...rawOwner,
          } : null,
          error: null,
        };
      }
      if (name === 'commerce_inspect_temp_role_grant') {
        const grantId = String(args.p_grant_id ?? '');
        const configured = opts.inspectionResults?.[inspectionCall++];
        if (configured) return configured;
        const roleId = grantId.replace(/^grant-/, '');
        return {
          data: {
            id: grantId,
            guild_id: 'guild-1',
            user_id: 'user-1',
            role_id: roleId,
            expires_at: '2999-01-01T00:00:00.000Z',
            duration_seconds: grantDurations.get(grantId) ?? 60,
            grant_status: 'pending',
            remove_on_expiry: removalOwnedGrantIds.has(grantId),
            applied_at: null,
            order_id: 'order-1',
            parent_order_status: 'completed',
            entitlement_is_live: true,
          },
          error: null,
        };
      }
      if (name === 'commerce_acknowledge_temp_role_grant') {
        const grantId = String(args.p_grant_id ?? '');
        operations.push(`provenance-ack:${grantId}`);
        const configured = opts.acknowledgementResults?.[acknowledgementCall++];
        if (configured) return configured;
        const appliedAt = '2030-01-01T00:00:00.000Z';
        const durationSeconds = grantDurations.get(grantId) ?? 60;
        return {
          data: {
            id: grantId,
            grant_status: 'applied',
            applied_at: appliedAt,
            expires_at: new Date(Date.parse(appliedAt) + durationSeconds * 1_000).toISOString(),
          },
          error: null,
        };
      }
      const roleId = String(args.p_role_id ?? '');
      const grantId = `grant-${roleId}`;
      grantDurations.set(grantId, Number(args.p_duration_seconds));
      operations.push(`prepare-committed:${roleId}`);
      if (opts.prepareError) return { data: null, error: opts.prepareError };
      const configuredPrepare = opts.prepareData?.(roleId, prepareCall++);
      const prepared = configuredPrepare && typeof configuredPrepare === 'object'
        ? { remove_on_expiry: false, ...configuredPrepare }
        : configuredPrepare ?? {
            id: grantId,
            grant_status: 'pending',
            remove_on_expiry: false,
            expires_at: '2999-01-01T00:00:00.000Z',
          };
      if (
        prepared
        && typeof prepared === 'object'
        && 'id' in prepared
        && 'remove_on_expiry' in prepared
        && prepared.remove_on_expiry === true
      ) {
        removalOwnedGrantIds.add(String(prepared.id));
      }
      return {
        data: prepared,
        error: null,
      };
    }),
    from: vi.fn((table: string) => {
      if (table === 'entitlements') {
        entitlementLookup++;
        const data = opts.reuseEntitlementOnRetry && entitlementLookup > 1
          ? {
              id: 'ent-123',
              customer_id: 'cust-1',
              product_id: 'prod-1',
              plan_id: null,
              license_key_id: null,
              type: 'one_time',
              status: 'active',
              source: 'purchase',
              granted_role_ids: ['role-1'],
              granted_channel_ids: [],
            }
          : null;
        const chain = makeChain({ data, error: null });
        chain.maybeSingle = vi.fn(async () => ({ data, error: null }));
        let afterId: string | null = null;
        chain.gt = vi.fn((column: string, value: unknown) => {
          if (column === 'id') {
            afterId = String(value);
            entitlementOwnerGtValues.push(afterId);
          }
          return chain;
        });
        chain.limit = vi.fn(async (pageSize: number) => {
          entitlementOwnerPageCall += 1;
          if (opts.liveEntitlementOwnerPageErrors?.includes(entitlementOwnerPageCall)) {
            return { data: null, error: { message: 'entitlement owner unavailable' } };
          }
          const owners = opts.liveEntitlementOwners ?? [];
          const start = afterId === null
            ? 0
            : owners.findIndex((owner) =>
                String((owner as Record<string, unknown>).id) > afterId!);
          return {
            data: start === -1 ? [] : owners.slice(start, start + pageSize),
            error: null,
          };
        });
        return chain;
      }
      if (table === 'customers') {
        return makeChain({
          data: { id: 'cust-1', guild_id: 'guild-1', discord_id: 'user-1' },
          error: null,
        });
      }
      if (table === 'orders') {
        const mainOrder = {
          id: 'order-1',
          order_number: 'ORD-001',
          guild_id: 'guild-1',
          customer_id: 'cust-1',
          product_id: 'prod-1',
          plan_id: opts.orderPlanId ?? null,
          paypal_subscription_id: opts.orderPaypalSubscriptionId ?? null,
          amount_cents: 999,
          currency: 'USD',
          source: 'purchase',
          status: 'completed',
          granted_role_ids_snapshot: opts.orderGrantedRoleIds ?? ['role-1'],
          granted_channel_ids_snapshot: [],
          temporary_role_grants_snapshot: opts.orderTemporaryRoleGrants ?? [
            { role_id: TEMP_ROLE_ID, duration_seconds: 60 },
          ],
          grant_snapshot_frozen_at: '2026-07-11T00:00:00.000Z',
        };
        let targetOrderId = 'order-1';
        const chain = makeChain({ data: mainOrder, error: null });
        chain.eq = vi.fn((column: string, value: unknown) => {
          if (column === 'id') targetOrderId = String(value);
          return chain;
        });
        chain.maybeSingle = vi.fn(async () => {
          if (targetOrderId === 'order-1') return { data: mainOrder, error: null };
          entitlementParentCall += 1;
          if (opts.liveEntitlementParentErrors?.includes(entitlementParentCall)) {
            return { data: null, error: { message: 'parent order unavailable' } };
          }
          return {
            data: opts.liveEntitlementParentOrders?.get(targetOrderId) ?? null,
            error: null,
          };
        });
        return chain;
      }
      if (table !== 'temp_role_grants') {
        return makeChain({ data: null, error: null });
      }

      let updatePayload: Record<string, unknown> = {};
      let targetId = '';
      const chain: any = {};
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        updatePayload = payload;
        tempUpdates.push(payload);
        return chain;
      });
      chain.eq = vi.fn((column: string, value: unknown) => {
        if (column === 'id') targetId = String(value);
        return chain;
      });
      chain.select = vi.fn(() => chain);
      chain.neq = vi.fn(() => chain);
      chain.in = vi.fn(() => chain);
      chain.gt = vi.fn(() => chain);
      chain.or = vi.fn(() => chain);
      chain.order = vi.fn(() => chain);
      chain.limit = vi.fn(async () => ({
        data: opts.liveTemporaryOwners ?? [],
        error: null,
      }));
      chain.maybeSingle = vi.fn(async () => {
        if (updatePayload.remove_on_expiry === true) {
          operations.push(`removal-intent-ack:${targetId}`);
          const configured = opts.removalIntentResults?.[removalIntentCall++];
          const result = configured ?? {
            data: { id: targetId, remove_on_expiry: true },
            error: null,
          };
          if (!result.error && (result.data as Record<string, unknown> | null)?.remove_on_expiry) {
            removalOwnedGrantIds.add(targetId);
          }
          return result;
        }
        operations.push(`provenance-ack:${targetId}`);
        const configured = opts.acknowledgementResults?.[acknowledgementCall++];
        return configured ?? { data: { id: targetId }, error: null };
      });
      chain.then = (resolve: Function) => resolve({
        data: null,
        error: null,
        updatePayload,
      });
      return chain;
    }),
  };

  return {
    guild,
    member,
    supabase,
    operations,
    tempUpdates,
    removalOwnedGrantIds,
    heldRoleIds,
    entitlementOwnerGtValues,
    getEntitlementOwnerPageCalls: () => entitlementOwnerPageCall,
  };
}

const TEST_ACTION_CLAIM = {
  actionId: '33333333-3333-4333-8333-333333333333',
  claimToken: '44444444-4444-4444-8444-444444444444',
};

function fulfillClaimed(
  service: CommerceFulfillmentService,
  payload: FulfillmentPayload,
) {
  return service.fulfill(payload, TEST_ACTION_CLAIM);
}

const basePayload: FulfillmentPayload = {
  fulfillment_type: 'one_time_purchase',
  guild_id: 'guild-1',
  customer_id: 'cust-1',
  discord_id: 'user-1',
  product_id: 'prod-1',
  product_name: 'VIP Pass',
  order_id: 'order-1',
  order_number: 'ORD-001',
  amount_cents: 999,
  currency: 'USD',
  granted_role_ids: ['role-1'],
  granted_channel_ids: [],
  entitlement_type: 'one_time',
};

const subscriptionOrderSnapshot = {
  id: 'order-1',
  order_number: 'ORD-001',
  guild_id: 'guild-1',
  customer_id: 'cust-1',
  product_id: 'prod-1',
  plan_id: 'plan-monthly',
  paypal_subscription_id: 'SUB-001',
  amount_cents: 999,
  currency: 'USD',
  source: 'purchase',
  status: 'completed',
  granted_role_ids_snapshot: ['role-1'],
  granted_channel_ids_snapshot: [],
  temporary_role_grants_snapshot: [],
  grant_snapshot_frozen_at: '2026-07-11T00:00:00.000Z',
};

const subscriptionActivationPayload: FulfillmentPayload = {
  ...basePayload,
  fulfillment_type: 'subscription_activated',
  plan_id: 'plan-monthly',
  paypal_subscription_id: 'SUB-001',
  entitlement_type: 'subscription',
};

const subscriptionOrderIdentityRejectionCases: Array<{
  label: string;
  orderPatch: Record<string, unknown>;
  payloadPatch: Partial<FulfillmentPayload>;
}> = [
  {
    label: 'order number',
    orderPatch: {},
    payloadPatch: { order_number: 'ORD-TAMPERED' },
  },
  {
    label: 'PayPal subscription ID value',
    orderPatch: {},
    payloadPatch: { paypal_subscription_id: 'SUB-TAMPERED' },
  },
  {
    label: 'missing PayPal subscription ID',
    orderPatch: {},
    payloadPatch: { paypal_subscription_id: undefined },
  },
  {
    label: 'unexpected PayPal subscription ID',
    orderPatch: { paypal_subscription_id: null },
    payloadPatch: {},
  },
  {
    label: 'malformed matching PayPal subscription ID',
    orderPatch: { paypal_subscription_id: ' SUB-MALFORMED' },
    payloadPatch: { paypal_subscription_id: ' SUB-MALFORMED' },
  },
];

const LEGACY_SUBSCRIPTION_ROLE_ID = '111111111111111111';

const legacySubscriptionOrder = {
  ...subscriptionOrderSnapshot,
  order_number: 'ORD-001',
  paypal_subscription_id: 'SUB-RECOVERY-1',
  granted_role_ids_snapshot: [],
  granted_channel_ids_snapshot: [],
  grant_snapshot_frozen_at: null,
};

const legacySubscriptionContract = {
  order_id: 'order-1',
  source_queue_id: '00000000-0000-4000-8000-000000000001',
  guild_id: 'guild-1',
  customer_id: 'cust-1',
  discord_id: 'user-1',
  product_id: 'prod-1',
  product_name: 'VIP Pass',
  order_number: 'ORD-001',
  plan_id: 'plan-monthly',
  paypal_subscription_id: 'SUB-RECOVERY-1',
  paypal_plan_id: 'P-MONTHLY-1',
  amount_cents: 999,
  currency: 'USD',
  granted_role_ids_snapshot: [LEGACY_SUBSCRIPTION_ROLE_ID],
  granted_channel_ids_snapshot: [],
  persisted_at: '2026-07-11T00:01:00.000Z',
};

const TEMP_ROLE_ID = '12345678901234567';
const TEMP_ROLE_A = '12345678901234568';
const TEMP_ROLE_Z = '12345678901234569';

const subscriptionLifecyclePayload: FulfillmentPayload = {
  ...basePayload,
  fulfillment_type: 'subscription_cancelled',
  entitlement_type: 'subscription',
};

function subscriptionLifecycleEntitlement(
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'ent-subscription',
    guild_id: 'guild-1',
    customer_id: 'cust-1',
    order_id: 'order-1',
    product_id: 'prod-1',
    plan_id: 'plan-monthly',
    type: 'subscription',
    status,
    source: 'purchase',
    customers: {
      id: 'cust-1',
      guild_id: 'guild-1',
      discord_id: 'user-1',
    },
    ...overrides,
  };
}

function makeEntitlementLookupResult(result: { data: unknown; error: unknown }) {
  return {
    from: vi.fn((table: string) => makeChain(
      table === 'entitlements' ? result : { data: null, error: null },
    )),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

describe('CommerceFulfillmentService', () => {
  let service: CommerceFulfillmentService;
  let eventBus: any;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    service = new CommerceFulfillmentService(makeGuild(), makeSupa() as any, eventBus);
  });

  it('rejects a cross-guild queued payload before any database or Discord call', async () => {
    const supabase = { from: vi.fn(), rpc: vi.fn() } as any;
    const guild = makeGuild();
    service = new CommerceFulfillmentService(guild, supabase, eventBus);

    const result = await fulfillClaimed(service, { ...basePayload, guild_id: 'different-guild' });

    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('guild/identity');
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(guild.members.fetch).not.toHaveBeenCalled();
    expect(guild.client.users.fetch).not.toHaveBeenCalled();
  });

  describe('one_time_purchase', () => {
    it('grants entitlement, emits event, sends receipt', async () => {
      const result = await fulfillClaimed(service, basePayload);
      expect(result.success).toBe(true);
      expect(result.entitlementId).toBe('ent-123');
      expect(result.eventEmitted).toBe(true);
      expect(result.receiptSent).toBe(true);
      expect(mockGrant).toHaveBeenCalledWith({
        customerId: 'cust-1',
        productId: 'prod-1',
        productName: 'VIP Pass',
        orderId: 'order-1',
        licenseKeyId: undefined,
        discordId: 'user-1',
        type: 'one_time',
        source: 'purchase',
        grantedRoleIds: ['role-1'],
        grantedChannelIds: [],
        roleDeliveryClaim: TEST_ACTION_CLAIM,
      });
      expect(mockEnsurePurchaseGrantedRoles).not.toHaveBeenCalled();
    });

    it('reports error when entitlement grant fails', async () => {
      mockGrant.mockResolvedValueOnce(null as any);
      const result = await fulfillClaimed(service, basePayload);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Failed to create entitlement');
    });

    it.each([
      {
        label: 'wrong product',
        orderPatch: { product_id: 'different-product' },
        expectedError: 'frozen snapshot',
      },
      {
        label: 'uncommitted pending status',
        orderPatch: { status: 'pending' },
        expectedError: 'not committed',
      },
      {
        label: 'uncommitted pending-review status',
        orderPatch: { status: 'pending_review' },
        expectedError: 'not committed',
      },
      {
        label: 'tampered role snapshot',
        orderPatch: { granted_role_ids_snapshot: ['role-attacker'] },
        expectedError: 'frozen snapshot',
      },
    ])('rejects an order with $label before entitlement or Discord mutation', async ({
      orderPatch,
      expectedError,
    }) => {
      const supabase = makeSupa({
        orders: {
          id: 'order-1',
          order_number: 'ORD-001',
          guild_id: 'guild-1',
          customer_id: 'cust-1',
          product_id: 'prod-1',
          plan_id: null,
          paypal_subscription_id: null,
          amount_cents: 999,
          currency: 'USD',
          source: 'purchase',
          status: 'completed',
          granted_role_ids_snapshot: ['role-1'],
          granted_channel_ids_snapshot: [],
          temporary_role_grants_snapshot: [],
          grant_snapshot_frozen_at: '2026-07-11T00:00:00.000Z',
          ...orderPatch,
        },
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supabase as any, eventBus);

      const result = await fulfillClaimed(service, basePayload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain(expectedError);
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockEnsurePurchaseGrantedRoles).not.toHaveBeenCalled();
      expect(supabase.rpc).not.toHaveBeenCalled();
      expect(guild.members.fetch).not.toHaveBeenCalled();
    });

    it.each(['refunded', 'disputed', 'cancelled'])(
      'treats the genuinely terminal %s order as a safe no-op',
      async (status) => {
        const supabase = makeSupa({
          orders: {
            ...subscriptionOrderSnapshot,
            plan_id: null,
            paypal_subscription_id: null,
            status,
          },
        });
        service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

        const result = await fulfillClaimed(service, basePayload);

        expect(result.success).toBe(true);
        expect(mockGrant).not.toHaveBeenCalled();
        expect(mockBeginRoleDelivery).not.toHaveBeenCalled();
        expect(eventBus.emit).not.toHaveBeenCalled();
      },
    );

    it('rejects a PayPal subscription identity on a one-time order even when payload and row match', async () => {
      const supabase = makeSupa({
        orders: {
          ...subscriptionOrderSnapshot,
          plan_id: null,
          paypal_subscription_id: 'SUB-NOT-ONE-TIME',
        },
      });
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        paypal_subscription_id: 'SUB-NOT-ONE-TIME',
      });

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('frozen snapshot');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it.each([
      { field: 'id', row: { id: '' } },
      { field: 'customer', row: { customer_id: 'different-customer' } },
      { field: 'product', row: { product_id: 'different-product' } },
      { field: 'type', row: { type: 'subscription' } },
      { field: 'source', row: { source: 'giveaway' } },
      { field: 'missing source', row: { source: null } },
    ])('fails on an order-scoped entitlement $field mismatch instead of reusing it', async ({ row }) => {
      const supabase = makeSupa({
        entitlements: {
          id: 'ent-123',
          customer_id: 'cust-1',
          product_id: 'prod-1',
          plan_id: null,
          license_key_id: null,
          type: 'one_time',
          status: 'active',
          source: 'purchase',
          granted_role_ids: ['role-1'],
          granted_channel_ids: [],
          ...row,
        },
      });
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, basePayload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('identity validation');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('re-confirms permanent roles before reusing an exact order entitlement', async () => {
      const supabase = makeSupa({
        entitlements: {
          id: 'ent-123',
          customer_id: 'cust-1',
          product_id: 'prod-1',
          plan_id: null,
          license_key_id: null,
          type: 'one_time',
          status: 'active',
          source: 'purchase',
          granted_role_ids: ['role-1'],
          granted_channel_ids: [],
        },
      });
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, basePayload);

      expect(result.success).toBe(true);
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockEnsurePurchaseGrantedRoles).toHaveBeenCalledWith('ent-123', {
        customerId: 'cust-1',
        productId: 'prod-1',
        orderId: 'order-1',
        planId: null,
        discordId: 'user-1',
        grantedRoleIds: ['role-1'],
        entitlementType: 'one_time',
      }, {
        ...TEST_ACTION_CLAIM,
        intentId: '11111111-1111-4111-8111-111111111111',
        mutationToken: '22222222-2222-4222-8222-222222222222',
      });
    });

    it('fails retryably instead of completing when permanent-role confirmation fails', async () => {
      const supabase = makeSupa({
        entitlements: {
          id: 'ent-123',
          customer_id: 'cust-1',
          product_id: 'prod-1',
          plan_id: null,
          license_key_id: null,
          type: 'one_time',
          status: 'active',
          source: 'purchase',
          granted_role_ids: ['role-1'],
          granted_channel_ids: [],
        },
      });
      mockEnsurePurchaseGrantedRoles.mockRejectedValueOnce(new Error('Discord did not confirm role'));
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, basePayload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('Discord did not confirm role');
      expect(result.eventEmitted).not.toBe(true);
      expect(mockDeliverReceiptDM).not.toHaveBeenCalled();
    });

    it('rejects a customer/Discord mismatch before permanent or temporary mutation', async () => {
      const supabase = makeSupa({
        customers: { id: 'cust-1', guild_id: 'guild-1', discord_id: 'different-user' },
        orders: {
          ...subscriptionOrderSnapshot,
          plan_id: null,
          paypal_subscription_id: null,
          temporary_role_grants_snapshot: [
            { role_id: TEMP_ROLE_ID, duration_seconds: 60 },
          ],
        },
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supabase as any, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('customer identity');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockEnsurePurchaseGrantedRoles).not.toHaveBeenCalled();
      expect(supabase.rpc).not.toHaveBeenCalled();
      expect(guild.members.fetch).not.toHaveBeenCalled();
    });

    it('rejects a one-time fulfillment payload whose frozen entitlement type is inconsistent', async () => {
      const supabase = makeSupa({
        entitlements: {
          id: 'ent-123',
          customer_id: 'cust-1',
          product_id: 'prod-1',
          type: 'one_time',
          source: 'purchase',
        },
      });
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        entitlement_type: 'subscription',
      });

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('entitlement type validation');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: 'non-snowflake role ID',
        grant: { role_id: 'role-temp', duration_seconds: 60 },
      },
      {
        label: 'too-short role ID',
        grant: { role_id: '1234567890123456', duration_seconds: 60 },
      },
      {
        label: 'too-long role ID',
        grant: { role_id: '123456789012345678901', duration_seconds: 60 },
      },
      {
        label: 'duration beyond ten years',
        grant: { role_id: TEMP_ROLE_ID, duration_seconds: 315_360_001 },
      },
    ])('rejects $label before entitlement or Discord mutation', async ({ grant }) => {
      const harness = makeTemporaryRoleHarness();
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [grant],
      });

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('Malformed temporary role grant snapshot');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(harness.supabase.rpc).not.toHaveBeenCalled();
      expect(harness.guild.members.fetch).not.toHaveBeenCalled();
    });

    it('reserves temporary-role provenance before Discord add, then atomically promotes it', async () => {
      const harness = makeTemporaryRoleHarness({
        orderTemporaryRoleGrants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 3_600 }],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);
      const payload: FulfillmentPayload = {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 3_600 }],
      };

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(true);
      expect(mockGrant.mock.invocationCallOrder[0]).toBeLessThan(
        harness.supabase.rpc.mock.invocationCallOrder[0],
      );
      expect(harness.supabase.rpc).toHaveBeenCalledWith(
        'commerce_prepare_temp_role_grant',
        {
          p_guild_id: 'guild-1',
          p_user_id: 'user-1',
          p_role_id: TEMP_ROLE_ID,
          p_order_id: 'order-1',
          p_product_id: 'prod-1',
          p_duration_seconds: 3_600,
        },
      );
      expect(harness.operations).toEqual([
        `prepare-committed:${TEMP_ROLE_ID}`,
        `delivery-attach:grant-${TEMP_ROLE_ID}`,
        `discord-add:${TEMP_ROLE_ID}`,
        `delivery-promote:grant-${TEMP_ROLE_ID}`,
      ]);
      expect(harness.removalOwnedGrantIds.has(`grant-${TEMP_ROLE_ID}`)).toBe(true);
      expect(harness.supabase.rpc).toHaveBeenCalledWith(
        'commerce_attach_temp_role_delivery',
        expect.objectContaining({
          p_grant_id: `grant-${TEMP_ROLE_ID}`,
          p_role_id: TEMP_ROLE_ID,
          p_duration_seconds: 3_600,
          p_role_was_present: false,
        }),
      );
      expect(harness.supabase.rpc).toHaveBeenCalledWith(
        'commerce_confirm_temp_role_delivery',
        {
          p_intent_id: '11111111-1111-4111-8111-111111111111',
          p_mutation_token: '22222222-2222-4222-8222-222222222222',
          p_grant_id: `grant-${TEMP_ROLE_ID}`,
          p_role_id: TEMP_ROLE_ID,
        },
      );
    });

    it('does not mark or later remove a temporary role the member already held', async () => {
      const harness = makeTemporaryRoleHarness({ initialRoleIds: [TEMP_ROLE_ID] });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.removalOwnedGrantIds.has(`grant-${TEMP_ROLE_ID}`)).toBe(false);
      expect(harness.supabase.rpc).toHaveBeenCalledWith(
        'commerce_acknowledge_temp_role_grant',
        { p_grant_id: `grant-${TEMP_ROLE_ID}` },
      );
    });

    it('persists removal ownership for a sequential overlapping temporary purchase', async () => {
      const harness = makeTemporaryRoleHarness({
        initialRoleIds: [TEMP_ROLE_ID],
        liveTemporaryOwners: [{
          id: 'grant-earlier-order',
          guild_id: 'guild-1',
          user_id: 'user-1',
          role_id: TEMP_ROLE_ID,
          expires_at: '2999-01-01T00:00:00.000Z',
          grant_status: 'applied',
          remove_on_expiry: true,
        }],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.removalOwnedGrantIds.has(`grant-${TEMP_ROLE_ID}`)).toBe(true);
      expect(harness.supabase.rpc).toHaveBeenCalledWith(
        'commerce_confirm_temp_role_delivery',
        expect.objectContaining({
          p_grant_id: `grant-${TEMP_ROLE_ID}`,
          p_role_id: TEMP_ROLE_ID,
        }),
      );
    });

    it('persists removal ownership when the permanent and temporary snapshots overlap', async () => {
      const harness = makeTemporaryRoleHarness({
        initialRoleIds: [TEMP_ROLE_ID],
        orderGrantedRoleIds: [TEMP_ROLE_ID],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        granted_role_ids: [TEMP_ROLE_ID],
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.removalOwnedGrantIds.has(`grant-${TEMP_ROLE_ID}`)).toBe(true);
    });

    it('does not add the Discord role when durable removal intent cannot be acknowledged', async () => {
      const harness = makeTemporaryRoleHarness({
        attachResults: [
          { data: null, error: { message: 'intent write failed' } },
        ],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(false);
      expect(harness.supabase.rpc).toHaveBeenCalledWith(
        'commerce_attach_temp_role_delivery',
        expect.objectContaining({ p_grant_id: `grant-${TEMP_ROLE_ID}` }),
      );
      expect(harness.member.roles.add).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: 'prepare RPC error',
        options: { prepareError: { message: 'database unavailable' } },
      },
      {
        label: 'malformed prepare result',
        options: { prepareData: () => ({ id: 'missing-fields' }) },
      },
    ])('fails without Discord mutation on $label', async ({ options }) => {
      const harness = makeTemporaryRoleHarness(options);
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(false);
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.tempUpdates).toEqual([]);
      expect(eventBus.emit).not.toHaveBeenCalledWith('purchase.completed', expect.anything(), expect.anything());
    });

    it('starts the full duration at atomic promotion after a delayed pending retry', async () => {
      const harness = makeTemporaryRoleHarness({
        prepareData: (roleId) => ({
          id: `grant-${roleId}`,
          grant_status: 'pending',
          expires_at: '2000-01-01T00:00:00.000Z',
        }),
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.member.roles.add).toHaveBeenCalledTimes(1);
      expect(harness.supabase.rpc).toHaveBeenCalledWith(
        'commerce_confirm_temp_role_delivery',
        expect.objectContaining({
          p_grant_id: `grant-${TEMP_ROLE_ID}`,
          p_role_id: TEMP_ROLE_ID,
        }),
      );
    });

    it('treats an expired applied replay with no removal ownership as stale completion', async () => {
      const harness = makeTemporaryRoleHarness({
        prepareData: (roleId) => ({
          id: `grant-${roleId}`,
          grant_status: 'applied',
          expires_at: '2000-01-01T00:00:00.000Z',
        }),
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.guild.members.fetch).not.toHaveBeenCalled();
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.tempUpdates).toEqual([]);
    });

    it('leaves an expired applied replay to the durable expiry carrier even when it owns removal', async () => {
      const harness = makeTemporaryRoleHarness({
        initialRoleIds: [TEMP_ROLE_ID],
        prepareData: (roleId) => ({
          id: `grant-${roleId}`,
          grant_status: 'applied',
          remove_on_expiry: true,
          expires_at: '2000-01-01T00:00:00.000Z',
        }),
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.guild.members.fetch).not.toHaveBeenCalled();
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.member.roles.remove).not.toHaveBeenCalled();
      expect(harness.heldRoleIds.has(TEMP_ROLE_ID)).toBe(true);
      expect(harness.supabase.rpc).not.toHaveBeenCalledWith(
        'commerce_acknowledge_temp_role_grant',
        expect.anything(),
      );
      expect(harness.tempUpdates).toEqual([]);
    });

    it('repairs and confirms an unexpired applied role on queue replay', async () => {
      const harness = makeTemporaryRoleHarness({
        prepareData: (roleId) => ({
          id: `grant-${roleId}`,
          grant_status: 'applied',
          remove_on_expiry: true,
          expires_at: '2999-01-01T00:00:00.000Z',
        }),
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.member.roles.add).toHaveBeenCalledWith(
        TEMP_ROLE_ID,
        expect.stringContaining('temporary commerce role'),
      );
      expect(harness.removalOwnedGrantIds.has(`grant-${TEMP_ROLE_ID}`)).toBe(true);
      expect(harness.tempUpdates).not.toContainEqual(expect.objectContaining({
        grant_status: 'applied',
      }));
    });

    it('records Discord failure on the pending provenance row and leaves it retryable', async () => {
      const harness = makeTemporaryRoleHarness({ addError: new Error('Missing permissions') });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(false);
      expect(harness.member.roles.add).toHaveBeenCalledTimes(1);
      expect(harness.tempUpdates).toContainEqual(expect.objectContaining({
        last_error: 'Missing permissions',
        updated_at: expect.any(String),
      }));
      expect(harness.removalOwnedGrantIds.has(`grant-${TEMP_ROLE_ID}`)).toBe(false);
      expect(harness.tempUpdates).not.toContainEqual(expect.objectContaining({
        grant_status: 'applied',
      }));
    });

    it('retries a failed manual-baseline acknowledgement without taking role ownership', async () => {
      const harness = makeTemporaryRoleHarness({
        initialRoleIds: [TEMP_ROLE_ID],
        reuseEntitlementOnRetry: true,
        acknowledgementResults: [
          { data: null, error: { message: 'ack write failed' } },
          {
            data: {
              id: `grant-${TEMP_ROLE_ID}`,
              grant_status: 'applied',
              applied_at: '2030-01-01T00:00:00.000Z',
              expires_at: '2030-01-01T00:01:00.000Z',
            },
            error: null,
          },
        ],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);
      const payload: FulfillmentPayload = {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      };

      const first = await fulfillClaimed(service, payload);
      const retry = await fulfillClaimed(service, payload);

      expect(first.success).toBe(false);
      expect(retry.success).toBe(true);
      expect(harness.supabase.rpc.mock.calls.filter(
        ([name]: [string]) => name === 'commerce_prepare_temp_role_grant',
      )).toHaveLength(2);
      expect(mockGrant).toHaveBeenCalledTimes(1);
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.heldRoleIds.has(TEMP_ROLE_ID)).toBe(true);
      expect(harness.supabase.rpc.mock.calls.filter(
        ([name]: [string]) => name === 'commerce_acknowledge_temp_role_grant',
      )).toHaveLength(2);
    });

    it('treats a lost manual-baseline acknowledgement as success after exact inspection', async () => {
      const grantId = `grant-${TEMP_ROLE_ID}`;
      const harness = makeTemporaryRoleHarness({
        initialRoleIds: [TEMP_ROLE_ID],
        acknowledgementResults: [{ data: null, error: { message: 'response lost' } }],
        inspectionResults: [{
          data: {
            id: grantId,
            guild_id: 'guild-1',
            user_id: 'user-1',
            role_id: TEMP_ROLE_ID,
            expires_at: '2999-01-01T00:01:00.000Z',
            duration_seconds: 60,
            grant_status: 'applied',
            remove_on_expiry: false,
            applied_at: '2999-01-01T00:00:00.000Z',
            order_id: 'order-1',
            parent_order_status: 'completed',
            entitlement_is_live: true,
          },
          error: null,
        }],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.member.roles.remove).not.toHaveBeenCalled();
      expect(harness.heldRoleIds.has(TEMP_ROLE_ID)).toBe(true);
    });

    it.each([
      ['an applied row without applied_at', {
        data: {
          id: `grant-${TEMP_ROLE_ID}`,
          guild_id: 'guild-1',
          user_id: 'user-1',
          role_id: TEMP_ROLE_ID,
          expires_at: '2999-01-01T00:01:00.000Z',
          duration_seconds: 60,
          grant_status: 'applied',
          remove_on_expiry: false,
          applied_at: null,
          order_id: 'order-1',
          parent_order_status: 'completed',
          entitlement_is_live: true,
        },
        error: null,
      }],
      ['an applied row with an incoherent expiry interval', {
        data: {
          id: `grant-${TEMP_ROLE_ID}`,
          guild_id: 'guild-1',
          user_id: 'user-1',
          role_id: TEMP_ROLE_ID,
          expires_at: '2999-01-01T00:02:00.000Z',
          duration_seconds: 60,
          grant_status: 'applied',
          remove_on_expiry: false,
          applied_at: '2999-01-01T00:00:00.000Z',
          order_id: 'order-1',
          parent_order_status: 'completed',
          entitlement_is_live: true,
        },
        error: null,
      }],
      ['a pending row with applied_at set', {
        data: {
          id: `grant-${TEMP_ROLE_ID}`,
          guild_id: 'guild-1',
          user_id: 'user-1',
          role_id: TEMP_ROLE_ID,
          expires_at: '2999-01-01T00:01:00.000Z',
          duration_seconds: 60,
          grant_status: 'pending',
          remove_on_expiry: false,
          applied_at: '2999-01-01T00:00:00.000Z',
          order_id: 'order-1',
          parent_order_status: 'completed',
          entitlement_is_live: true,
        },
        error: null,
      }],
      ['a missing or removed inspection row', { data: null, error: null }],
      ['an inspection RPC error', { data: null, error: { message: 'inspection unavailable' } }],
    ])('preserves a manual baseline when ACK ambiguity returns %s', async (_label, inspectionResult) => {
      const harness = makeTemporaryRoleHarness({
        initialRoleIds: [TEMP_ROLE_ID],
        acknowledgementResults: [{ data: null, error: { message: 'response ambiguous' } }],
        inspectionResults: [inspectionResult],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(false);
      expect(harness.member.roles.remove).not.toHaveBeenCalled();
      expect(harness.heldRoleIds.has(TEMP_ROLE_ID)).toBe(true);
    });

    const terminalAttachmentResult = () => ({
      data: {
        intent_state: 'cleanup_required',
        may_mutate: false,
        owns_removal: false,
        claim_newly_acquired: false,
        disposition: 'terminal',
      },
      error: null,
    });

    it('delegates a terminal attachment to the exact durable cleanup controller', async () => {
      const harness = makeTemporaryRoleHarness({
        attachResults: [terminalAttachmentResult()],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(mockExecuteRoleCleanup).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        {
          ...TEST_ACTION_CLAIM,
          intentId: '11111111-1111-4111-8111-111111111111',
          mutationToken: '22222222-2222-4222-8222-222222222222',
        },
      );
      expect(harness.member.roles.remove).not.toHaveBeenCalled();
    });

    it.each([
      ['pending', false],
      ['pending', true],
      ['applied', false],
      ['applied', true],
    ] as const)(
      'delegates a terminal %s grant without mutating a role whose presence is %s',
      async (grantStatus, roleWasPresent) => {
        const harness = makeTemporaryRoleHarness({
          initialRoleIds: roleWasPresent ? [TEMP_ROLE_ID] : [],
          attachResults: [terminalAttachmentResult()],
          prepareData: (roleId) => ({
            id: `grant-${roleId}`,
            grant_status: grantStatus,
            remove_on_expiry: grantStatus === 'applied',
            expires_at: '2999-01-01T00:01:00.000Z',
          }),
        });
        service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

        const result = await fulfillClaimed(service, {
          ...basePayload,
          temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
        });

        expect(result.success).toBe(true);
        expect(mockExecuteRoleCleanup).toHaveBeenCalledWith(
          '11111111-1111-4111-8111-111111111111',
          expect.objectContaining(TEST_ACTION_CLAIM),
        );
        expect(harness.member.roles.add).not.toHaveBeenCalled();
        expect(harness.member.roles.remove).not.toHaveBeenCalled();
        expect(harness.heldRoleIds.has(TEMP_ROLE_ID)).toBe(roleWasPresent);
      },
    );

    it('threads the exact queue claim into terminal temporary-role cleanup', async () => {
      const harness = makeTemporaryRoleHarness({
        attachResults: [terminalAttachmentResult()],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(mockExecuteRoleCleanup).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        {
          ...TEST_ACTION_CLAIM,
          intentId: '11111111-1111-4111-8111-111111111111',
          mutationToken: '22222222-2222-4222-8222-222222222222',
        },
      );
      expect(harness.member.roles.remove).not.toHaveBeenCalled();
    });

    it('does not duplicate owner classification before delegating terminal cleanup', async () => {
      const harness = makeTemporaryRoleHarness({
        initialRoleIds: [TEMP_ROLE_ID],
        attachResults: [terminalAttachmentResult()],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.getEntitlementOwnerPageCalls()).toBe(0);
      expect(harness.entitlementOwnerGtValues).toEqual([]);
      expect(mockExecuteRoleCleanup).toHaveBeenCalledTimes(1);
      expect(harness.member.roles.remove).not.toHaveBeenCalled();
      expect(harness.heldRoleIds.has(TEMP_ROLE_ID)).toBe(true);
    });

    it.each([
      { label: 'settled cleanup', cleanupError: null, succeeds: true },
      {
        label: 'retryable controller failure',
        cleanupError: new Error('cleanup controller unavailable'),
        succeeds: false,
      },
    ])(
      'delegates terminal cleanup to the canonical controller: $label',
      async ({ cleanupError, succeeds }) => {
        if (cleanupError) mockExecuteRoleCleanup.mockRejectedValueOnce(cleanupError);
        const harness = makeTemporaryRoleHarness({
          initialRoleIds: [TEMP_ROLE_ID],
          attachResults: [terminalAttachmentResult()],
        });
        service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

        const result = await fulfillClaimed(service, {
          ...basePayload,
          temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
        });

        expect(result.success).toBe(succeeds);
        expect(mockExecuteRoleCleanup).toHaveBeenCalledTimes(1);
        if (!succeeds) {
          expect(result.errors.join(' ')).toContain('cleanup controller unavailable');
        }
        expect(harness.heldRoleIds.has(TEMP_ROLE_ID)).toBe(true);
        expect(harness.member.roles.remove).not.toHaveBeenCalled();
      },
    );

    it('does not perform a second local mutation around durable terminal cleanup', async () => {
      const harness = makeTemporaryRoleHarness({
        initialRoleIds: [TEMP_ROLE_ID],
        attachResults: [terminalAttachmentResult()],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(mockExecuteRoleCleanup).toHaveBeenCalledTimes(1);
      expect(harness.member.roles.remove).not.toHaveBeenCalled();
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.heldRoleIds.has(TEMP_ROLE_ID)).toBe(true);
    });

    it('does not extend or re-promote an applied grant on duplicate fulfillment replay', async () => {
      const harness = makeTemporaryRoleHarness({
        reuseEntitlementOnRetry: true,
        prepareData: (roleId, call) => ({
          id: `grant-${roleId}`,
          grant_status: call === 0 ? 'pending' : 'applied',
          expires_at: call === 0
            ? '2000-01-01T00:00:00.000Z'
            : '2999-01-01T00:00:00.000Z',
        }),
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);
      const payload: FulfillmentPayload = {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      };

      const first = await fulfillClaimed(service, payload);
      const replay = await fulfillClaimed(service, payload);

      expect(first.success).toBe(true);
      expect(replay.success).toBe(true);
      expect(harness.member.roles.add).toHaveBeenCalledTimes(1);
      expect(harness.supabase.rpc.mock.calls.filter(
        ([name]: [string]) => name === 'commerce_confirm_temp_role_delivery',
      )).toHaveLength(1);
    });

    it('deduplicates and deterministically orders duplicate temporary-role payload rows', async () => {
      const harness = makeTemporaryRoleHarness({
        orderTemporaryRoleGrants: [
          { role_id: TEMP_ROLE_A, duration_seconds: 120 },
          { role_id: TEMP_ROLE_Z, duration_seconds: 60 },
        ],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        temporary_role_grants: [
          { role_id: TEMP_ROLE_Z, duration_seconds: 60 },
          { role_id: TEMP_ROLE_A, duration_seconds: 60 },
          { role_id: TEMP_ROLE_A, duration_seconds: 120 },
        ],
      });

      expect(result.success).toBe(true);
      expect(harness.supabase.rpc.mock.calls
        .filter((call: any[]) => call[0] === 'commerce_prepare_temp_role_grant')
        .map((call: any[]) => [
        call[1].p_role_id,
        call[1].p_duration_seconds,
      ])).toEqual([
        [TEMP_ROLE_A, 120],
        [TEMP_ROLE_Z, 60],
      ]);
      expect(harness.member.roles.add).toHaveBeenCalledTimes(2);
    });
  });

  describe('subscription_activated', () => {
    it('grants subscription entitlement', async () => {
      const payload = subscriptionActivationPayload;
      service = new CommerceFulfillmentService(
        makeGuild(),
        makeSupa({ orders: subscriptionOrderSnapshot }) as any,
        eventBus,
      );
      const result = await fulfillClaimed(service, payload);
      expect(result.success).toBe(true);
      expect(result.entitlementId).toBe('ent-123');
      expect(mockGrant).toHaveBeenCalledWith({
        customerId: 'cust-1',
        productId: 'prod-1',
        productName: 'VIP Pass',
        orderId: 'order-1',
        planId: 'plan-monthly',
        discordId: 'user-1',
        type: 'subscription',
        source: 'purchase',
        grantedRoleIds: ['role-1'],
        grantedChannelIds: [],
        roleDeliveryClaim: TEST_ACTION_CLAIM,
      });
      expect(mockEnsurePurchaseGrantedRoles).not.toHaveBeenCalled();
      expect(eventBus.emit).toHaveBeenCalledWith('subscription.activated', 'guild-1', expect.objectContaining({ status: 'activated' }));
    });

    it('reports error when subscription grant fails', async () => {
      mockGrant.mockResolvedValueOnce(null as any);
      const payload = {
        ...subscriptionActivationPayload,
        fulfillment_type: 'subscription_activated',
        plan_id: 'plan-monthly',
        entitlement_type: 'subscription' as const,
      };
      service = new CommerceFulfillmentService(
        makeGuild(),
        makeSupa({ orders: subscriptionOrderSnapshot }) as any,
        eventBus,
      );
      const result = await fulfillClaimed(service, payload);
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('subscription entitlement');
    });

    it.each(['pending', 'pending_review'])(
      'keeps an uncommitted %s subscription activation retryable',
      async (status) => {
        const payload: FulfillmentPayload = {
          ...subscriptionActivationPayload,
          fulfillment_type: 'subscription_activated',
          plan_id: 'plan-monthly',
          entitlement_type: 'subscription',
        };
        service = new CommerceFulfillmentService(
          makeGuild(),
          makeSupa({ orders: { ...subscriptionOrderSnapshot, status } }) as any,
          eventBus,
        );

        const result = await fulfillClaimed(service, payload);

        expect(result.success).toBe(false);
        expect(result.errors.join(' ')).toContain('not committed');
        expect(mockGrant).not.toHaveBeenCalled();
        expect(mockBeginRoleDelivery).not.toHaveBeenCalled();
      },
    );

    it.each(subscriptionOrderIdentityRejectionCases)(
      'rejects activation with invalid $label before grant or event emission',
      async ({ orderPatch, payloadPatch }) => {
        const payload: FulfillmentPayload = {
          ...subscriptionActivationPayload,
          fulfillment_type: 'subscription_activated',
          plan_id: 'plan-monthly',
          entitlement_type: 'subscription',
          ...payloadPatch,
        };
        service = new CommerceFulfillmentService(
          makeGuild(),
          makeSupa({
            orders: { ...subscriptionOrderSnapshot, ...orderPatch },
          }) as any,
          eventBus,
        );

        const result = await fulfillClaimed(service, payload);

        expect(result.success).toBe(false);
        expect(result.errors.join(' ')).toContain('frozen snapshot');
        expect(mockGrant).not.toHaveBeenCalled();
        expect(mockBeginRoleDelivery).not.toHaveBeenCalled();
        expect(eventBus.emit).not.toHaveBeenCalled();
      },
    );

    it('accepts an exact non-null PayPal subscription identity for activation', async () => {
      const payload: FulfillmentPayload = {
        ...subscriptionActivationPayload,
        fulfillment_type: 'subscription_activated',
        plan_id: 'plan-monthly',
        paypal_subscription_id: 'SUB-EXACT',
        entitlement_type: 'subscription',
      };
      service = new CommerceFulfillmentService(
        makeGuild(),
        makeSupa({
          orders: { ...subscriptionOrderSnapshot, paypal_subscription_id: 'SUB-EXACT' },
        }) as any,
        eventBus,
      );

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(true);
      expect(mockGrant).toHaveBeenCalledOnce();
      expect(eventBus.emit).toHaveBeenCalled();
    });

    it('reuses and re-confirms the exact subscription entitlement after a worker replay', async () => {
      const payload: FulfillmentPayload = {
        ...subscriptionActivationPayload,
        fulfillment_type: 'subscription_activated',
        plan_id: 'plan-monthly',
        entitlement_type: 'subscription',
      };
      const supabase = makeSupa({
        orders: subscriptionOrderSnapshot,
        entitlements: {
          id: 'ent-sub',
          customer_id: 'cust-1',
          product_id: 'prod-1',
          plan_id: 'plan-monthly',
          license_key_id: null,
          type: 'subscription',
          status: 'active',
          source: 'purchase',
          granted_role_ids: ['role-1'],
          granted_channel_ids: [],
        },
      });
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(true);
      expect(result.entitlementId).toBe('ent-sub');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockEnsurePurchaseGrantedRoles).toHaveBeenCalledWith('ent-sub', {
        customerId: 'cust-1',
        productId: 'prod-1',
        orderId: 'order-1',
        planId: 'plan-monthly',
        discordId: 'user-1',
        grantedRoleIds: ['role-1'],
        entitlementType: 'subscription',
      }, {
        ...TEST_ACTION_CLAIM,
        intentId: '11111111-1111-4111-8111-111111111111',
        mutationToken: '22222222-2222-4222-8222-222222222222',
      });
    });

    it('does not emit or send a receipt when reused subscription purchase proof becomes terminal', async () => {
      const payload: FulfillmentPayload = {
        ...subscriptionActivationPayload,
        fulfillment_type: 'subscription_activated',
        plan_id: 'plan-monthly',
        entitlement_type: 'subscription',
      };
      const supabase = makeSupa({
        orders: subscriptionOrderSnapshot,
        entitlements: {
          id: 'ent-sub',
          customer_id: 'cust-1',
          product_id: 'prod-1',
          plan_id: 'plan-monthly',
          license_key_id: null,
          type: 'subscription',
          status: 'active',
          source: 'purchase',
          granted_role_ids: ['role-1'],
          granted_channel_ids: [],
        },
      });
      mockEnsurePurchaseGrantedRoles.mockRejectedValueOnce(
        new Error('Purchase entitlement ent-sub became terminal during Discord delivery'),
      );
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('became terminal during Discord delivery');
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(mockDeliverReceiptDM).not.toHaveBeenCalled();
    });

    it('accepts the exact immutable contract persisted before a dashboard legacy release', async () => {
      const payload: FulfillmentPayload = {
        ...subscriptionActivationPayload,
        fulfillment_type: 'subscription_activated',
        plan_id: 'plan-monthly',
        paypal_subscription_id: 'SUB-RECOVERY-1',
        paypal_plan_id: 'P-MONTHLY-1',
        granted_role_ids: [LEGACY_SUBSCRIPTION_ROLE_ID],
        entitlement_type: 'subscription',
      };
      const supabase = makeSupa({
        orders: legacySubscriptionOrder,
        commerce_legacy_subscription_grant_contracts: legacySubscriptionContract,
      });
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(true);
      expect(result.entitlementId).toBe('ent-123');
      expect(mockGrant).toHaveBeenCalledWith(expect.objectContaining({
        orderId: 'order-1',
        planId: 'plan-monthly',
        grantedRoleIds: [LEGACY_SUBSCRIPTION_ROLE_ID],
      }));
    });

    it('rejects a null-snapshot subscription with no immutable legacy marker', async () => {
      const payload: FulfillmentPayload = {
        ...subscriptionActivationPayload,
        fulfillment_type: 'subscription_activated',
        plan_id: 'plan-monthly',
        paypal_subscription_id: 'SUB-RECOVERY-1',
        paypal_plan_id: 'P-MONTHLY-1',
        granted_role_ids: [LEGACY_SUBSCRIPTION_ROLE_ID],
        entitlement_type: 'subscription',
      };
      service = new CommerceFulfillmentService(
        makeGuild(),
        makeSupa({ orders: legacySubscriptionOrder }) as any,
        eventBus,
      );

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('exact legacy contract validation');
      expect(mockGrant).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: 'grant snapshot',
        payload: { granted_role_ids: ['222222222222222222'] },
      },
      {
        label: 'financial identity',
        payload: { amount_cents: 1_000 },
      },
      {
        label: 'provider plan identity',
        payload: { paypal_plan_id: 'P-TAMPERED' },
      },
    ])('rejects a dashboard legacy payload with tampered $label', async ({ payload: changed }) => {
      const payload: FulfillmentPayload = {
        ...subscriptionActivationPayload,
        fulfillment_type: 'subscription_activated',
        plan_id: 'plan-monthly',
        paypal_subscription_id: 'SUB-RECOVERY-1',
        paypal_plan_id: 'P-MONTHLY-1',
        granted_role_ids: [LEGACY_SUBSCRIPTION_ROLE_ID],
        entitlement_type: 'subscription',
        ...changed,
      };
      service = new CommerceFulfillmentService(
        makeGuild(),
        makeSupa({
          orders: changed.amount_cents === undefined
            ? legacySubscriptionOrder
            : { ...legacySubscriptionOrder, amount_cents: changed.amount_cents },
          commerce_legacy_subscription_grant_contracts: legacySubscriptionContract,
        }) as any,
        eventBus,
      );

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('exact legacy contract validation');
      expect(mockGrant).not.toHaveBeenCalled();
    });

    it('rejects a legacy contract row without its protected queue marker', async () => {
      const payload: FulfillmentPayload = {
        ...subscriptionActivationPayload,
        fulfillment_type: 'subscription_activated',
        plan_id: 'plan-monthly',
        paypal_subscription_id: 'SUB-RECOVERY-1',
        paypal_plan_id: 'P-MONTHLY-1',
        granted_role_ids: [LEGACY_SUBSCRIPTION_ROLE_ID],
        entitlement_type: 'subscription',
      };
      service = new CommerceFulfillmentService(
        makeGuild(),
        makeSupa({
          orders: legacySubscriptionOrder,
          commerce_legacy_subscription_grant_contracts: {
            ...legacySubscriptionContract,
            source_queue_id: '',
          },
        }) as any,
        eventBus,
      );

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('exact legacy contract validation');
      expect(mockGrant).not.toHaveBeenCalled();
    });

    it('rejects a subscription customer/Discord mismatch before grant or repair', async () => {
      const payload: FulfillmentPayload = {
        ...subscriptionActivationPayload,
        fulfillment_type: 'subscription_activated',
        plan_id: 'plan-monthly',
        entitlement_type: 'subscription',
      };
      const supabase = makeSupa({
        customers: { id: 'cust-1', guild_id: 'guild-1', discord_id: 'different-user' },
        orders: subscriptionOrderSnapshot,
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supabase as any, eventBus);

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('customer identity');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockEnsurePurchaseGrantedRoles).not.toHaveBeenCalled();
      expect(guild.members.fetch).not.toHaveBeenCalled();
    });

    it('rejects a temporary-role payload absent from the frozen subscription order', async () => {
      const harness = makeTemporaryRoleHarness({
        orderPlanId: 'plan-monthly',
        orderPaypalSubscriptionId: 'SUB-001',
        orderTemporaryRoleGrants: [],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);
      const payload: FulfillmentPayload = {
        ...subscriptionActivationPayload,
        fulfillment_type: 'subscription_activated',
        plan_id: 'plan-monthly',
        entitlement_type: 'subscription',
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      };

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('frozen snapshot');
      expect(harness.supabase.rpc).not.toHaveBeenCalled();
      expect(harness.member.roles.add).not.toHaveBeenCalled();
    });
  });

  describe('subscription_renewed', () => {
    const renewalPayload: FulfillmentPayload = {
      ...subscriptionActivationPayload,
      fulfillment_type: 'subscription_renewed',
      plan_id: 'plan-monthly',
      entitlement_type: 'subscription',
      existing_entitlement_id: 'ent-old',
    };
    const renewalEntitlement = (
      status: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      ...subscriptionLifecycleEntitlement(status, {
        id: 'ent-old',
        granted_role_ids: ['role-1'],
        granted_channel_ids: [],
      }),
      ...overrides,
    });

    it.each(['active', 'grace_period', 'suspended'])(
      'reactivates or repairs the exact %s entitlement before emitting renewal',
      async (status) => {
        const supabase = makeSupa({
          orders: subscriptionOrderSnapshot,
          entitlements: renewalEntitlement(status),
        });
        service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

        const result = await fulfillClaimed(service, renewalPayload);

        expect(result.success).toBe(true);
        expect(mockReactivate).toHaveBeenCalledWith('ent-old', {
          customerId: 'cust-1',
          productId: 'prod-1',
          orderId: 'order-1',
          planId: 'plan-monthly',
          discordId: 'user-1',
          grantedRoleIds: ['role-1'],
          entitlementType: 'subscription',
        }, TEST_ACTION_CLAIM);
        expect(result.entitlementId).toBe('ent-old');
        expect(eventBus.emit).toHaveBeenCalledWith(
          'subscription.activated',
          'guild-1',
          expect.objectContaining({ status: 'renewed', planId: 'plan-monthly' }),
        );
      },
    );

    it.each(['pending', 'pending_review'])(
      'keeps an uncommitted %s subscription renewal retryable',
      async (status) => {
        const supabase = makeSupa({
          orders: { ...subscriptionOrderSnapshot, status },
          entitlements: renewalEntitlement('active'),
        });
        service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

        const result = await fulfillClaimed(service, renewalPayload);

        expect(result.success).toBe(false);
        expect(result.errors.join(' ')).toContain('not committed');
        expect(mockReactivate).not.toHaveBeenCalled();
        expect(eventBus.emit).not.toHaveBeenCalled();
      },
    );

    it.each(subscriptionOrderIdentityRejectionCases)(
      'rejects renewal with invalid $label before reactivation or event emission',
      async ({ orderPatch, payloadPatch }) => {
        const supabase = makeSupa({
          orders: { ...subscriptionOrderSnapshot, ...orderPatch },
          entitlements: renewalEntitlement('active'),
        });
        service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

        const result = await fulfillClaimed(service, {
          ...renewalPayload,
          ...payloadPatch,
        });

        expect(result.success).toBe(false);
        expect(result.errors.join(' ')).toContain('frozen snapshot');
        expect(mockReactivate).not.toHaveBeenCalled();
        expect(eventBus.emit).not.toHaveBeenCalled();
      },
    );

    it('accepts an exact non-null PayPal subscription identity for renewal', async () => {
      const supabase = makeSupa({
        orders: { ...subscriptionOrderSnapshot, paypal_subscription_id: 'SUB-EXACT' },
        entitlements: renewalEntitlement('active'),
      });
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, {
        ...renewalPayload,
        paypal_subscription_id: 'SUB-EXACT',
      });

      expect(result.success).toBe(true);
      expect(mockReactivate).toHaveBeenCalledOnce();
      expect(eventBus.emit).toHaveBeenCalled();
    });

    it('fails without an event when existing_entitlement_id is missing', async () => {
      const payload = { ...renewalPayload };
      delete payload.existing_entitlement_id;
      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('exact existing entitlement');
      expect(mockReactivate).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('fails without an event when exact reactivation returns false', async () => {
      mockReactivate.mockResolvedValueOnce(false);
      const supabase = makeSupa({
        orders: subscriptionOrderSnapshot,
        entitlements: renewalEntitlement('grace_period'),
      });
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, renewalPayload);

      expect(result.errors).toContain('Failed to reactivate entitlement');
      expect(result.success).toBe(false);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it.each(['pending', 'cancelled', 'expired', 'revoked'])(
      'rejects %s without reactivation or an event',
      async (status) => {
        const supabase = makeSupa({
          orders: subscriptionOrderSnapshot,
          entitlements: renewalEntitlement(status),
        });
        service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

        const result = await fulfillClaimed(service, renewalPayload);

        expect(result.success).toBe(false);
        expect(result.errors.join(' ')).toContain(`rejected entitlement status ${status}`);
        expect(mockReactivate).not.toHaveBeenCalled();
        expect(eventBus.emit).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['entitlement id', { id: 'different-entitlement' }],
      ['guild', { guild_id: 'different-guild' }],
      ['customer', { customer_id: 'different-customer' }],
      ['order', { order_id: 'different-order' }],
      ['product', { product_id: 'different-product' }],
      ['plan', { plan_id: 'different-plan' }],
      ['type', { type: 'one_time' }],
      ['roles', { granted_role_ids: ['different-role'] }],
    ])('rejects a mismatched %s before reactivation', async (_label, override) => {
      const supabase = makeSupa({
        orders: subscriptionOrderSnapshot,
        entitlements: renewalEntitlement('grace_period', override),
      });
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, renewalPayload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('exact lifecycle identity');
      expect(mockReactivate).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  describe('subscription_cancelled', () => {
    it('revokes the exact live subscription entitlement and sends DM', async () => {
      const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement('active') });
      eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

      const result = await fulfillClaimed(service, subscriptionLifecyclePayload);

      expect(result.success).toBe(true);
      expect(result.entitlementId).toBe('ent-subscription');
      expect(mockRevoke).toHaveBeenCalledWith('ent-subscription', 'cancelled');
      expect(result.eventEmitted).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledWith('subscription.lapsed', 'guild-1', expect.any(Object));
    });

    it('treats a CAS no-op race as success without repeating event or DM', async () => {
      (mockRevoke as any).mockResolvedValueOnce({
        disposition: 'noop', transitionId: null, status: 'cancelled',
      });
      const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement('active') });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supa as any, eventBus);

      const result = await fulfillClaimed(service, subscriptionLifecyclePayload);

      expect(result.success).toBe(true);
      expect(result.eventEmitted).toBe(false);
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(guild.client.users.fetch).not.toHaveBeenCalled();
    });

    it('fails a stale live-state CAS without notifications so the claim can retry', async () => {
      (mockRevoke as any).mockResolvedValueOnce({
        disposition: 'stale', transitionId: null, status: 'suspended',
      });
      const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement('active') });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supa as any, eventBus);

      const result = await fulfillClaimed(service, subscriptionLifecyclePayload);

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Failed to revoke entitlement ent-subscription (stale)');
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(guild.client.users.fetch).not.toHaveBeenCalled();
    });

    it('fails without notifications when the exact entitlement lookup errors', async () => {
      const supa = makeEntitlementLookupResult({
        data: null,
        error: { message: 'database unavailable' },
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supa as any, eventBus);

      const result = await fulfillClaimed(service, subscriptionLifecyclePayload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('database unavailable');
      expect(mockRevoke).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(guild.client.users.fetch).not.toHaveBeenCalled();
    });

    it('rejects a mismatched lifecycle identity before revocation or notifications', async () => {
      const supa = makeSupa({
        entitlements: subscriptionLifecycleEntitlement('active', {
          product_id: 'different-product',
        }),
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supa as any, eventBus);

      const result = await fulfillClaimed(service, subscriptionLifecyclePayload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('exact lifecycle identity');
      expect(mockRevoke).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(guild.client.users.fetch).not.toHaveBeenCalled();
    });

    it.each(['cancelled', 'expired', 'revoked'])(
      'treats exact terminal status %s as an idempotent replay',
      async (status) => {
        const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement(status) });
        const guild = makeGuild();
        service = new CommerceFulfillmentService(guild, supa as any, eventBus);

        const result = await fulfillClaimed(service, subscriptionLifecyclePayload);

        expect(result.success).toBe(true);
        expect(mockRevoke).not.toHaveBeenCalled();
        expect(eventBus.emit).not.toHaveBeenCalled();
        expect(guild.client.users.fetch).not.toHaveBeenCalled();
      },
    );
  });

  describe('subscription_suspended', () => {
    it('suspends the exact active subscription entitlement', async () => {
      const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement('active') });
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

      const payload = { ...subscriptionLifecyclePayload, fulfillment_type: 'subscription_suspended' };
      const result = await fulfillClaimed(service, payload);
      expect(result.success).toBe(true);
      expect(mockSuspend).toHaveBeenCalledWith('ent-subscription', 3);
      expect(result.eventEmitted).toBe(true);
    });

    it("suspends with the guild's configured grace window from getGracePeriodDays (single source of truth)", async () => {
      // Codex round-2 finding #1: the bot's suspend path must read the
      // configured window via the shared helper, not a hardcoded value —
      // the same source of truth the dashboard's manual PUT uses. Return a
      // distinctive 9 so a hardcoded default (3) would fail this assertion.
      (getGracePeriodDays as ReturnType<typeof vi.fn>).mockResolvedValueOnce(9);
      const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement('active') });
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

      const payload = { ...subscriptionLifecyclePayload, fulfillment_type: 'subscription_suspended' };
      await fulfillClaimed(service, payload);

      expect(getGracePeriodDays).toHaveBeenCalledWith(supa, payload.guild_id);
      expect(mockSuspend).toHaveBeenCalledWith('ent-subscription', 9);
    });

    it('fails without notifications when the exact entitlement lookup errors', async () => {
      const supa = makeEntitlementLookupResult({
        data: null,
        error: { message: 'database unavailable' },
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supa as any, eventBus);
      const payload = { ...subscriptionLifecyclePayload, fulfillment_type: 'subscription_suspended' };

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('database unavailable');
      expect(mockSuspend).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(guild.client.users.fetch).not.toHaveBeenCalled();
    });

    it('treats an exact grace-period row as a replay without extending or notifying again', async () => {
      const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement('grace_period') });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supa as any, eventBus);
      const payload = { ...subscriptionLifecyclePayload, fulfillment_type: 'subscription_suspended' };

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(true);
      expect(mockSuspend).not.toHaveBeenCalled();
      expect(getGracePeriodDays).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(guild.client.users.fetch).not.toHaveBeenCalled();
    });

    it.each(['cancelled', 'expired', 'revoked'])(
      'safely ignores a late suspension for terminal status %s',
      async (status) => {
        const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement(status) });
        const guild = makeGuild();
        service = new CommerceFulfillmentService(guild, supa as any, eventBus);
        const payload = { ...subscriptionLifecyclePayload, fulfillment_type: 'subscription_suspended' };

        const result = await fulfillClaimed(service, payload);

        expect(result.success).toBe(true);
        expect(mockSuspend).not.toHaveBeenCalled();
        expect(eventBus.emit).not.toHaveBeenCalled();
        expect(guild.client.users.fetch).not.toHaveBeenCalled();
      },
    );
  });

  describe('unknown type', () => {
    it('returns error for unknown fulfillment_type', async () => {
      const payload = { ...basePayload, fulfillment_type: 'bogus' };
      const result = await fulfillClaimed(service, payload);
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('Unknown fulfillment type');
    });
  });

  describe('fatal errors', () => {
    it('catches and reports exceptions', async () => {
      mockGrant.mockRejectedValueOnce(new Error('Boom'));
      const result = await fulfillClaimed(service, basePayload);
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('Boom');
    });
  });

  describe('receipt delivery failure handling', () => {
    // Defect fix: a failed receipt/license-key DM must never be dropped
    // silently — it is queued for persistent re-delivery via bot_action_queue.
    // The queue insert itself is retried with backoff (the queue row is the
    // only at-rest copy of the plaintext key); if it keeps failing, the
    // payload is preserved in the retryable DLQ and an operator alert
    // (never containing the key) is written.

    /**
     * `queueInsertError` makes bot_action_queue inserts fail; combine with
     * `queueInsertFailures: n` to fail only the first n attempts.
     * `dlqInsertError` makes action_queue_dlq inserts fail too (the
     * worst-case path where the key cannot be preserved anywhere).
     */
    function makeRecordingSupa(
      opts: {
        queueInsertError?: { message: string };
        queueInsertFailures?: number;
        dlqInsertError?: { message: string };
      } = {},
    ) {
      const inserts: Record<string, any[]> = {};
      let queueInsertAttempts = 0;
      const supa: any = {
        from: vi.fn((table: string) => {
          const chain: any = {};
          for (const m of ['select', 'update', 'delete', 'upsert', 'eq', 'in', 'order', 'limit']) {
            chain[m] = vi.fn(() => chain);
          }
          chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
          if (table === 'customers') {
            chain.maybeSingle = vi.fn().mockResolvedValue({
              data: { id: 'cust-1', guild_id: 'guild-1', discord_id: 'user-1' },
              error: null,
            });
          }
          if (table === 'orders') {
            chain.maybeSingle = vi.fn().mockResolvedValue({
              data: {
                id: 'order-1',
                order_number: 'ORD-001',
                guild_id: 'guild-1',
                customer_id: 'cust-1',
                product_id: 'prod-1',
                plan_id: null,
                paypal_subscription_id: null,
                amount_cents: 999,
                currency: 'USD',
                source: 'purchase',
                status: 'completed',
                granted_role_ids_snapshot: ['role-1'],
                granted_channel_ids_snapshot: [],
                temporary_role_grants_snapshot: [],
                grant_snapshot_frozen_at: '2026-07-11T00:00:00.000Z',
              },
              error: null,
            });
          }
          chain.insert = vi.fn((row: any) => {
            (inserts[table] ??= []).push(row);
            let result: any = { data: null, error: null };
            if (table === 'bot_action_queue' && opts.queueInsertError) {
              queueInsertAttempts++;
              const stillFailing =
                opts.queueInsertFailures === undefined ||
                queueInsertAttempts <= opts.queueInsertFailures;
              if (stillFailing) result = { data: null, error: opts.queueInsertError };
            }
            if (table === 'action_queue_dlq' && opts.dlqInsertError) {
              result = { data: null, error: opts.dlqInsertError };
            }
            const insertChain: any = { ...chain };
            insertChain.then = (resolve: Function) => resolve(result);
            return insertChain;
          });
          chain.then = (resolve: Function) => resolve({ data: null, error: null });
          return chain;
        }),
        rpc: vi.fn(async () => ({ data: null, error: null })),
      };
      supa.__inserts = inserts;
      return supa;
    }

    const keyedPayload: FulfillmentPayload = {
      ...basePayload,
      license_key_plaintext: 'SMNI-AAAA-BBBB-CCCC-DDDD',
    };

    it('does not queue re-delivery when the receipt sends successfully', async () => {
      const supa = makeRecordingSupa();
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

      const result = await fulfillClaimed(service, keyedPayload);

      expect(result.success).toBe(true);
      expect(result.receiptSent).toBe(true);
      expect(result.receiptRetryQueued).toBeUndefined();
      expect(supa.__inserts['bot_action_queue']).toBeUndefined();
      expect(supa.__inserts['alerts']).toBeUndefined();
    });

    it('queues persistent re-delivery when the receipt DM fails, without failing fulfillment', async () => {
      mockDeliverReceiptDM.mockRejectedValueOnce(new Error('503 Service Unavailable'));
      const supa = makeRecordingSupa();
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

      const result = await fulfillClaimed(service, keyedPayload);

      // Entitlement was granted — the fulfillment itself must NOT be retried
      // (that would double-grant); only the delivery is re-queued.
      expect(result.success).toBe(true);
      expect(result.receiptSent).toBe(false);
      expect(result.receiptRetryQueued).toBe(true);

      const queued = supa.__inserts['bot_action_queue'];
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        guild_id: 'guild-1',
        action: 'deliver_receipt',
        status: 'pending',
      });
      expect(queued[0].payload).toMatchObject({
        discord_id: 'user-1',
        order_number: 'ORD-001',
        product_name: 'VIP Pass',
        license_key_plaintext: 'SMNI-AAAA-BBBB-CCCC-DDDD',
      });
      // The order date rides along so a delayed redelivery renders the
      // date of the order, not the date the retry finally succeeded.
      expect(new Date(queued[0].payload.order_date).getTime()).not.toBeNaN();
      // Alerting is handled by the queue's final-failure path, not here
      expect(supa.__inserts['alerts']).toBeUndefined();
    });

    it('retries the queue insert with backoff and recovers on a later attempt', async () => {
      vi.useFakeTimers();
      try {
        mockDeliverReceiptDM.mockRejectedValueOnce(new Error('503 Service Unavailable'));
        const supa = makeRecordingSupa({
          queueInsertError: { message: 'transient db blip' },
          queueInsertFailures: 1,
        });
        service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

        const resultPromise = fulfillClaimed(service, keyedPayload);
        await vi.advanceTimersByTimeAsync(10_000); // flush insert backoff sleeps
        const result = await resultPromise;

        expect(result.success).toBe(true);
        expect(result.receiptRetryQueued).toBe(true);
        // Failed once, then queued successfully — no DLQ, no alert
        expect(supa.__inserts['bot_action_queue']).toHaveLength(2);
        expect(supa.__inserts['action_queue_dlq']).toBeUndefined();
        expect(supa.__inserts['alerts']).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('preserves the payload in the DLQ and alerts when the queue insert keeps failing', async () => {
      vi.useFakeTimers();
      try {
        mockDeliverReceiptDM.mockRejectedValueOnce(
          Object.assign(new Error('Cannot send messages to this user'), { code: 50007 }),
        );
        const supa = makeRecordingSupa({ queueInsertError: { message: 'db unavailable' } });
        service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

        const resultPromise = fulfillClaimed(service, keyedPayload);
        await vi.advanceTimersByTimeAsync(10_000); // flush insert backoff sleeps
        const result = await resultPromise;

        expect(result.receiptSent).toBe(false);
        expect(result.receiptRetryQueued).toBe(false);

        // Queue insert retried before giving up
        expect(supa.__inserts['bot_action_queue']).toHaveLength(3);

        // The delivery payload — the only remaining copy of the plaintext
        // key — is preserved in the dashboard-retryable DLQ, not dropped
        const dlq = supa.__inserts['action_queue_dlq'];
        expect(dlq).toHaveLength(1);
        expect(dlq[0]).toMatchObject({
          guild_id: 'guild-1',
          action: 'deliver_receipt',
        });
        expect(dlq[0].payload).toMatchObject({
          discord_id: 'user-1',
          order_number: 'ORD-001',
          license_key_plaintext: 'SMNI-AAAA-BBBB-CCCC-DDDD',
        });
        expect(dlq[0].error_message).toContain('db unavailable');

        // Operator alert written — and it never contains the plaintext key.
        // It directs the operator to the recovery path that actually works
        // (DLQ retry / manual resend from the preserved payload) — NOT the
        // customer portal, which only shows a masked prefix…suffix key.
        const alerts = supa.__inserts['alerts'];
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
          guild_id: 'guild-1',
          alert_type: 'receipt_delivery_failed',
          severity: 'critical',
        });
        expect(alerts[0].message).toContain('dead-letter queue');
        expect(alerts[0].message).not.toContain('remains available through the customer portal');
        expect(alerts[0].metadata).toMatchObject({
          kind: 'permanent',
          orderNumber: 'ORD-001',
          payloadPreserved: true,
        });
        expect(JSON.stringify(alerts[0])).not.toContain('SMNI-AAAA-BBBB-CCCC-DDDD');
      } finally {
        vi.useRealTimers();
      }
    });

    it('tells the operator the key is unrecoverable when even the DLQ write fails', async () => {
      vi.useFakeTimers();
      try {
        mockDeliverReceiptDM.mockRejectedValueOnce(new Error('503 Service Unavailable'));
        const supa = makeRecordingSupa({
          queueInsertError: { message: 'db unavailable' },
          dlqInsertError: { message: 'db unavailable' },
        });
        service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

        const resultPromise = fulfillClaimed(service, keyedPayload);
        await vi.advanceTimersByTimeAsync(10_000); // flush insert backoff sleeps
        const result = await resultPromise;

        expect(result.receiptRetryQueued).toBe(false);

        // The alert must NOT claim the payload sits in the DLQ — it never
        // made it there. The remaining remediation is revoke + reissue.
        const alerts = supa.__inserts['alerts'];
        expect(alerts).toHaveLength(1);
        expect(alerts[0].message).toContain('could NOT be preserved');
        expect(alerts[0].message).toContain('revoke');
        expect(alerts[0].metadata).toMatchObject({ payloadPreserved: false });
        expect(JSON.stringify(alerts[0])).not.toContain('SMNI-AAAA-BBBB-CCCC-DDDD');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
