import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAYPAL_HANDLED_WEBHOOK_EVENT_TYPES,
  PAYPAL_INTENTIONALLY_EXCLUDED_WEBHOOK_EVENTS,
} from '@/lib/paypal-webhook-events';

describe('PayPal webhook event catalog', () => {
  const routeSource = readFileSync(
    path.resolve(__dirname, '../app/api/paypal/webhook/route.ts'),
    'utf8',
  );
  const setupSource = readFileSync(
    path.resolve(__dirname, '../app/(setup)/setup/page.tsx'),
    'utf8',
  );
  const readmeSource = readFileSync(
    path.resolve(__dirname, '../../../../README.md'),
    'utf8',
  );
  const botSetupSource = readFileSync(
    path.resolve(__dirname, '../../../bot/src/features/setup-wizard/steps.ts'),
    'utf8',
  );

  it('keeps every setup-listed PayPal event backed by an explicit route case', () => {
    for (const eventType of PAYPAL_HANDLED_WEBHOOK_EVENT_TYPES) {
      expect(routeSource).toContain(`case '${eventType}'`);
    }
  });

  it('renders the shared event catalog in setup instead of a stale hand-written list', () => {
    expect(setupSource).toContain('PAYPAL_HANDLED_WEBHOOK_EVENTS.map');
  });

  it('keeps README and bot setup instructions aligned to handled events', () => {
    for (const eventType of PAYPAL_HANDLED_WEBHOOK_EVENT_TYPES) {
      expect(readmeSource).toContain(eventType);
      expect(botSetupSource).toContain(eventType);
    }
  });

  it('handles subscription expiry explicitly', () => {
    expect(PAYPAL_HANDLED_WEBHOOK_EVENT_TYPES).toContain(
      'BILLING.SUBSCRIPTION.EXPIRED',
    );
    expect(PAYPAL_INTENTIONALLY_EXCLUDED_WEBHOOK_EVENTS).toEqual([]);
    expect(routeSource).toContain("case 'BILLING.SUBSCRIPTION.EXPIRED'");
  });
});
