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
    // Real EmbedBuilder always exposes `data` (branded embeds read
    // data.footer to append attribution without clobbering it).
    data: Record<string, unknown> = {};
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
  MockTerminalNoopError,
} = vi.hoisted(() => ({
  mockGrant: vi.fn(async () => 'ent-123'),
  mockRevoke: vi.fn(async () => ({
    disposition: 'applied',
    transitionId: '11111111-1111-4111-8111-111111111111',
    status: 'cancelled',
    outwardGenerationId: '44444444-4444-4444-8444-444444444444',
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
       outwardGenerationId: '33333333-3333-4333-8333-333333333333',
     },
   })),
  mockFinishRoleDelivery: vi.fn(async () => ({
    state: 'open', settled: false, authorityEmpty: false, disposition: 'confirmed_open',
  })),
  mockExecuteRoleCleanup: vi.fn(async () => ({ state: 'settled', settled: true })),
  MockTerminalNoopError: class extends Error {
    constructor(readonly entitlementId: string | null) { super('terminal noop'); }
  },
}));

vi.mock('../features/commerce/entitlement-service.js', () => ({
  PurchaseRoleDeliveryTerminalNoopError: MockTerminalNoopError,
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
           outwardGenerationId: '33333333-3333-4333-8333-333333333333',
         };
      }
      return result;
    };
    revoke = async (...args: any[]) => {
      const result: any = await (mockRevoke as any)(...args);
      if (
        args[2]
        && result
        && ['applied', 'noop'].includes(result.disposition)
        && !Object.hasOwn(result, 'outwardGenerationId')
      ) {
        return {
          ...result,
          outwardGenerationId: '44444444-4444-4444-8444-444444444444',
        };
      }
      return result;
    };
    suspend = mockSuspend;
    startPaymentFailureGraceForFulfillment = async (...args: any[]) => {
      const result: any = await (mockSuspend as any)(...args);
      if (typeof result === 'boolean') {
        return result
          ? {
              disposition: 'applied',
              outwardGenerationId: '44444444-4444-4444-8444-444444444444',
              gracePeriodEndsAt: '2026-08-01T00:00:00.000Z',
            }
          : { disposition: 'failed', outwardGenerationId: null };
      }
      if (
        result
        && ['applied', 'replay'].includes(result.disposition)
        && typeof result.outwardGenerationId === 'string'
        && !Object.hasOwn(result, 'gracePeriodEndsAt')
      ) {
        return {
          ...result,
          gracePeriodEndsAt: '2026-08-01T00:00:00.000Z',
        };
      }
      return result;
    };
    reactivate = async (...args: any[]) => {
      const begun: any = await (mockBeginRoleDelivery as any)(...args);
      this.confirmedReplay = begun?.state === 'confirmed_live';
      this.activeAttempt = begun?.state === 'live' ? begun.attempt : null;
      const result = await (mockReactivate as any)(...args);
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
    getPurchaseRoleDeliveryOutwardGeneration = () =>
      this.activeAttempt?.outwardGenerationId
      ?? (this.confirmedReplay ? TEST_OUTWARD_GENERATION : null);
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

const { mockPrepareReceiptDM, mockPreparedReceiptSend } = vi.hoisted(() => {
  const preparedSend = vi.fn(async () => {});
  return {
    mockPrepareReceiptDM: vi.fn(async () => preparedSend),
    mockPreparedReceiptSend: preparedSend,
  };
});

vi.mock('../features/commerce/receipt-builder.js', () => ({
  sendReceiptDM: vi.fn(async () => true),
  prepareReceiptDM: mockPrepareReceiptDM,
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

const TEST_OUTWARD_GENERATION = '33333333-3333-4333-8333-333333333333';

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

function paidClaimWinner(args: Record<string, unknown>) {
  return {
    data: {
      order_id: args.p_order_id,
      disposition: 'winner',
      winning_order_id: args.p_order_id,
      conflicting_entitlement_id: null,
      alert_id: null,
    },
    error: null,
  };
}

function defaultOutwardIntentRpc(name: string, args: Record<string, unknown>) {
  if (name === 'commerce_resume_fulfillment_outward_intent') {
    return {
      data: {
        order_id: args.p_order_id,
        guild_id: args.p_guild_id,
        intent_kind: args.p_intent_kind,
        outward_generation_id: args.p_outward_generation_id,
        disposition: 'absent',
        state: null,
        attempt_token: null,
        alert_id: null,
      },
      error: null,
    };
  }
  if (name === 'commerce_begin_fulfillment_outward_intent') {
    return {
      data: {
        order_id: args.p_order_id,
        guild_id: args.p_guild_id,
        intent_kind: args.p_intent_kind,
        outward_generation_id: args.p_outward_generation_id,
        disposition: 'send',
        state: 'sending',
        attempt_token: '55555555-5555-4555-8555-555555555555',
        alert_id: null,
      },
      error: null,
    };
  }
  if (name === 'commerce_finish_fulfillment_outward_intent') {
    return {
      data: {
        order_id: args.p_order_id,
        guild_id: args.p_guild_id,
        intent_kind: args.p_intent_kind,
        outward_generation_id: args.p_outward_generation_id,
        state: args.p_outcome,
        alert_id: args.p_outcome === 'uncertain' ? 'alert-outward-uncertain' : null,
      },
      error: null,
    };
  }
  return { data: null, error: null };
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
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'commerce_claim_paid_fulfillment'
        ? paidClaimWinner(args)
        : defaultOutwardIntentRpc(name, args)),
  };
}

function makeOutwardIntentSupa(
  failFinishOnceFor:
    | 'purchase_completed_event'
    | 'subscription_activated_event'
    | 'subscription_renewed_event'
    | 'subscription_cancelled_event'
    | 'subscription_cancelled_dm'
    | 'subscription_payment_failed_lapsed_event'
    | 'subscription_payment_failed_event'
    | 'subscription_payment_failed_dm'
    | 'subscription_suspended_event'
    | 'subscription_suspended_dm'
    | 'receipt_dm'
    | null,
  overrides: {
    entitlement?: Record<string, unknown>;
    order?: Record<string, unknown>;
  } = {},
  failBeginOnceFor:
    | 'purchase_completed_event'
    | 'subscription_activated_event'
    | 'subscription_renewed_event'
    | 'subscription_cancelled_event'
    | 'subscription_cancelled_dm'
    | 'subscription_payment_failed_lapsed_event'
    | 'subscription_payment_failed_event'
    | 'subscription_payment_failed_dm'
    | 'subscription_suspended_event'
    | 'subscription_suspended_dm'
    | 'receipt_dm'
    | null = null,
) {
  const entitlement = {
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
    ...overrides.entitlement,
  };
  const supa: any = makeSupa({
    entitlements: entitlement,
    ...(overrides.order === undefined ? {} : { orders: overrides.order }),
  });
  const intents = new Map<string, {
    state: 'sending' | 'sent' | 'uncertain';
    attemptToken: string | null;
    outwardGenerationId: string | null;
  }>();
  let finishFailurePending = true;
  let beginFailurePending = failBeginOnceFor !== null;
  const resolveIntentKey = (
    args: Record<string, unknown>,
    create: boolean,
  ): string => {
    const base = `${String(args.p_order_id)}:${String(args.p_intent_kind)}`;
    const generation = (args.p_outward_generation_id ?? null) as string | null;
    const baseIntent = intents.get(base);
    if (baseIntent?.outwardGenerationId === generation) return base;
    const generated = `${base}:${generation ?? 'legacy'}`;
    if (intents.get(generated)?.outwardGenerationId === generation) return generated;
    return create && baseIntent ? generated : base;
  };
  supa.rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'commerce_claim_paid_fulfillment') {
      return paidClaimWinner(args);
    }
    if (
      name === 'commerce_begin_fulfillment_outward_intent'
      || name === 'commerce_resume_fulfillment_outward_intent'
      || name === 'commerce_continue_legacy_receipt_outward_intent'
    ) {
      const outwardArgs: Record<string, unknown> =
        name === 'commerce_continue_legacy_receipt_outward_intent'
        ? {
            ...args,
            p_intent_kind: 'receipt_dm',
            p_outward_generation_id: null,
          }
        : {
            ...args,
            p_outward_generation_id: args.p_outward_generation_id ?? null,
          };
      const key = resolveIntentKey(
        outwardArgs,
        name !== 'commerce_resume_fulfillment_outward_intent',
      );
      const existing = intents.get(key);
      if (
        name === 'commerce_begin_fulfillment_outward_intent'
        && outwardArgs.p_intent_kind === failBeginOnceFor
        && beginFailurePending
      ) {
        beginFailurePending = false;
        return {
          data: null,
          error: { message: 'worker crashed before outward dispatch', code: '08006' },
        };
      }
      if (!existing) {
        if (name === 'commerce_resume_fulfillment_outward_intent') {
          return {
            data: {
              order_id: outwardArgs.p_order_id,
              guild_id: outwardArgs.p_guild_id,
              intent_kind: outwardArgs.p_intent_kind,
              outward_generation_id: outwardArgs.p_outward_generation_id,
              disposition: 'absent',
              state: null,
              attempt_token: null,
              alert_id: null,
            },
            error: null,
          };
        }
        const attemptToken = '55555555-5555-4555-8555-555555555555';
        const legacyReceiptHasPredecessor =
          name === 'commerce_continue_legacy_receipt_outward_intent'
          && outwardArgs.p_intent_kind === 'receipt_dm'
          && outwardArgs.p_outward_generation_id === null
          && args.p_action_id === TEST_ACTION_CLAIM.actionId
          && args.p_claim_token === TEST_ACTION_CLAIM.claimToken
          && [
            'purchase_completed_event',
            'subscription_activated_event',
          ].includes(String(args.p_predecessor_kind))
          && [...intents.entries()].some(([candidateKey, candidate]) =>
            candidateKey.startsWith(`${String(outwardArgs.p_order_id)}:`)
            && candidateKey.includes(String(args.p_predecessor_kind))
            && candidate.outwardGenerationId === null
            && candidate.state === 'sent');
        if (
          typeof outwardArgs.p_outward_generation_id !== 'string'
          && !legacyReceiptHasPredecessor
        ) {
          return {
            data: null,
            error: { message: 'new outward generation is required', code: '23514' },
          };
        }
        intents.set(key, {
          state: 'sending',
          attemptToken,
          outwardGenerationId: outwardArgs.p_outward_generation_id as string | null,
        });
        return {
          data: {
            order_id: outwardArgs.p_order_id,
            guild_id: outwardArgs.p_guild_id,
            intent_kind: outwardArgs.p_intent_kind,
            outward_generation_id: outwardArgs.p_outward_generation_id,
            disposition: 'send',
            state: 'sending',
            attempt_token: attemptToken,
            alert_id: null,
          },
          error: null,
        };
      }
      if (existing.outwardGenerationId !== outwardArgs.p_outward_generation_id) {
        return {
          data: null,
          error: { message: 'outward generation mismatch', code: '23514' },
        };
      }
      if (existing.state === 'sending') {
        existing.state = 'uncertain';
        existing.attemptToken = null;
      }
      return {
        data: {
          order_id: outwardArgs.p_order_id,
          guild_id: outwardArgs.p_guild_id,
          intent_kind: outwardArgs.p_intent_kind,
          outward_generation_id: existing.outwardGenerationId,
          disposition: existing.state === 'sent' ? 'sent' : 'uncertain',
          state: existing.state,
          attempt_token: null,
          alert_id: existing.state === 'uncertain' ? 'alert-outward-uncertain' : null,
        },
        error: null,
      };
    }
    if (name === 'commerce_finish_fulfillment_outward_intent') {
      if (
        failFinishOnceFor !== null
        && args.p_intent_kind === failFinishOnceFor
        && finishFailurePending
      ) {
        finishFailurePending = false;
        return { data: null, error: { message: 'commit result unavailable', code: '08006' } };
      }
      const key = resolveIntentKey(args, false);
      const existing = intents.get(key);
      if (
        !existing
        || existing.attemptToken !== args.p_attempt_token
        || existing.outwardGenerationId !== args.p_outward_generation_id
      ) {
        return { data: null, error: { message: 'intent identity mismatch', code: '23514' } };
      }
      existing.state = args.p_outcome === 'sent' ? 'sent' : 'uncertain';
      existing.attemptToken = null;
      return {
        data: {
          order_id: args.p_order_id,
          guild_id: args.p_guild_id,
          intent_kind: args.p_intent_kind,
          outward_generation_id: existing.outwardGenerationId,
          state: existing.state,
          alert_id: existing.state === 'uncertain' ? 'alert-outward-uncertain' : null,
        },
        error: null,
      };
    }
    return { data: null, error: null };
  });
  supa.__intents = intents;
  supa.__entitlement = entitlement;
  return supa;
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
      if (name === 'commerce_claim_paid_fulfillment') {
        return paidClaimWinner(args);
      }
      if (
        name === 'commerce_begin_fulfillment_outward_intent'
        || name === 'commerce_resume_fulfillment_outward_intent'
        || name === 'commerce_finish_fulfillment_outward_intent'
      ) {
        return defaultOutwardIntentRpc(name, args);
      }
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

