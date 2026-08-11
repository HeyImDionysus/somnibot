import { describe, expect, it } from 'vitest';
import {
  buildLicensingAddendumPrompt,
  buildProductIntegrationGuide,
  describePayPalReadiness,
} from '@/lib/store/commerce-onboarding';
import type {
  CommerceProductIdentity,
  PayPalOnboardingStatus,
} from '@/components/store/onboarding-types';

function product(
  deliveryType: CommerceProductIdentity['delivery_type'],
): CommerceProductIdentity {
  return {
    id: '00000000-0000-4000-8000-000000000123',
    name: 'Creator Pro',
    type: 'subscription',
    delivery_type: deliveryType,
    paypal_product_id: 'PROD-SANDBOX-123',
    granted_role_ids: ['123456789012345678'],
    granted_channel_ids: ['234567890123456789'],
    plans: [{
      id: '00000000-0000-4000-8000-000000000456',
      product_id: '00000000-0000-4000-8000-000000000123',
      name: 'Monthly Pro',
      paypal_plan_id: 'PLAN-SANDBOX-456',
      interval_unit: 'MONTH',
      interval_count: 1,
      price_cents: 1900,
      currency: 'USD',
      trial_days: 14,
      active: true,
    }],
  };
}

function status(overrides: Partial<PayPalOnboardingStatus> = {}): PayPalOnboardingStatus {
  return {
    environment: 'sandbox',
    apiBase: 'https://dashboard.example.com/api',
    credentialsConfigured: true,
    webhookIdConfigured: true,
    webhookUrl: 'https://dashboard.example.com/api/paypal/webhook',
    webhookUrlReady: true,
    lastWebhook: null,
    checkedAt: '2026-08-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('commerce creator onboarding contracts', () => {
  it('maps license-key delivery to one runtime-agnostic dynamic contract', () => {
    const guide = buildProductIntegrationGuide(product('license_key'));

    expect(guide.mode).toBe('dynamic');
    expect(guide.title).toBe('Dynamic licensing');
  });

  it.each(['file', 'link', 'access_pass', 'mixed'] as const)(
    'maps legacy %s delivery to the static contract instead of inventing a project type',
    (deliveryType) => {
    const guide = buildProductIntegrationGuide(product(deliveryType));

      expect(guide.mode).toBe('static');
      expect(guide.title).toBe('Static licensed delivery');
    },
  );

  it('degrades signed-webhook evidence after the freshness window', () => {
    const readiness = describePayPalReadiness(status({
      checkedAt: '2026-08-12T12:00:00.000Z',
      lastWebhook: {
        result: 'success',
        processedAt: '2026-08-10T11:59:00.000Z',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
      },
    }));

    expect(readiness).toMatchObject({ ready: false, state: 'stale' });
  });

  it('accepts recent signed-webhook evidence as ready', () => {
    const readiness = describePayPalReadiness(status({
      lastWebhook: {
        result: 'success',
        processedAt: '2026-08-10T11:59:00.000Z',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
      },
    }));

    expect(readiness).toMatchObject({ ready: true, state: 'ready' });
  });

  it('builds one dynamic prompt that tells the implementer to inspect the actual project', () => {
    const prompt = buildLicensingAddendumPrompt(
      product('license_key'),
      'https://dashboard.example.com/api',
    );

    expect(prompt).toContain('LICENSING_MODE: DYNAMIC');
    expect(prompt).toContain('inspect this project before choosing an integration');
    expect(prompt).toContain('/license/validate');
    expect(prompt).toContain('/license/heartbeat');
    expect(prompt).toContain('/license/deactivate');
    expect(prompt).toContain('DISCORD_BUYER_ROLE_IDS: 123456789012345678');
    expect(prompt).toContain('DISCORD_BUYER_CHANNEL_IDS: 234567890123456789');
    expect(prompt).toContain('remove them after refund or revocation');
    expect(prompt).toContain("PRODUCT_ID: 00000000-0000-4000-8000-000000000123");
    expect(prompt).not.toContain('Choose Node');
    expect(prompt).not.toContain('Choose Rust');
  });

  it('builds one static prompt with entitlement, watermark, and truthful revocation requirements', () => {
    const prompt = buildLicensingAddendumPrompt(
      product('file'),
      'https://dashboard.example.com/api',
    );

    expect(prompt).toContain('LICENSING_MODE: STATIC');
    expect(prompt).toContain('buyer-specific derivative');
    expect(prompt).toContain('cryptographically signed watermark manifest');
    expect(prompt).toContain('block every future download, update, and replacement link');
    expect(prompt).toContain('cannot erase copies already downloaded');
    expect(prompt).toContain('Discord mirrors fulfillment');
  });
});
