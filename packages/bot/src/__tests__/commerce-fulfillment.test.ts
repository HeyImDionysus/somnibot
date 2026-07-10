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
      mockGrant.mockResolvedValueOnce(null as any);
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
      mockGrant.mockResolvedValueOnce(null as any);
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

    it("suspends with the guild's configured grace window from getGracePeriodDays (single source of truth)", async () => {
      // Codex round-2 finding #1: the bot's suspend path must read the
      // configured window via the shared helper, not a hardcoded value —
      // the same source of truth the dashboard's manual PUT uses. Return a
      // distinctive 9 so a hardcoded default (3) would fail this assertion.
      (getGracePeriodDays as ReturnType<typeof vi.fn>).mockResolvedValueOnce(9);
      const supa = makeSupa({ entitlements: [{ id: 'ent-1' }] });
      service = new CommerceFulfillmentService(makeGuild(), supa as any, eventBus);

      const payload = { ...basePayload, fulfillment_type: 'subscription_suspended' };
      await service.fulfill(payload);

      expect(getGracePeriodDays).toHaveBeenCalledWith(supa, payload.guild_id);
      expect(mockSuspend).toHaveBeenCalledWith('ent-1', 9);
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