function withSubscriptionLifecycle(
  payload: FulfillmentPayload,
): FulfillmentPayload {
  const eventTypes: Record<string, string> = {
    subscription_activated: 'BILLING.SUBSCRIPTION.ACTIVATED',
    subscription_renewed: 'PAYMENT.SALE.COMPLETED',
    subscription_cancelled: 'BILLING.SUBSCRIPTION.CANCELLED',
    subscription_suspended: 'BILLING.SUBSCRIPTION.SUSPENDED',
    subscription_payment_failed: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  };
  const providerEventType = eventTypes[payload.fulfillment_type];
  if (!providerEventType) return payload;
  const requiresPaidThrough = [
    'subscription_activated',
    'subscription_renewed',
  ].includes(payload.fulfillment_type);
  return {
    ...payload,
    webhook_event_id: payload.webhook_event_id ?? 'WH-EVENT-001',
    provider_event_type: providerEventType,
    provider_occurred_at: payload.provider_occurred_at ?? '2026-07-29T00:00:00.000Z',
    provider_paid_through_at: requiresPaidThrough
      ? payload.provider_paid_through_at ?? '2026-08-29T00:00:00.000Z'
      : null,
    lifecycle_generation: payload.lifecycle_generation ?? 1,
  };
}

function fulfillClaimed(
  service: CommerceFulfillmentService,
  payload: FulfillmentPayload,
) {
  return service.fulfill(withSubscriptionLifecycle(payload), TEST_ACTION_CLAIM);
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
  paypal_capture_id: 'CAPTURE-001',
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
  paypal_capture_id: undefined,
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
  paypal_capture_id: undefined,
  plan_id: 'plan-monthly',
  paypal_subscription_id: 'SUB-001',
  webhook_event_id: 'WH-EVENT-001',
  provider_event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
  provider_occurred_at: '2026-07-29T00:00:00.000Z',
  provider_paid_through_at: null,
  lifecycle_generation: 1,
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
    updated_at: '2026-07-27T00:00:00.000Z',
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
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'commerce_claim_paid_fulfillment'
        ? paidClaimWinner(args)
        : defaultOutwardIntentRpc(name, args)),
  };
}

