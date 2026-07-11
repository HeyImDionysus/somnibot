/**
 * Tests for services/commerce-fulfillment.ts — the post-payment
 * fulfillment pipeline handling purchases, subscriptions, cancellations,
 * and suspensions. 185 uncovered statements.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
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
  mockEnsureGrantedRoles,
} = vi.hoisted(() => ({
  mockGrant: vi.fn(async () => 'ent-123'),
  mockRevoke: vi.fn(async () => true),
  mockSuspend: vi.fn(async () => true),
  mockReactivate: vi.fn(async () => true),
  mockEnsureGrantedRoles: vi.fn(async () => undefined),
}));

vi.mock('../features/commerce/entitlement-service.js', () => ({
  EntitlementService: class {
    grant = mockGrant;
    revoke = mockRevoke;
    suspend = mockSuspend;
    reactivate = mockReactivate;
    ensureGrantedRoles = mockEnsureGrantedRoles;
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
                guild_id: 'guild-1',
                customer_id: 'cust-1',
                product_id: 'prod-1',
                plan_id: null,
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
  prepareData?: (roleId: string) => unknown;
  fetchError?: Error;
  addError?: Error;
  removalIntentResults?: Array<{ data: unknown; error: unknown }>;
  acknowledgementResults?: Array<{ data: unknown; error: unknown }>;
  reuseEntitlementOnRetry?: boolean;
  liveTemporaryOwners?: unknown[];
  liveEntitlementOwners?: unknown[];
  orderPlanId?: string | null;
  orderGrantedRoleIds?: string[];
  orderTemporaryRoleGrants?: Array<{ role_id: string; duration_seconds: number }>;
} = {}) {
  const heldRoleIds = new Set(opts.initialRoleIds ?? []);
  const operations: string[] = [];
  const tempUpdates: Array<Record<string, unknown>> = [];
  let acknowledgementCall = 0;
  let removalIntentCall = 0;
  let entitlementLookup = 0;

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
      remove: vi.fn(),
    },
  };
  const guild = makeGuild();
  guild.members.fetch = vi.fn(async () => {
    if (opts.fetchError) throw opts.fetchError;
    return member;
  });

  const supabase: any = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      const roleId = String(args.p_role_id ?? '');
      operations.push(`prepare-committed:${roleId}`);
      if (opts.prepareError) return { data: null, error: opts.prepareError };
      return {
        data: opts.prepareData?.(roleId) ?? {
          id: `grant-${roleId}`,
          grant_status: 'pending',
          expires_at: '2999-01-01T00:00:00.000Z',
        },
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
        chain.limit = vi.fn(async () => ({
          data: opts.liveEntitlementOwners ?? [],
          error: null,
        }));
        return chain;
      }
      if (table === 'customers') {
        return makeChain({
          data: { id: 'cust-1', guild_id: 'guild-1', discord_id: 'user-1' },
          error: null,
        });
      }
      if (table === 'orders') {
        return makeChain({
          data: {
            id: 'order-1',
            guild_id: 'guild-1',
            customer_id: 'cust-1',
            product_id: 'prod-1',
            plan_id: opts.orderPlanId ?? null,
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
          },
          error: null,
        });
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
      chain.order = vi.fn(() => chain);
      chain.limit = vi.fn(async () => ({
        data: opts.liveTemporaryOwners ?? [],
        error: null,
      }));
      chain.maybeSingle = vi.fn(async () => {
        if (updatePayload.remove_on_expiry === true) {
          operations.push(`removal-intent-ack:${targetId}`);
          const configured = opts.removalIntentResults?.[removalIntentCall++];
          return configured ?? {
            data: { id: targetId, remove_on_expiry: true },
            error: null,
          };
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
    heldRoleIds,
  };
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
  guild_id: 'guild-1',
  customer_id: 'cust-1',
  product_id: 'prod-1',
  plan_id: 'plan-monthly',
  amount_cents: 999,
  currency: 'USD',
  source: 'purchase',
  status: 'completed',
  granted_role_ids_snapshot: ['role-1'],
  granted_channel_ids_snapshot: [],
  temporary_role_grants_snapshot: [],
  grant_snapshot_frozen_at: '2026-07-11T00:00:00.000Z',
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

    const result = await service.fulfill({ ...basePayload, guild_id: 'different-guild' });

    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('guild/identity');
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(guild.members.fetch).not.toHaveBeenCalled();
    expect(guild.client.users.fetch).not.toHaveBeenCalled();
  });

  describe('one_time_purchase', () => {
    it('grants entitlement, emits event, sends receipt', async () => {
      const result = await service.fulfill(basePayload);
      expect(result.success).toBe(true);
      expect(result.entitlementId).toBe('ent-123');
      expect(result.eventEmitted).toBe(true);
      expect(result.receiptSent).toBe(true);
      expect(mockGrant).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        productId: 'prod-1',
        type: 'one_time',
      }));
    });

    it('reports error when entitlement grant fails', async () => {
      mockGrant.mockResolvedValueOnce(null as any);
      const result = await service.fulfill(basePayload);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Failed to create entitlement');
    });

    it.each([
      { label: 'wrong product', orderPatch: { product_id: 'different-product' } },
      { label: 'uncommitted status', orderPatch: { status: 'pending' } },
      { label: 'tampered role snapshot', orderPatch: { granted_role_ids_snapshot: ['role-attacker'] } },
    ])('rejects an order with $label before entitlement or Discord mutation', async ({ orderPatch }) => {
      const supabase = makeSupa({
        orders: {
          id: 'order-1',
          guild_id: 'guild-1',
          customer_id: 'cust-1',
          product_id: 'prod-1',
          plan_id: null,
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

      const result = await service.fulfill(basePayload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('frozen snapshot');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockEnsureGrantedRoles).not.toHaveBeenCalled();
      expect(supabase.rpc).not.toHaveBeenCalled();
      expect(guild.members.fetch).not.toHaveBeenCalled();
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

      const result = await service.fulfill(basePayload);

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

      const result = await service.fulfill(basePayload);

      expect(result.success).toBe(true);
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockEnsureGrantedRoles).toHaveBeenCalledWith('user-1', ['role-1']);
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
      mockEnsureGrantedRoles.mockRejectedValueOnce(new Error('Discord did not confirm role'));
      service = new CommerceFulfillmentService(makeGuild(), supabase as any, eventBus);

      const result = await service.fulfill(basePayload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('Discord did not confirm role');
      expect(result.eventEmitted).not.toBe(true);
      expect(mockDeliverReceiptDM).not.toHaveBeenCalled();
    });

    it('rejects a customer/Discord mismatch before permanent or temporary mutation', async () => {
      const supabase = makeSupa({
        customers: { id: 'cust-1', guild_id: 'guild-1', discord_id: 'different-user' },
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supabase as any, eventBus);

      const result = await service.fulfill({
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('customer identity');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockEnsureGrantedRoles).not.toHaveBeenCalled();
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

      const result = await service.fulfill({
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

      const result = await service.fulfill({
        ...basePayload,
        temporary_role_grants: [grant],
      });

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('Malformed temporary role grant snapshot');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(harness.supabase.rpc).not.toHaveBeenCalled();
      expect(harness.guild.members.fetch).not.toHaveBeenCalled();
    });

    it('commits temporary-role provenance before adding the Discord role, then acknowledges it', async () => {
      const harness = makeTemporaryRoleHarness({
        orderTemporaryRoleGrants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 3_600 }],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);
      const payload: FulfillmentPayload = {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 3_600 }],
      };

      const result = await service.fulfill(payload);

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
        `removal-intent-ack:grant-${TEMP_ROLE_ID}`,
        `discord-add:${TEMP_ROLE_ID}`,
        `provenance-ack:grant-${TEMP_ROLE_ID}`,
      ]);
      expect(harness.tempUpdates).toContainEqual(expect.objectContaining({
        remove_on_expiry: true,
        updated_at: expect.any(String),
      }));
      expect(harness.tempUpdates).toContainEqual(expect.objectContaining({
        grant_status: 'applied',
        applied_at: expect.any(String),
        last_error: null,
        updated_at: expect.any(String),
      }));
    });

    it('does not mark or later remove a temporary role the member already held', async () => {
      const harness = makeTemporaryRoleHarness({ initialRoleIds: [TEMP_ROLE_ID] });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await service.fulfill({
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.tempUpdates).not.toContainEqual(expect.objectContaining({
        remove_on_expiry: true,
      }));
      expect(harness.tempUpdates).toContainEqual(expect.objectContaining({
        grant_status: 'applied',
      }));
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
        }],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await service.fulfill({
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.tempUpdates).toContainEqual(expect.objectContaining({
        remove_on_expiry: true,
      }));
      expect(harness.tempUpdates).toContainEqual(expect.objectContaining({
        grant_status: 'applied',
      }));
    });

    it('persists removal ownership when the permanent and temporary snapshots overlap', async () => {
      const harness = makeTemporaryRoleHarness({
        initialRoleIds: [TEMP_ROLE_ID],
        orderGrantedRoleIds: [TEMP_ROLE_ID],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await service.fulfill({
        ...basePayload,
        granted_role_ids: [TEMP_ROLE_ID],
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.tempUpdates).toContainEqual(expect.objectContaining({
        remove_on_expiry: true,
      }));
    });

    it('does not add the Discord role when durable removal intent cannot be acknowledged', async () => {
      const harness = makeTemporaryRoleHarness({
        removalIntentResults: [
          { data: null, error: { message: 'intent write failed' } },
        ],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await service.fulfill({
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(false);
      expect(harness.operations).toContain(`removal-intent-ack:grant-${TEMP_ROLE_ID}`);
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

      const result = await service.fulfill({
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(false);
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.tempUpdates).toEqual([]);
      expect(eventBus.emit).not.toHaveBeenCalledWith('purchase.completed', expect.anything(), expect.anything());
    });

    it('does not deliver a pending temporary role after its first durable expiry has passed', async () => {
      const harness = makeTemporaryRoleHarness({
        prepareData: (roleId) => ({
          id: `grant-${roleId}`,
          grant_status: 'pending',
          expires_at: '2000-01-01T00:00:00.000Z',
        }),
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await service.fulfill({
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('expired before Discord delivery');
      expect(harness.guild.members.fetch).not.toHaveBeenCalled();
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.tempUpdates).toEqual([]);
    });

    it('treats an applied provenance row as the retry completion marker', async () => {
      const harness = makeTemporaryRoleHarness({
        prepareData: (roleId) => ({
          id: `grant-${roleId}`,
          grant_status: 'applied',
          expires_at: '2000-01-01T00:00:00.000Z',
        }),
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await service.fulfill({
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.guild.members.fetch).not.toHaveBeenCalled();
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.tempUpdates).toEqual([]);
    });

    it('repairs and confirms an unexpired applied role on queue replay', async () => {
      const harness = makeTemporaryRoleHarness({
        prepareData: (roleId) => ({
          id: `grant-${roleId}`,
          grant_status: 'applied',
          expires_at: '2999-01-01T00:00:00.000Z',
        }),
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await service.fulfill({
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(true);
      expect(harness.member.roles.add).toHaveBeenCalledWith(
        TEMP_ROLE_ID,
        expect.stringContaining('temporary commerce role'),
      );
      expect(harness.tempUpdates).toContainEqual(expect.objectContaining({
        remove_on_expiry: true,
      }));
      expect(harness.tempUpdates).not.toContainEqual(expect.objectContaining({
        grant_status: 'applied',
      }));
    });

    it('records Discord failure on the pending provenance row and leaves it retryable', async () => {
      const harness = makeTemporaryRoleHarness({ addError: new Error('Missing permissions') });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await service.fulfill({
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      });

      expect(result.success).toBe(false);
      expect(harness.member.roles.add).toHaveBeenCalledTimes(1);
      expect(harness.tempUpdates).toContainEqual(expect.objectContaining({
        last_error: 'Missing permissions',
        updated_at: expect.any(String),
      }));
      expect(harness.tempUpdates).not.toContainEqual(expect.objectContaining({
        grant_status: 'applied',
      }));
    });

    it('retries a failed DB acknowledgement without adding the Discord role twice', async () => {
      const harness = makeTemporaryRoleHarness({
        reuseEntitlementOnRetry: true,
        acknowledgementResults: [
          { data: null, error: { message: 'ack write failed' } },
          { data: { id: `grant-${TEMP_ROLE_ID}` }, error: null },
        ],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);
      const payload: FulfillmentPayload = {
        ...basePayload,
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      };

      const first = await service.fulfill(payload);
      const retry = await service.fulfill(payload);

      expect(first.success).toBe(false);
      expect(retry.success).toBe(true);
      expect(harness.supabase.rpc).toHaveBeenCalledTimes(2);
      expect(mockGrant).toHaveBeenCalledTimes(1);
      expect(harness.member.roles.add).toHaveBeenCalledTimes(1);
      expect(harness.heldRoleIds.has(TEMP_ROLE_ID)).toBe(true);
      expect(harness.tempUpdates.filter((row) => row.grant_status === 'applied')).toHaveLength(2);
    });

    it('deduplicates and deterministically orders duplicate temporary-role payload rows', async () => {
      const harness = makeTemporaryRoleHarness({
        orderTemporaryRoleGrants: [
          { role_id: TEMP_ROLE_A, duration_seconds: 120 },
          { role_id: TEMP_ROLE_Z, duration_seconds: 60 },
        ],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);

      const result = await service.fulfill({
        ...basePayload,
        temporary_role_grants: [
          { role_id: TEMP_ROLE_Z, duration_seconds: 60 },
          { role_id: TEMP_ROLE_A, duration_seconds: 60 },
          { role_id: TEMP_ROLE_A, duration_seconds: 120 },
        ],
      });

      expect(result.success).toBe(true);
      expect(harness.supabase.rpc.mock.calls.map((call: any[]) => [
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
      const payload = { ...basePayload, fulfillment_type: 'subscription_activated', plan_id: 'plan-monthly', entitlement_type: 'subscription' as const };
      service = new CommerceFulfillmentService(
        makeGuild(),
        makeSupa({ orders: subscriptionOrderSnapshot }) as any,
        eventBus,
      );
      const result = await service.fulfill(payload);
      expect(result.success).toBe(true);
      expect(result.entitlementId).toBe('ent-123');
      expect(eventBus.emit).toHaveBeenCalledWith('subscription.activated', 'guild-1', expect.objectContaining({ status: 'activated' }));
    });

    it('reports error when subscription grant fails', async () => {
      mockGrant.mockResolvedValueOnce(null as any);
      const payload = {
        ...basePayload,
        fulfillment_type: 'subscription_activated',
        plan_id: 'plan-monthly',
        entitlement_type: 'subscription' as const,
      };
      service = new CommerceFulfillmentService(
        makeGuild(),
        makeSupa({ orders: subscriptionOrderSnapshot }) as any,
        eventBus,
      );
      const result = await service.fulfill(payload);
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('subscription entitlement');
    });

    it('reuses and re-confirms the exact subscription entitlement after a worker replay', async () => {
      const payload: FulfillmentPayload = {
        ...basePayload,
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

      const result = await service.fulfill(payload);

      expect(result.success).toBe(true);
      expect(result.entitlementId).toBe('ent-sub');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockEnsureGrantedRoles).toHaveBeenCalledWith('user-1', ['role-1']);
    });

    it('rejects a subscription customer/Discord mismatch before grant or repair', async () => {
      const payload: FulfillmentPayload = {
        ...basePayload,
        fulfillment_type: 'subscription_activated',
        plan_id: 'plan-monthly',
        entitlement_type: 'subscription',
      };
      const supabase = makeSupa({
        customers: { id: 'cust-1', guild_id: 'guild-1', discord_id: 'different-user' },
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supabase as any, eventBus);

      const result = await service.fulfill(payload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('customer identity');
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockEnsureGrantedRoles).not.toHaveBeenCalled();
      expect(guild.members.fetch).not.toHaveBeenCalled();
    });

    it('rejects a temporary-role payload absent from the frozen subscription order', async () => {
      const harness = makeTemporaryRoleHarness({
        orderPlanId: 'plan-monthly',
        orderTemporaryRoleGrants: [],
      });
      service = new CommerceFulfillmentService(harness.guild, harness.supabase, eventBus);
      const payload: FulfillmentPayload = {
        ...basePayload,
        fulfillment_type: 'subscription_activated',
        plan_id: 'plan-monthly',
        entitlement_type: 'subscription',
        temporary_role_grants: [{ role_id: TEMP_ROLE_ID, duration_seconds: 60 }],
      };

      const result = await service.fulfill(payload);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('frozen snapshot');
      expect(harness.supabase.rpc).not.toHaveBeenCalled();
      expect(harness.member.roles.add).not.toHaveBeenCalled();
    });
  });

  describe('subscription_renewed', () => {
    it('reactivates existing entitlement', async () => {
      const payload = { ...basePayload, fulfillment_type: 'subscription_renewed', existing_entitlement_id: 'ent-old' };
      const result = await service.fulfill(payload);
      expect(result.success).toBe(true);
      expect(mockReactivate).toHaveBeenCalledWith('ent-old');
      expect(result.entitlementId).toBe('ent-old');
    });

    it('reports error when reactivation fails', async () => {
      mockReactivate.mockResolvedValueOnce(false);
      const payload = { ...basePayload, fulfillment_type: 'subscription_renewed', existing_entitlement_id: 'ent-old' };
      const result = await service.fulfill(payload);
      expect(result.errors).toContain('Failed to reactivate entitlement');
    });
  });

  describe('subscription_cancelled', () => {
    it('revokes the exact live subscription entitlement and sends DM', async () => {
      const supa = makeSupa({ entitlements: subscriptionLifecycleEntitlement('active') });
      eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

      const result = await service.fulfill(subscriptionLifecyclePayload);

      expect(result.success).toBe(true);
      expect(result.entitlementId).toBe('ent-subscription');
      expect(mockRevoke).toHaveBeenCalledWith('ent-subscription', 'cancelled');
      expect(result.eventEmitted).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledWith('subscription.lapsed', 'guild-1', expect.any(Object));
    });

    it('fails without notifications when the exact entitlement lookup errors', async () => {
      const supa = makeEntitlementLookupResult({
        data: null,
        error: { message: 'database unavailable' },
      });
      const guild = makeGuild();
      service = new CommerceFulfillmentService(guild, supa as any, eventBus);

      const result = await service.fulfill(subscriptionLifecyclePayload);

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

      const result = await service.fulfill(subscriptionLifecyclePayload);

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

        const result = await service.fulfill(subscriptionLifecyclePayload);

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
      const result = await service.fulfill(payload);
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
      await service.fulfill(payload);

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

      const result = await service.fulfill(payload);

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

      const result = await service.fulfill(payload);

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

        const result = await service.fulfill(payload);

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
      const result = await service.fulfill(payload);
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('Unknown fulfillment type');
    });
  });

  describe('fatal errors', () => {
    it('catches and reports exceptions', async () => {
      mockGrant.mockRejectedValueOnce(new Error('Boom'));
      const result = await service.fulfill(basePayload);
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
                guild_id: 'guild-1',
                customer_id: 'cust-1',
                product_id: 'prod-1',
                plan_id: null,
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

      const result = await service.fulfill(keyedPayload);

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

      const result = await service.fulfill(keyedPayload);

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

        const resultPromise = service.fulfill(keyedPayload);
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

        const resultPromise = service.fulfill(keyedPayload);
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

        const resultPromise = service.fulfill(keyedPayload);
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
