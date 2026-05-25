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
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setColor() { return this; } setTitle() { return this; }
    setDescription() { return this; } setFooter() { return this; }
    setTimestamp() { return this; } addFields() { return this; }
  },
  Collection: class extends Map {},
}));

const { mockGrant, mockRevoke, mockSuspend, mockReactivate } = vi.hoisted(() => ({
  mockGrant: vi.fn(async () => 'ent-123'),
  mockRevoke: vi.fn(async () => true),
  mockSuspend: vi.fn(async () => true),
  mockReactivate: vi.fn(async () => true),
}));

vi.mock('../features/commerce/entitlement-service.js', () => ({
  EntitlementService: class {
    grant = mockGrant;
    revoke = mockRevoke;
    suspend = mockSuspend;
    reactivate = mockReactivate;
  },
}));

vi.mock('../features/commerce/receipt-builder.js', () => ({
  sendReceiptDM: vi.fn(async () => true),
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

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'in', 'order', 'limit', 'single', 'maybeSingle']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa(overrides: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => {
      const data = overrides[table] ?? null;
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

describe('CommerceFulfillmentService', () => {
  let service: CommerceFulfillmentService;
  let eventBus: any;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    service = new CommerceFulfillmentService(makeGuild(), makeSupa() as any, eventBus);
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
      mockGrant.mockResolvedValueOnce(null);
      const result = await service.fulfill(basePayload);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Failed to create entitlement');
    });
  });

  describe('subscription_activated', () => {
    it('grants subscription entitlement', async () => {
      const payload = { ...basePayload, fulfillment_type: 'subscription_activated', plan_id: 'plan-monthly', entitlement_type: 'subscription' as const };
      const result = await service.fulfill(payload);
      expect(result.success).toBe(true);
      expect(result.entitlementId).toBe('ent-123');
      expect(eventBus.emit).toHaveBeenCalledWith('subscription.activated', 'guild-1', expect.objectContaining({ status: 'activated' }));
    });

    it('reports error when subscription grant fails', async () => {
      mockGrant.mockResolvedValueOnce(null);
      const payload = { ...basePayload, fulfillment_type: 'subscription_activated' };
      const result = await service.fulfill(payload);
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('subscription entitlement');
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
    it('revokes entitlements and sends DM', async () => {
      const supa = makeSupa({ entitlements: [{ id: 'ent-1' }] });
      eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

      const payload = { ...basePayload, fulfillment_type: 'subscription_cancelled' };
      const result = await service.fulfill(payload);
      expect(result.eventEmitted).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledWith('subscription.lapsed', 'guild-1', expect.any(Object));
    });
  });

  describe('subscription_suspended', () => {
    it('suspends entitlements', async () => {
      const supa = makeSupa({ entitlements: [{ id: 'ent-1' }] });
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

      const payload = { ...basePayload, fulfillment_type: 'subscription_suspended' };
      const result = await service.fulfill(payload);
      expect(result.eventEmitted).toBe(true);
    });
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
});