describe('CommerceFulfillmentService', () => {
  let service: CommerceFulfillmentService;
  let eventBus: any;

  beforeEach(() => {
    vi.resetAllMocks();
    eventBus = {
      emit: vi.fn(),
      emitAndWait: vi.fn(async () => {}),
      on: vi.fn(),
      off: vi.fn(),
    };
    eventBus.prepareEmitAndWait = vi.fn((
      type: string,
      guildId: string,
      data: Record<string, unknown>,
    ) => {
      let state: 'prepared' | 'dispatched' | 'cancelled' = 'prepared';
      return {
        dispatch: vi.fn(async () => {
          if (state !== 'prepared') throw new Error(`Prepared event is ${state}`);
          state = 'dispatched';
          await eventBus.emitAndWait(type, guildId, data);
        }),
        cancel: vi.fn(() => {
          if (state === 'prepared') state = 'cancelled';
        }),
      };
    });
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
    it('durably confirms the role generation before an exact claimed action begins outward delivery', async () => {
      const supabase = makeSupa();
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);
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
      expect(mockFinishRoleDelivery).toHaveBeenCalledTimes(1);
      expect(mockFinishRoleDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ outwardGenerationId: TEST_OUTWARD_GENERATION }),
        'live',
      );
      const beginIndex = supabase.rpc.mock.calls.findIndex(
        (call: [string, Record<string, unknown>]) =>
          call[0] === 'commerce_begin_fulfillment_outward_intent',
      );
      expect(beginIndex).toBeGreaterThanOrEqual(0);
      expect(supabase.rpc.mock.calls[beginIndex]?.[1]).toMatchObject({
        p_action_id: TEST_ACTION_CLAIM.actionId,
        p_claim_token: TEST_ACTION_CLAIM.claimToken,
        p_outward_generation_id: TEST_OUTWARD_GENERATION,
      });
      expect(mockFinishRoleDelivery.mock.invocationCallOrder[0])
        .toBeLessThan(supabase.rpc.mock.invocationCallOrder[beginIndex]!);
    });

    it('marks a rejected awaited purchase listener uncertain instead of sent', async () => {
      eventBus.emitAndWait.mockRejectedValueOnce(new Error('automation listener failed'));
      const supabase = makeSupa();
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, basePayload);

      expect(result.success).toBe(false);
      expect(result.eventEmitted).toBe(false);
      expect(result.receiptSent).toBeUndefined();
      expect(eventBus.emitAndWait).toHaveBeenCalledOnce();
      expect(supabase.rpc).toHaveBeenCalledWith(
        'commerce_finish_fulfillment_outward_intent',
        expect.objectContaining({
          p_intent_kind: 'purchase_completed_event',
          p_outcome: 'uncertain',
          p_error: expect.stringContaining('automation listener failed'),
        }),
      );
    });

    it('does not begin a receipt intent when pre-send Discord preparation fails', async () => {
      mockPrepareReceiptDM.mockRejectedValueOnce(new Error('createDM failed'));
      const supabase = makeSupa();
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, basePayload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('createDM failed');
      expect(mockPreparedReceiptSend).not.toHaveBeenCalled();
      expect(supabase.rpc).not.toHaveBeenCalledWith(
        'commerce_begin_fulfillment_outward_intent',
        expect.objectContaining({ p_intent_kind: 'receipt_dm' }),
      );
    });

    it.each([
      'purchase_completed_event',
      'receipt_dm',
    ] as const)(
      'never repeats an externally accepted effect after the %s sent marker commit is lost',
      async (failedIntentKind) => {
        const supabase = makeOutwardIntentSupa(failedIntentKind);
        const guild = makeGuild();
        const first = new CommerceFulfillmentService(guild, supabase, eventBus);
        const second = new CommerceFulfillmentService(guild, supabase, eventBus);

        const firstResult = await fulfillClaimed(first, basePayload);
        const replayResult = await fulfillClaimed(second, basePayload);

        expect(firstResult.success).toBe(false);
        expect(replayResult.success).toBe(false);
        expect(replayResult.errors.join(' ')).toContain('operator reconciliation');
        expect(eventBus.emitAndWait).toHaveBeenCalledTimes(1);
        expect(mockPreparedReceiptSend).toHaveBeenCalledTimes(
          failedIntentKind === 'receipt_dm' ? 1 : 0,
        );
        expect(supabase.__intents.get(`order-1:${failedIntentKind}`)?.state)
          .toBe('uncertain');
        expect(supabase.rpc).toHaveBeenCalledWith(
          'commerce_begin_fulfillment_outward_intent',
          expect.objectContaining({
            p_order_id: 'order-1',
            p_guild_id: 'guild-1',
            p_intent_kind: failedIntentKind,
          }),
        );
      },
    );

    it('resumes a lost purchase event marker after role delivery settled without re-emitting', async () => {
      const supabase = makeOutwardIntentSupa('purchase_completed_event');
      const guild = makeGuild();
      const first = new CommerceFulfillmentService(guild, supabase, eventBus);
      const replay = new CommerceFulfillmentService(guild, supabase, eventBus);
      (mockBeginRoleDelivery as any)
        .mockResolvedValueOnce({
          state: 'live',
          attempt: {
            ...TEST_ACTION_CLAIM,
            intentId: '11111111-1111-4111-8111-111111111111',
            mutationToken: '22222222-2222-4222-8222-222222222222',
            outwardGenerationId: TEST_OUTWARD_GENERATION,
          },
        })
        .mockResolvedValueOnce({
          state: 'confirmed_live',
          intentId: '11111111-1111-4111-8111-111111111111',
          outwardGenerationId: TEST_OUTWARD_GENERATION,
        });

      const firstResult = await fulfillClaimed(first, basePayload);
      const replayResult = await fulfillClaimed(replay, basePayload);

      expect(firstResult.success).toBe(false);
      expect(replayResult).toMatchObject({
        success: false,
        eventEmitted: false,
        errors: [
          expect.stringContaining('operator reconciliation'),
        ],
      });
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(1);
      expect(mockPreparedReceiptSend).not.toHaveBeenCalled();
      expect(supabase.__intents.get('order-1:purchase_completed_event')?.state)
        .toBe('uncertain');
      expect(supabase.__intents.get('order-1:receipt_dm')).toBeUndefined();
      expect(supabase.rpc).toHaveBeenCalledWith(
        'commerce_begin_fulfillment_outward_intent',
        expect.objectContaining({
          p_order_id: 'order-1',
          p_guild_id: 'guild-1',
          p_intent_kind: 'purchase_completed_event',
        }),
      );
    });

    it('keeps a null-generation legacy confirmed purchase with no event row fully deduped', async () => {
      const supabase = makeOutwardIntentSupa(null);
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supabase, eventBus);
      (mockBeginRoleDelivery as any).mockResolvedValueOnce({
        state: 'confirmed_live',
        intentId: '11111111-1111-4111-8111-111111111111',
        outwardGenerationId: null,
      });

      const result = await fulfillClaimed(service, basePayload);

      expect(result).toMatchObject({
        success: true,
        eventEmitted: false,
        errors: [],
      });
      expect(result.receiptSent).toBeUndefined();
      expect(eventBus.emitAndWait).not.toHaveBeenCalled();
      expect(mockPreparedReceiptSend).not.toHaveBeenCalled();
      expect(supabase.rpc).toHaveBeenCalledWith(
        'commerce_resume_fulfillment_outward_intent',
        {
          p_order_id: 'order-1',
          p_guild_id: 'guild-1',
          p_intent_kind: 'purchase_completed_event',
        },
      );
    });

    it('continues a null-generation partial protocol with one missing receipt and then dedupes it', async () => {
      const supabase = makeOutwardIntentSupa(null);
      supabase.__intents.set('order-1:purchase_completed_event', {
        state: 'sent',
        attemptToken: null,
        outwardGenerationId: null,
      });
      const guild = makeGuild();
      const first = new CommerceFulfillmentService(guild, supabase, eventBus);
      const replay = new CommerceFulfillmentService(guild, supabase, eventBus);
      (mockBeginRoleDelivery as any)
        .mockResolvedValueOnce({
          state: 'confirmed_live',
          intentId: '11111111-1111-4111-8111-111111111111',
          outwardGenerationId: null,
        })
        .mockResolvedValueOnce({
          state: 'confirmed_live',
          intentId: '11111111-1111-4111-8111-111111111111',
          outwardGenerationId: null,
        });

      const result = await fulfillClaimed(first, basePayload);
      const replayResult = await fulfillClaimed(replay, basePayload);

      expect(result).toMatchObject({
        success: true,
        eventEmitted: true,
        receiptSent: true,
        errors: [],
      });
      expect(replayResult).toMatchObject({
        success: true,
        eventEmitted: true,
        receiptSent: true,
        errors: [],
      });
      expect(eventBus.emitAndWait).not.toHaveBeenCalled();
      expect(mockPreparedReceiptSend).toHaveBeenCalledTimes(1);
      expect(supabase.__intents.get('order-1:receipt_dm')).toMatchObject({
        state: 'sent',
        outwardGenerationId: null,
      });
      expect(supabase.rpc).toHaveBeenCalledWith(
        'commerce_continue_legacy_receipt_outward_intent',
        {
          p_order_id: 'order-1',
          p_guild_id: 'guild-1',
          p_predecessor_kind: 'purchase_completed_event',
          p_action_id: TEST_ACTION_CLAIM.actionId,
          p_claim_token: TEST_ACTION_CLAIM.claimToken,
        },
      );
    });

    it('does not continue a legacy receipt after an uncertain predecessor', async () => {
      const supabase = makeOutwardIntentSupa(null);
      supabase.__intents.set('order-1:purchase_completed_event', {
        state: 'uncertain',
        attemptToken: null,
        outwardGenerationId: null,
      });
      service = new CommerceFulfillmentService(makeGuild(), supabase, eventBus);
      (mockBeginRoleDelivery as any).mockResolvedValueOnce({
        state: 'confirmed_live',
        intentId: '11111111-1111-4111-8111-111111111111',
        outwardGenerationId: null,
      });

      const result = await fulfillClaimed(service, basePayload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('operator reconciliation');
      expect(mockPreparedReceiptSend).not.toHaveBeenCalled();
      expect(supabase.__intents.get('order-1:receipt_dm')).toBeUndefined();
      expect(supabase.rpc).not.toHaveBeenCalledWith(
        'commerce_continue_legacy_receipt_outward_intent',
        expect.anything(),
      );
    });

    it('recovers a crash after role confirmation but before the first purchase outward dispatch', async () => {
      const supabase = makeOutwardIntentSupa(
        null,
        {},
        'purchase_completed_event',
      );
      const guild = makeGuild();
      const first = new CommerceFulfillmentService(guild, supabase, eventBus);
      const replay = new CommerceFulfillmentService(guild, supabase, eventBus);
      (mockBeginRoleDelivery as any)
        .mockResolvedValueOnce({
          state: 'live',
          attempt: {
            ...TEST_ACTION_CLAIM,
            intentId: '11111111-1111-4111-8111-111111111111',
            mutationToken: '22222222-2222-4222-8222-222222222222',
            outwardGenerationId: TEST_OUTWARD_GENERATION,
          },
        })
        .mockResolvedValueOnce({
          state: 'confirmed_live',
          intentId: '11111111-1111-4111-8111-111111111111',
          outwardGenerationId: TEST_OUTWARD_GENERATION,
        });

      const firstResult = await fulfillClaimed(first, basePayload);
      const replayResult = await fulfillClaimed(replay, basePayload);

      expect(firstResult.success).toBe(false);
      expect(replayResult).toMatchObject({
        success: true,
        eventEmitted: true,
        receiptSent: true,
        errors: [],
      });
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(1);
      expect(mockPreparedReceiptSend).toHaveBeenCalledTimes(1);
      expect(supabase.__intents.get('order-1:purchase_completed_event')?.state)
        .toBe('sent');
      expect(supabase.rpc).toHaveBeenCalledWith(
        'commerce_begin_fulfillment_outward_intent',
        expect.objectContaining({
          p_order_id: 'order-1',
          p_guild_id: 'guild-1',
          p_intent_kind: 'purchase_completed_event',
          p_outward_generation_id: TEST_OUTWARD_GENERATION,
          p_action_id: TEST_ACTION_CLAIM.actionId,
          p_claim_token: TEST_ACTION_CLAIM.claimToken,
        }),
      );
      expect(mockFinishRoleDelivery.mock.calls).toHaveLength(1);
      expect((mockFinishRoleDelivery.mock.calls as unknown[][])[0]?.[1]).toBe('live');
      const firstBeginIndex = supabase.rpc.mock.calls.findIndex(
        ([name]: [string]) => name === 'commerce_begin_fulfillment_outward_intent',
      );
      expect(mockFinishRoleDelivery.mock.invocationCallOrder[0])
        .toBeLessThan(supabase.rpc.mock.invocationCallOrder[firstBeginIndex]!);
    });

    it('does not create outward state under zero-dispatch backpressure and dispatches once on retry', async () => {
      const supabase = makeOutwardIntentSupa(null);
      const guild = makeGuild();
      const first = new CommerceFulfillmentService(guild, supabase, eventBus);
      const replay = new CommerceFulfillmentService(guild, supabase, eventBus);
      const preDispatchError = Object.assign(
        new Error('Backpressure: awaited listener capacity exhausted'),
        {
          name: 'EventBusDispatchNotStartedError',
          dispatchState: 'not_started',
          reason: 'backpressure',
        },
      );
      let acceptedDispatches = 0;
      eventBus.prepareEmitAndWait.mockImplementationOnce(() => {
        throw preDispatchError;
      });
      eventBus.emitAndWait.mockImplementation(async () => {
        acceptedDispatches += 1;
      });
      (mockBeginRoleDelivery as any)
        .mockResolvedValueOnce({
          state: 'live',
          attempt: {
            ...TEST_ACTION_CLAIM,
            intentId: '11111111-1111-4111-8111-111111111111',
            mutationToken: '22222222-2222-4222-8222-222222222222',
            outwardGenerationId: TEST_OUTWARD_GENERATION,
          },
        })
        .mockResolvedValueOnce({
          state: 'confirmed_live',
          intentId: '11111111-1111-4111-8111-111111111111',
          outwardGenerationId: TEST_OUTWARD_GENERATION,
        });

      const firstResult = await fulfillClaimed(first, basePayload);
      const outwardCallsAfterBackpressure = supabase.rpc.mock.calls.filter(
        ([name]: [string]) => name.includes('fulfillment_outward_intent'),
      );
      const replayResult = await fulfillClaimed(replay, basePayload);
      expect(firstResult).toMatchObject({
        success: false,
        eventEmitted: false,
      });
      expect(firstResult.receiptSent).not.toBe(true);
      expect(outwardCallsAfterBackpressure).toEqual([]);

      expect(replayResult).toMatchObject({
        success: true,
        eventEmitted: true,
        receiptSent: true,
        errors: [],
      });
      expect(acceptedDispatches).toBe(1);
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(1);
      expect(supabase.__intents.get('order-1:purchase_completed_event')?.state)
        .toBe('sent');
    });

    it('completes a backfilled losing queue row as held before any entitlement or Discord effect', async () => {
      const supabase: any = makeSupa();
      supabase.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
        if (name !== 'commerce_claim_paid_fulfillment') {
          return { data: null, error: null };
        }
        expect(args).toEqual({
          p_order_id: 'order-1',
          p_guild_id: 'guild-1',
          p_customer_id: 'cust-1',
          p_product_id: 'prod-1',
          p_provider_kind: 'capture',
          p_provider_id: 'CAPTURE-001',
          p_amount_cents: 999,
          p_currency: 'USD',
        });
        return {
          data: {
            order_id: 'order-1',
            disposition: 'held',
            winning_order_id: 'order-winner',
            conflicting_entitlement_id: null,
            alert_id: 'alert-duplicate-capture',
          },
          error: null,
        };
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supabase as any, eventBus);

      const result = await fulfillClaimed(service, basePayload);

      expect(result).toMatchObject({
        success: true,
        paidFulfillmentHeld: true,
        eventEmitted: false,
        errors: [],
      });
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockBeginRoleDelivery).not.toHaveBeenCalled();
      expect(mockEnsurePurchaseGrantedRoles).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(guild.members.fetch).not.toHaveBeenCalled();
      expect(guild.client.users.fetch).not.toHaveBeenCalled();
      expect(supabase.from.mock.calls.some(([table]: [string]) => table === 'entitlements'))
        .toBe(false);
    });

    it('fails closed before entitlement mutation when the durable paid claim is unavailable', async () => {
      const supabase: any = makeSupa();
      supabase.rpc.mockResolvedValue({
        data: null,
        error: { message: 'claim database unavailable' },
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supabase as any, eventBus);

      const result = await fulfillClaimed(service, basePayload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('Failed to claim paid fulfillment');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockBeginRoleDelivery).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(guild.members.fetch).not.toHaveBeenCalled();
      expect(guild.client.users.fetch).not.toHaveBeenCalled();
    });

    it('does not trust a syntactically valid but wrong capture ID from a queued payload', async () => {
      const supabase: any = makeSupa();
      supabase.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
        expect(name).toBe('commerce_claim_paid_fulfillment');
        expect(args.p_provider_id).toBe('CAPTURE-WRONG-ORDER');
        return {
          data: null,
          error: { message: 'completed capture payment identity mismatch' },
        };
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supabase, eventBus);

      const result = await fulfillClaimed(service, {
        ...basePayload,
        paypal_capture_id: 'CAPTURE-WRONG-ORDER',
      });

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('completed capture payment identity mismatch');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockBeginRoleDelivery).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(guild.members.fetch).not.toHaveBeenCalled();
      expect(guild.client.users.fetch).not.toHaveBeenCalled();
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
      if (orderPatch.status === 'pending_review') {
        expect(supabase.rpc).toHaveBeenCalledWith(
          'commerce_claim_paid_fulfillment',
          expect.objectContaining({ p_order_id: 'order-1' }),
        );
      } else {
        expect(supabase.rpc).not.toHaveBeenCalled();
      }
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
      expect(supabase.rpc).toHaveBeenCalledWith(
        'commerce_claim_paid_fulfillment',
        expect.objectContaining({ p_order_id: 'order-1' }),
      );
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
        outwardGenerationId: TEST_OUTWARD_GENERATION,
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
      expect(mockPreparedReceiptSend).not.toHaveBeenCalled();
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
      const prepareCallIndex = harness.supabase.rpc.mock.calls.findIndex(
        ([name]: [string]) => name === 'commerce_prepare_temp_role_grant',
      );
      expect(prepareCallIndex).toBeGreaterThan(-1);
      expect(harness.supabase.rpc.mock.invocationCallOrder[0]).toBeLessThan(
        mockGrant.mock.invocationCallOrder[0],
      );
      expect(mockGrant.mock.invocationCallOrder[0]).toBeLessThan(
        harness.supabase.rpc.mock.invocationCallOrder[prepareCallIndex],
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
      expect(eventBus.emitAndWait).not.toHaveBeenCalledWith(
        'purchase.completed',
        expect.anything(),
        expect.anything(),
      );
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
          outwardGenerationId: TEST_OUTWARD_GENERATION,
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
          outwardGenerationId: TEST_OUTWARD_GENERATION,
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
    it.each([
      {
        label: 'provider event type does not match activation',
        patch: { provider_event_type: 'PAYMENT.SALE.COMPLETED' },
      },
      {
        label: 'lifecycle generation is missing',
        patch: { lifecycle_generation: undefined },
      },
      {
        label: 'provider occurrence time is invalid',
        patch: { provider_occurred_at: 'not-a-timestamp' },
      },
      {
        label: 'paid-through time does not follow occurrence time',
        patch: { provider_paid_through_at: '2026-07-29T00:00:00.000Z' },
      },
      {
        label: 'paid-through time is missing',
        patch: { provider_paid_through_at: null },
      },
    ])('rejects lifecycle payload when $label', async ({ patch }) => {
      const supabase = makeSupa({ orders: subscriptionOrderSnapshot });
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);
      const payload = {
        ...withSubscriptionLifecycle(subscriptionActivationPayload),
        ...patch,
      } as FulfillmentPayload;

      const result = await service.fulfill(payload, TEST_ACTION_CLAIM);

      expect(result).toMatchObject({
        success: false,
        eventEmitted: false,
        errors: [expect.stringContaining('lifecycle validation')],
      });
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockBeginRoleDelivery).not.toHaveBeenCalled();
      expect(eventBus.emitAndWait).not.toHaveBeenCalled();
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('replays a pending-review subscription hold as a terminal worker no-op', async () => {
      const supabase: any = makeSupa({
        orders: {
          ...subscriptionOrderSnapshot,
          status: 'pending_review',
        },
      });
      supabase.rpc.mockResolvedValue({
        data: {
          order_id: 'order-1',
          disposition: 'held',
          winning_order_id: 'order-winner',
          conflicting_entitlement_id: null,
          alert_id: 'alert-duplicate-subscription',
        },
        error: null,
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supabase as any, eventBus);

      const result = await fulfillClaimed(service, subscriptionActivationPayload);

      expect(result).toMatchObject({
        success: true,
        paidFulfillmentHeld: true,
        eventEmitted: false,
        errors: [],
      });
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockBeginRoleDelivery).not.toHaveBeenCalled();
      expect(eventBus.emitAndWait).not.toHaveBeenCalled();
      expect(guild.members.fetch).not.toHaveBeenCalled();
      expect(guild.client.users.fetch).not.toHaveBeenCalled();
    });

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
        licenseKeyId: undefined,
        discordId: 'user-1',
        type: 'subscription',
        source: 'purchase',
        grantedRoleIds: ['role-1'],
        grantedChannelIds: [],
        expiresAt: '2026-08-29T00:00:00.000Z',
        roleDeliveryClaim: TEST_ACTION_CLAIM,
      });
      expect(mockEnsurePurchaseGrantedRoles).not.toHaveBeenCalled();
      expect(eventBus.emitAndWait).toHaveBeenCalledWith(
        'subscription.activated',
        'guild-1',
        expect.objectContaining({ status: 'activated' }),
      );
    });

    it('resumes a lost subscription event marker after role delivery settled without re-emitting', async () => {
      const supabase = makeOutwardIntentSupa(
        'subscription_activated_event',
        {
          entitlement: {
            plan_id: 'plan-monthly',
            type: 'subscription',
          },
          order: subscriptionOrderSnapshot,
        },
      );
      const guild = makeGuild();
      const first = new CommerceFulfillmentService(guild, supabase, eventBus);
      const replay = new CommerceFulfillmentService(guild, supabase, eventBus);
      (mockBeginRoleDelivery as any)
        .mockResolvedValueOnce({
          state: 'live',
          attempt: {
            ...TEST_ACTION_CLAIM,
            intentId: '11111111-1111-4111-8111-111111111111',
            mutationToken: '22222222-2222-4222-8222-222222222222',
            outwardGenerationId: TEST_OUTWARD_GENERATION,
          },
        })
        .mockResolvedValueOnce({
          state: 'confirmed_live',
          intentId: '11111111-1111-4111-8111-111111111111',
          outwardGenerationId: TEST_OUTWARD_GENERATION,
        });

      const firstResult = await fulfillClaimed(first, subscriptionActivationPayload);
      const replayResult = await fulfillClaimed(replay, subscriptionActivationPayload);

      expect(firstResult.success).toBe(false);
      expect(replayResult).toMatchObject({
        success: false,
        eventEmitted: false,
        errors: [
          expect.stringContaining('operator reconciliation'),
        ],
      });
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(1);
      expect(mockPreparedReceiptSend).not.toHaveBeenCalled();
      expect(supabase.__intents.get('order-1:subscription_activated_event')?.state)
        .toBe('uncertain');
      expect(supabase.__intents.get('order-1:receipt_dm')).toBeUndefined();
      expect(supabase.rpc).toHaveBeenCalledWith(
        'commerce_begin_fulfillment_outward_intent',
        expect.objectContaining({
          p_order_id: 'order-1',
          p_guild_id: 'guild-1',
          p_intent_kind: 'subscription_activated_event',
        }),
      );
    });

    it('recovers a crash after role confirmation but before the first subscription outward dispatch', async () => {
      const supabase = makeOutwardIntentSupa(
        null,
        {
          entitlement: {
            plan_id: 'plan-monthly',
            type: 'subscription',
          },
          order: subscriptionOrderSnapshot,
        },
        'subscription_activated_event',
      );
      const guild = makeGuild();
      const first = new CommerceFulfillmentService(guild, supabase, eventBus);
      const replay = new CommerceFulfillmentService(guild, supabase, eventBus);
      (mockBeginRoleDelivery as any)
        .mockResolvedValueOnce({
          state: 'live',
          attempt: {
            ...TEST_ACTION_CLAIM,
            intentId: '11111111-1111-4111-8111-111111111111',
            mutationToken: '22222222-2222-4222-8222-222222222222',
            outwardGenerationId: TEST_OUTWARD_GENERATION,
          },
        })
        .mockResolvedValueOnce({
          state: 'confirmed_live',
          intentId: '11111111-1111-4111-8111-111111111111',
          outwardGenerationId: TEST_OUTWARD_GENERATION,
        });

      const firstResult = await fulfillClaimed(first, subscriptionActivationPayload);
      const replayResult = await fulfillClaimed(replay, subscriptionActivationPayload);

      expect(firstResult.success).toBe(false);
      expect(replayResult).toMatchObject({
        success: true,
        eventEmitted: true,
        receiptSent: true,
        errors: [],
      });
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(1);
      expect(mockPreparedReceiptSend).toHaveBeenCalledTimes(1);
      expect(supabase.__intents.get('order-1:subscription_activated_event')?.state)
        .toBe('sent');
      expect(supabase.rpc).toHaveBeenCalledWith(
        'commerce_begin_fulfillment_outward_intent',
        expect.objectContaining({
          p_order_id: 'order-1',
          p_guild_id: 'guild-1',
          p_intent_kind: 'subscription_activated_event',
          p_outward_generation_id: TEST_OUTWARD_GENERATION,
        }),
      );
    });

    it('binds a staged subscription licence key to the granted entitlement', async () => {
      const payload: FulfillmentPayload = {
        ...subscriptionActivationPayload,
        license_key_id: 'license-subscription-1',
        license_key_plaintext: 'SMNI-AAAA-BBBB-CCCC-DDDD',
      };
      service = new CommerceFulfillmentService(
        makeGuild(),
        makeSupa({ orders: subscriptionOrderSnapshot }) as any,
        eventBus,
      );

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(true);
      expect(mockGrant).toHaveBeenCalledWith(expect.objectContaining({
        orderId: 'order-1',
        planId: 'plan-monthly',
        type: 'subscription',
        licenseKeyId: 'license-subscription-1',
      }));
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
        expect(eventBus.emitAndWait).not.toHaveBeenCalled();
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
      expect(eventBus.emitAndWait).toHaveBeenCalled();
    });

    it('reuses and re-confirms the exact subscription entitlement after a worker replay', async () => {
      mockGrant.mockResolvedValueOnce('ent-sub');
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
      expect(mockGrant).toHaveBeenCalledWith(expect.objectContaining({
        orderId: 'order-1',
        expiresAt: '2026-08-29T00:00:00.000Z',
        roleDeliveryClaim: TEST_ACTION_CLAIM,
      }));
      expect(mockEnsurePurchaseGrantedRoles).not.toHaveBeenCalled();
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
      mockGrant.mockRejectedValueOnce(new MockTerminalNoopError('ent-sub'));
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(true);
      expect(result.entitlementId).toBe('ent-sub');
      expect(result.eventEmitted).toBe(false);
      expect(eventBus.emitAndWait).not.toHaveBeenCalled();
      expect(mockPreparedReceiptSend).not.toHaveBeenCalled();
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

    it('applies a frozen subscription temporary grant before role confirmation and outward delivery', async () => {
      const harness = makeTemporaryRoleHarness({
        orderPlanId: 'plan-monthly',
        orderPaypalSubscriptionId: 'SUB-001',
        orderTemporaryRoleGrants: [
          { role_id: TEMP_ROLE_ID, duration_seconds: 60 },
        ],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);
      const payload: FulfillmentPayload = {
        ...subscriptionActivationPayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      };

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(true);
      expect(harness.member.roles.add).toHaveBeenCalledWith(
        TEMP_ROLE_ID,
        expect.stringContaining('temporary commerce role'),
      );
      expect(mockFinishRoleDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ outwardGenerationId: TEST_OUTWARD_GENERATION }),
        'live',
      );
      const beginIndex = harness.supabase.rpc.mock.calls.findIndex(
        ([name]: [string]) => name === 'commerce_begin_fulfillment_outward_intent',
      );
      expect(harness.member.roles.add.mock.invocationCallOrder[0])
        .toBeLessThan(mockFinishRoleDelivery.mock.invocationCallOrder[0]!);
      expect(mockFinishRoleDelivery.mock.invocationCallOrder[0])
        .toBeLessThan(harness.supabase.rpc.mock.invocationCallOrder[beginIndex]!);
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
          grantedChannelIds: [],
          expiresAt: '2026-08-29T00:00:00.000Z',
          entitlementType: 'subscription',
        }, TEST_ACTION_CLAIM);
        expect(result.entitlementId).toBe('ent-old');
        expect(eventBus.emitAndWait).toHaveBeenCalledWith(
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
      expect(eventBus.emitAndWait).toHaveBeenCalled();
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

    it('recovers a confirmed renewal crash before its first durable outward row exactly once', async () => {
      const supabase = makeOutwardIntentSupa(
        null,
        {
          entitlement: renewalEntitlement('active'),
          order: subscriptionOrderSnapshot,
        },
        'subscription_renewed_event',
      );
      const guild = makeGuild();
      const first = new CommerceFulfillmentService(guild, supabase, eventBus);
      const replay = new CommerceFulfillmentService(guild, supabase, eventBus);
      (mockBeginRoleDelivery as any)
        .mockResolvedValueOnce({
          state: 'live',
          attempt: {
            ...TEST_ACTION_CLAIM,
            intentId: '11111111-1111-4111-8111-111111111111',
            mutationToken: '22222222-2222-4222-8222-222222222222',
            outwardGenerationId: TEST_OUTWARD_GENERATION,
          },
        })
        .mockResolvedValueOnce({
          state: 'confirmed_live',
          intentId: '11111111-1111-4111-8111-111111111111',
          outwardGenerationId: TEST_OUTWARD_GENERATION,
        });

      const firstResult = await fulfillClaimed(first, renewalPayload);
      const replayResult = await fulfillClaimed(replay, renewalPayload);

      expect(firstResult.success).toBe(false);
      expect(replayResult).toMatchObject({
        success: true,
        eventEmitted: true,
        errors: [],
      });
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(1);
      expect(eventBus.emitAndWait).toHaveBeenCalledWith(
        'subscription.activated',
        'guild-1',
        expect.objectContaining({ status: 'renewed' }),
      );
      expect(supabase.__intents.get('order-1:subscription_renewed_event')?.state).toBe('sent');
    });

    it('keeps renewal backpressure pre-dispatch and retries one accepted event', async () => {
      const supabase = makeOutwardIntentSupa(null, {
        entitlement: renewalEntitlement('active'),
        order: subscriptionOrderSnapshot,
      });
      const guild = makeGuild();
      const first = new CommerceFulfillmentService(guild, supabase, eventBus);
      const replay = new CommerceFulfillmentService(guild, supabase, eventBus);
      eventBus.prepareEmitAndWait.mockImplementationOnce(() => {
        throw Object.assign(new Error('Backpressure: awaited listener capacity exhausted'), {
          name: 'EventBusDispatchNotStartedError',
          dispatchState: 'not_started',
          reason: 'backpressure',
        });
      });
      (mockBeginRoleDelivery as any)
        .mockResolvedValueOnce({
          state: 'live',
          attempt: {
            ...TEST_ACTION_CLAIM,
            intentId: '11111111-1111-4111-8111-111111111111',
            mutationToken: '22222222-2222-4222-8222-222222222222',
            outwardGenerationId: TEST_OUTWARD_GENERATION,
          },
        })
        .mockResolvedValueOnce({
          state: 'confirmed_live',
          intentId: '11111111-1111-4111-8111-111111111111',
          outwardGenerationId: TEST_OUTWARD_GENERATION,
        });

      const firstResult = await fulfillClaimed(first, renewalPayload);
      const outwardCallsAfterBackpressure = supabase.rpc.mock.calls.filter(
        ([name]: [string]) => name.includes('fulfillment_outward_intent'),
      );
      const replayResult = await fulfillClaimed(replay, renewalPayload);

      expect(firstResult.success).toBe(false);
      expect(outwardCallsAfterBackpressure).toEqual([]);
      expect(replayResult.success).toBe(true);
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(1);
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

    it.each(['pending', 'cancelled', 'expired'])(
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
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

      const result = await fulfillClaimed(service, subscriptionLifecyclePayload);

      expect(result.success).toBe(true);
      expect(result.entitlementId).toBe('ent-subscription');
      expect(mockRevoke).toHaveBeenCalledWith(
        'ent-subscription',
        'cancelled',
        expect.objectContaining({
          ...TEST_ACTION_CLAIM,
          orderId: 'order-1',
          expectedStatus: 'active',
        }),
      );
      expect(result.eventEmitted).toBe(true);
      expect(eventBus.emitAndWait).toHaveBeenCalledWith(
        'subscription.lapsed',
        'guild-1',
        expect.any(Object),
      );
    });

    it('treats a CAS no-op race as success without repeating event or DM', async () => {
      (mockRevoke as any).mockResolvedValueOnce({
        disposition: 'noop',
        transitionId: null,
        status: 'cancelled',
        outwardGenerationId: null,
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

    it('recovers a cancellation winner crash before its first outward row and drains event plus DM once', async () => {
      const supabase = makeOutwardIntentSupa(
        null,
        { entitlement: subscriptionLifecycleEntitlement('active') },
        'subscription_cancelled_event',
      );
      const guild = makeGuild();
      const send = vi.fn(async () => {});
      guild.client.users.fetch.mockResolvedValue({ id: 'user-1', send });
      const first = new CommerceFulfillmentService(guild, supabase, eventBus);
      const replay = new CommerceFulfillmentService(guild, supabase, eventBus);
      (mockRevoke as any)
        .mockResolvedValueOnce({
          disposition: 'applied',
          transitionId: '11111111-1111-4111-8111-111111111111',
          status: 'cancelled',
          outwardGenerationId: '44444444-4444-4444-8444-444444444444',
        })
        .mockResolvedValueOnce({
          disposition: 'noop',
          transitionId: null,
          status: 'cancelled',
          outwardGenerationId: '44444444-4444-4444-8444-444444444444',
        });

      const firstResult = await fulfillClaimed(first, subscriptionLifecyclePayload);
      supabase.__entitlement.status = 'cancelled';
      supabase.__entitlement.updated_at = '2026-07-27T00:00:01.000Z';
      const replayResult = await fulfillClaimed(replay, subscriptionLifecyclePayload);

      expect(firstResult.success).toBe(false);
      expect(replayResult.success).toBe(true);
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(supabase.__intents.get('order-1:subscription_cancelled_event')?.state).toBe('sent');
      expect(supabase.__intents.get('order-1:subscription_cancelled_dm')?.state).toBe('sent');
    });

    it('keeps cancellation event backpressure out of outward state and retries exactly once', async () => {
      const supabase = makeOutwardIntentSupa(null, {
        entitlement: subscriptionLifecycleEntitlement('active'),
      });
      const guild = makeGuild();
      const first = new CommerceFulfillmentService(guild, supabase, eventBus);
      const replay = new CommerceFulfillmentService(guild, supabase, eventBus);
      eventBus.prepareEmitAndWait.mockImplementationOnce(() => {
        throw Object.assign(new Error('Backpressure: awaited listener capacity exhausted'), {
          name: 'EventBusDispatchNotStartedError',
          dispatchState: 'not_started',
          reason: 'backpressure',
        });
      });
      (mockRevoke as any)
        .mockResolvedValueOnce({
          disposition: 'applied',
          transitionId: '11111111-1111-4111-8111-111111111111',
          status: 'cancelled',
          outwardGenerationId: '44444444-4444-4444-8444-444444444444',
        })
        .mockResolvedValueOnce({
          disposition: 'noop',
          transitionId: null,
          status: 'cancelled',
          outwardGenerationId: '44444444-4444-4444-8444-444444444444',
        });

      const firstResult = await fulfillClaimed(first, subscriptionLifecyclePayload);
      const outwardCallsAfterBackpressure = supabase.rpc.mock.calls.filter(
        ([name]: [string]) => name.includes('fulfillment_outward_intent'),
      );
      supabase.__entitlement.status = 'cancelled';
      supabase.__entitlement.updated_at = '2026-07-27T00:00:01.000Z';
      const replayResult = await fulfillClaimed(replay, subscriptionLifecyclePayload);

      expect(firstResult.success).toBe(false);
      expect(outwardCallsAfterBackpressure).toEqual([]);
      expect(replayResult.success).toBe(true);
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(1);
    });

    it('gives only the winning cancellation CAS a generation under racing actions', async () => {
      const supabase = makeOutwardIntentSupa(null, {
        entitlement: subscriptionLifecycleEntitlement('active'),
      });
      const guild = makeGuild();
      const send = vi.fn(async () => {});
      guild.client.users.fetch.mockResolvedValue({ id: 'user-1', send });
      const winner = new CommerceFulfillmentService(guild, supabase, eventBus);
      const loser = new CommerceFulfillmentService(guild, supabase, eventBus);
      (mockRevoke as any)
        .mockResolvedValueOnce({
          disposition: 'applied',
          transitionId: '11111111-1111-4111-8111-111111111111',
          status: 'cancelled',
          outwardGenerationId: '44444444-4444-4444-8444-444444444444',
        })
        .mockResolvedValueOnce({
          disposition: 'noop',
          transitionId: null,
          status: 'cancelled',
          outwardGenerationId: null,
        });

      const winnerResult = await winner.fulfill(
        subscriptionLifecyclePayload,
        TEST_ACTION_CLAIM,
      );
      supabase.__entitlement.status = 'cancelled';
      supabase.__entitlement.updated_at = '2026-07-27T00:00:01.000Z';
      const loserResult = await loser.fulfill(
        subscriptionLifecyclePayload,
        {
          actionId: '55555555-5555-4555-8555-555555555555',
          claimToken: '66666666-6666-4666-8666-666666666666',
        },
      );

      expect(winnerResult.success).toBe(true);
      expect(loserResult.success).toBe(true);
      expect(loserResult.eventEmitted).toBe(false);
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
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

    it.each(['cancelled', 'expired'])(
      'treats exact terminal status %s as an idempotent replay',
      async (status) => {
        (mockRevoke as any).mockResolvedValueOnce({
          disposition: 'noop',
          transitionId: null,
          status: status === 'cancelled' ? 'cancelled' : 'expired',
          outwardGenerationId: null,
        });
        const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement(status) });
        const guild = makeGuild();
        service = new CommerceFulfillmentService(guild, supa as any, eventBus);

        const result = await fulfillClaimed(service, subscriptionLifecyclePayload);

        expect(result.success).toBe(true);
        expect(mockRevoke).toHaveBeenCalledOnce();
        expect(eventBus.emit).not.toHaveBeenCalled();
        expect(guild.client.users.fetch).not.toHaveBeenCalled();
      },
    );
  });

  describe('subscription_suspended', () => {
    it('atomically suspends access without emitting payment-failure grace effects', async () => {
      const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement('active') });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supa as any, eventBus);
      const payload = {
        ...subscriptionLifecyclePayload,
        fulfillment_type: 'subscription_suspended',
      };

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(true);
      expect(mockRevoke).toHaveBeenCalledWith(
        'ent-subscription',
        'suspended',
        expect.objectContaining({
          ...TEST_ACTION_CLAIM,
          orderId: 'order-1',
          expectedStatus: 'active',
        }),
      );
      expect(mockSuspend).not.toHaveBeenCalled();
      expect(eventBus.emitAndWait).toHaveBeenCalledOnce();
      expect(eventBus.emitAndWait).toHaveBeenCalledWith(
        'subscription.lapsed',
        'guild-1',
        expect.objectContaining({ status: 'lapsed' }),
      );
      expect(eventBus.emitAndWait).not.toHaveBeenCalledWith(
        'payment.failed',
        expect.anything(),
        expect.anything(),
      );
      expect(guild.client.users.fetch).toHaveBeenCalledWith('user-1');
    });

    it('does not manufacture new outward effects for an already-suspended replay', async () => {
      (mockRevoke as any).mockResolvedValueOnce({
        disposition: 'noop',
        transitionId: null,
        status: 'suspended',
        outwardGenerationId: null,
      });
      const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement('suspended') });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supa as any, eventBus);

      const result = await fulfillClaimed(service, {
        ...subscriptionLifecyclePayload,
        fulfillment_type: 'subscription_suspended',
      });

      expect(result.success).toBe(true);
      expect(eventBus.emitAndWait).not.toHaveBeenCalled();
      expect(guild.client.users.fetch).not.toHaveBeenCalled();
    });
  });

  describe('subscription_payment_failed', () => {
    it('starts grace for the exact active subscription entitlement', async () => {
      const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement('active') });
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

      const payload = { ...subscriptionLifecyclePayload, fulfillment_type: 'subscription_payment_failed' };
      const result = await fulfillClaimed(service, payload);
      expect(result.success).toBe(true);
      expect(mockSuspend).toHaveBeenCalledWith(
        'ent-subscription',
        3,
        expect.objectContaining({
          ...TEST_ACTION_CLAIM,
          orderId: 'order-1',
          expectedStatus: 'active',
        }),
      );
      expect(result.eventEmitted).toBe(true);
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(2);
    });

    it("uses the guild's configured grace window from getGracePeriodDays (single source of truth)", async () => {
      // Codex round-2 finding #1: the bot's suspend path must read the
      // configured window via the shared helper, not a hardcoded value —
      // the same source of truth the dashboard's manual PUT uses. Return a
      // distinctive 9 so a hardcoded default (3) would fail this assertion.
      (getGracePeriodDays as ReturnType<typeof vi.fn>).mockResolvedValueOnce(9);
      const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement('active') });
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

      const payload = { ...subscriptionLifecyclePayload, fulfillment_type: 'subscription_payment_failed' };
      await fulfillClaimed(service, payload);

      expect(getGracePeriodDays).toHaveBeenCalledWith(supa, payload.guild_id);
      expect(mockSuspend).toHaveBeenCalledWith(
        'ent-subscription',
        9,
        expect.objectContaining({ orderId: 'order-1' }),
      );
    });

    it('accepts a configured zero-day grace window as immediate expiry', async () => {
      (getGracePeriodDays as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);
      const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement('active') });
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);
      const payload = {
        ...subscriptionLifecyclePayload,
        fulfillment_type: 'subscription_payment_failed',
      };

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(true);
      expect(mockSuspend).toHaveBeenCalledWith(
        'ent-subscription',
        0,
        expect.objectContaining({ orderId: 'order-1' }),
      );
    });

    it('fails without notifications when the exact entitlement lookup errors', async () => {
      const supa = makeEntitlementLookupResult({
        data: null,
        error: { message: 'database unavailable' },
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supa as any, eventBus);
      const payload = { ...subscriptionLifecyclePayload, fulfillment_type: 'subscription_payment_failed' };

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('database unavailable');
      expect(mockSuspend).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(guild.client.users.fetch).not.toHaveBeenCalled();
    });

    it('treats an exact grace-period row as a replay without extending or notifying again', async () => {
      (mockSuspend as any).mockResolvedValueOnce({
        disposition: 'replay',
        outwardGenerationId: null,
      });
      const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement('grace_period') });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supa as any, eventBus);
      const payload = { ...subscriptionLifecyclePayload, fulfillment_type: 'subscription_payment_failed' };

      const result = await fulfillClaimed(service, payload);

      expect(result.success).toBe(true);
      expect(mockSuspend).toHaveBeenCalledOnce();
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(guild.client.users.fetch).not.toHaveBeenCalled();
    });

    it('recovers a payment-failure winner crash before its first outward row and drains all effects once', async () => {
      const payload = {
        ...subscriptionLifecyclePayload,
        fulfillment_type: 'subscription_payment_failed',
      };
      const supabase = makeOutwardIntentSupa(
        null,
        { entitlement: subscriptionLifecycleEntitlement('active') },
        'subscription_payment_failed_lapsed_event',
      );
      const guild = makeGuild();
      const send = vi.fn(async () => {});
      guild.client.users.fetch.mockResolvedValue({ id: 'user-1', send });
      const first = new CommerceFulfillmentService(guild, supabase, eventBus);
      const replay = new CommerceFulfillmentService(guild, supabase, eventBus);
      (mockSuspend as any)
        .mockResolvedValueOnce({
          disposition: 'applied',
          outwardGenerationId: '44444444-4444-4444-8444-444444444444',
        })
        .mockResolvedValueOnce({
          disposition: 'replay',
          outwardGenerationId: '44444444-4444-4444-8444-444444444444',
        });

      const firstResult = await fulfillClaimed(first, payload);
      supabase.__entitlement.status = 'grace_period';
      supabase.__entitlement.updated_at = '2026-07-27T00:00:01.000Z';
      const replayResult = await fulfillClaimed(replay, payload);

      expect(firstResult.success).toBe(false);
      expect(replayResult.success).toBe(true);
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(2);
      expect(eventBus.emitAndWait).toHaveBeenCalledWith(
        'subscription.lapsed',
        'guild-1',
        expect.objectContaining({ status: 'lapsed' }),
      );
      expect(eventBus.emitAndWait).toHaveBeenCalledWith(
        'payment.failed',
        'guild-1',
        expect.any(Object),
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(supabase.__intents.get('order-1:subscription_payment_failed_lapsed_event')?.state)
        .toBe('sent');
      expect(supabase.__intents.get(
        'order-1:subscription_payment_failed_event',
      )?.state).toBe('sent');
      expect(supabase.__intents.get('order-1:subscription_payment_failed_dm')?.state).toBe('sent');
    });

    it('uses the committed grace deadline when config changes before same-action replay', async () => {
      const payload = {
        ...subscriptionLifecyclePayload,
        fulfillment_type: 'subscription_payment_failed',
      };
      const supabase = makeOutwardIntentSupa(
        null,
        { entitlement: subscriptionLifecycleEntitlement('active') },
        'subscription_payment_failed_lapsed_event',
      );
      const guild = makeGuild();
      const send = vi.fn(async () => {});
      guild.client.users.fetch.mockResolvedValue({ id: 'user-1', send });
      const first = new CommerceFulfillmentService(guild, supabase, eventBus);
      const replay = new CommerceFulfillmentService(guild, supabase, eventBus);
      const committedDeadline = '2026-08-01T12:34:56.000Z';
      (getGracePeriodDays as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(9);
      (mockSuspend as any)
        .mockResolvedValueOnce({
          disposition: 'applied',
          outwardGenerationId: '44444444-4444-4444-8444-444444444444',
          gracePeriodEndsAt: committedDeadline,
        })
        .mockResolvedValueOnce({
          disposition: 'replay',
          outwardGenerationId: '44444444-4444-4444-8444-444444444444',
          gracePeriodEndsAt: committedDeadline,
        });

      const firstResult = await fulfillClaimed(first, payload);
      supabase.__entitlement.status = 'grace_period';
      supabase.__entitlement.updated_at = '2026-07-27T00:00:01.000Z';
      const replayResult = await fulfillClaimed(replay, payload);

      expect(firstResult.success).toBe(false);
      expect(replayResult.success).toBe(true);
      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining(
          `<t:${Math.floor(Date.parse(committedDeadline) / 1_000)}:F>`,
        ),
      }));
      const sentPayload = (send.mock.calls as unknown[][])[0]?.[0] as
        | { content?: unknown }
        | undefined;
      expect(String(sentPayload?.content)).not.toContain('9-day');
    });

    it.each([
      ['subscription_payment_failed_lapsed_event', 1],
      ['subscription_payment_failed_event', 2],
    ] as const)(
      'keeps %s backpressure pre-dispatch and delivers each payment-failure event once',
      async (blockedKind, blockedPreparation) => {
        const payload = {
          ...subscriptionLifecyclePayload,
          fulfillment_type: 'subscription_payment_failed',
        };
        const supabase = makeOutwardIntentSupa(null, {
          entitlement: subscriptionLifecycleEntitlement('active'),
        });
        const guild = makeGuild();
        const first = new CommerceFulfillmentService(guild, supabase, eventBus);
        const replay = new CommerceFulfillmentService(guild, supabase, eventBus);
        const prepare = eventBus.prepareEmitAndWait.getMockImplementation();
        let preparationCount = 0;
        eventBus.prepareEmitAndWait.mockImplementation((...args: any[]) => {
          preparationCount += 1;
          if (preparationCount === blockedPreparation) {
            throw Object.assign(new Error('Backpressure: awaited listener capacity exhausted'), {
              name: 'EventBusDispatchNotStartedError',
              dispatchState: 'not_started',
              reason: 'backpressure',
            });
          }
          return prepare!(...args);
        });
        (mockSuspend as any)
          .mockResolvedValueOnce({
            disposition: 'applied',
            outwardGenerationId: '44444444-4444-4444-8444-444444444444',
          })
          .mockResolvedValueOnce({
            disposition: 'replay',
            outwardGenerationId: '44444444-4444-4444-8444-444444444444',
          });

        const firstResult = await fulfillClaimed(first, payload);
        const blockedState =
          supabase.__intents.get(`order-1:${blockedKind}`);
        supabase.__entitlement.status = 'grace_period';
        supabase.__entitlement.updated_at = '2026-07-27T00:00:01.000Z';
        const replayResult = await fulfillClaimed(replay, payload);

        expect(firstResult.success).toBe(false);
        expect(blockedState).toBeUndefined();
        expect(replayResult.success).toBe(true);
        expect(eventBus.emitAndWait).toHaveBeenCalledTimes(2);
      },
    );

    it('gives only the winning payment-failure CAS a generation under racing actions', async () => {
      const payload = {
        ...subscriptionLifecyclePayload,
        fulfillment_type: 'subscription_payment_failed',
      };
      const supabase = makeOutwardIntentSupa(null, {
        entitlement: subscriptionLifecycleEntitlement('active'),
      });
      const guild = makeGuild();
      const send = vi.fn(async () => {});
      guild.client.users.fetch.mockResolvedValue({ id: 'user-1', send });
      const winner = new CommerceFulfillmentService(guild, supabase, eventBus);
      const loser = new CommerceFulfillmentService(guild, supabase, eventBus);
      (mockSuspend as any)
        .mockResolvedValueOnce({
          disposition: 'applied',
          outwardGenerationId: '44444444-4444-4444-8444-444444444444',
        })
        .mockResolvedValueOnce({
          disposition: 'noop',
          outwardGenerationId: null,
        });

      const winnerResult = await winner.fulfill(
        withSubscriptionLifecycle(payload),
        TEST_ACTION_CLAIM,
      );
      supabase.__entitlement.status = 'grace_period';
      supabase.__entitlement.updated_at = '2026-07-27T00:00:01.000Z';
      const loserResult = await loser.fulfill(withSubscriptionLifecycle(payload), {
        actionId: '55555555-5555-4555-8555-555555555555',
        claimToken: '66666666-6666-4666-8666-666666666666',
      });

      expect(winnerResult.success).toBe(true);
      expect(loserResult.success).toBe(true);
      expect(loserResult.eventEmitted).toBe(false);
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('uses distinct generations for repeated payment-failure episodes on one subscription order', async () => {
      const payload = {
        ...subscriptionLifecyclePayload,
        fulfillment_type: 'subscription_payment_failed',
      };
      const supabase = makeOutwardIntentSupa(null, {
        entitlement: subscriptionLifecycleEntitlement('active'),
      });
      const guild = makeGuild();
      const firstEpisode = new CommerceFulfillmentService(guild, supabase, eventBus);
      const secondEpisode = new CommerceFulfillmentService(guild, supabase, eventBus);
      (mockSuspend as any)
        .mockResolvedValueOnce({
          disposition: 'applied',
          outwardGenerationId: '44444444-4444-4444-8444-444444444444',
        })
        .mockResolvedValueOnce({
          disposition: 'applied',
          outwardGenerationId: '77777777-7777-4777-8777-777777777777',
        });

      const firstResult = await firstEpisode.fulfill(
        withSubscriptionLifecycle(payload),
        TEST_ACTION_CLAIM,
      );
      const secondResult = await secondEpisode.fulfill(withSubscriptionLifecycle(payload), {
        actionId: '55555555-5555-4555-8555-555555555555',
        claimToken: '66666666-6666-4666-8666-666666666666',
      });

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(eventBus.emitAndWait).toHaveBeenCalledTimes(4);
      const lapsedRows = [...supabase.__intents.entries()].filter(
        ([key]: [string]) => key.includes('subscription_payment_failed_lapsed_event'),
      );
      expect(lapsedRows).toHaveLength(2);
      expect(new Set(lapsedRows.map(([, row]: [string, any]) =>
        row.outwardGenerationId))).toEqual(new Set([
        '44444444-4444-4444-8444-444444444444',
        '77777777-7777-4777-8777-777777777777',
      ]));
    });

    it.each(['cancelled', 'expired'])(
      'safely ignores a late payment failure for terminal status %s',
      async (status) => {
        const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement(status) });
        const guild = makeGuild();
        service = new CommerceFulfillmentService(guild, supa as any, eventBus);
        const payload = { ...subscriptionLifecyclePayload, fulfillment_type: 'subscription_payment_failed' };

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
    // A failed receipt/license-key DM has ambiguous external acceptance. Its
    // outward intent becomes uncertain, so automatic replay is blocked. The
    // plaintext payload is preserved in the DLQ for deliberate operator
    // reconciliation and the alert never contains the key.

    /**
     * `dlqInsertError` makes action_queue_dlq inserts fail too (the
     * worst-case path where the key cannot be preserved anywhere).
     */
    function makeRecordingSupa(
      opts: {
        dlqInsertError?: { message: string };
      } = {},
    ) {
      const inserts: Record<string, any[]> = {};
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
        rpc: vi.fn(async (name: string, args: Record<string, unknown>) =>
          name === 'commerce_claim_paid_fulfillment'
            ? paidClaimWinner(args)
            : defaultOutwardIntentRpc(name, args)),
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

    it('leaves an uncertain receipt to the single atomic action-finalizer hold', async () => {
      mockPreparedReceiptSend.mockRejectedValueOnce(
        Object.assign(new Error('Cannot send messages to this user'), { code: 50007 }),
      );
      const supa = makeRecordingSupa();
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

      const result = await fulfillClaimed(service, keyedPayload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('Cannot send messages');
      expect(result.receiptSent).toBe(false);
      expect(result.receiptRetryQueued).toBe(false);
      expect(supa.__inserts['bot_action_queue']).toBeUndefined();
      expect(supa.__inserts['action_queue_dlq']).toBeUndefined();
      expect(supa.__inserts['alerts']).toBeUndefined();
    });
  });
});
