import { describe, expect, it } from 'vitest';
import {
  parseActionQueuePlatformEvent,
  parseConfigReloadAuditEvent,
} from '../services/action-queue-event-ingress.js';

describe('action-queue event ingress', () => {
  it('accepts the exact config-reload automation audit contracts', () => {
    expect(parseConfigReloadAuditEvent({
      type: 'automation.created',
      data: {
        automationId: 'automation-1',
        automationName: 'Welcome',
        trigger: 'member.joined',
        createdBy: 'owner-1',
        enabled: true,
        actionCount: 1,
      },
    })).toMatchObject({ type: 'automation.created' });
  });

  it.each(['member.joined', 'purchase.completed', 'entitlement.granted', 'config.changed'])(
    'rejects arbitrary config-reload event %s',
    (type) => {
      expect(parseConfigReloadAuditEvent({ type, data: {} })).toBeNull();
    },
  );

  it('preserves the durable subscription-expired bridge', () => {
    expect(parseActionQueuePlatformEvent({
      event_type: 'subscription.expired',
      event_data: {
        lifecycleId: 'lifecycle-1',
        discordId: 'discord-1',
        productId: 'product-1',
        planId: 'plan-1',
        status: 'expired',
        orderId: 'order-1',
      },
    })).toMatchObject({ type: 'subscription.expired' });
  });

  it('rejects allowed names with malformed payloads', () => {
    expect(parseActionQueuePlatformEvent({
      event_type: 'webhook.received',
      event_data: { eventId: 'event-1' },
    })).toBeNull();
    expect(parseActionQueuePlatformEvent({
      event_type: 'subscription.expired',
      event_data: {
        lifecycleId: 'lifecycle-1',
        discordId: 'discord-1',
        productId: 'product-1',
        planId: 'plan-1',
        status: 'activated',
      },
    })).toBeNull();
  });
});
