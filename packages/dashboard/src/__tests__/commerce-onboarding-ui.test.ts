import { describe, expect, it } from 'vitest';
import {
  buildLicenseSdkSnippet,
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
    granted_role_ids: deliveryType === 'access_pass' || deliveryType === 'mixed'
      ? ['123456789012345678']
      : [],
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
  it('exposes SDK and REST runtime paths only for license-key delivery', () => {
    const guide = buildProductIntegrationGuide(product('license_key'));

    expect(guide.kind).toBe('license');
    expect(guide.runtimePaths.map((path) => path.id)).toEqual(['node', 'browser', 'native']);
    expect(guide.runtimePaths.find((path) => path.id === 'browser')).toMatchObject({
      sameOriginOnly: true,
    });
    expect(guide.nativeExamples.map((example) => example.language)).toEqual(['Python', '.NET', 'Rust']);
  });

  it.each([
    ['file', 'download'],
    ['link', 'download'],
    ['access_pass', 'discord'],
    ['mixed', 'mixed'],
  ] as const)('maps %s delivery to %s fulfillment without SDK instructions', (deliveryType, kind) => {
    const guide = buildProductIntegrationGuide(product(deliveryType));

    expect(guide.kind).toBe(kind);
    expect(guide.runtimePaths).toEqual([]);
    expect(guide.nativeExamples).toEqual([]);
  });

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

  it('builds the TypeScript SDK snippet from authoritative identifiers', () => {
    const licenseProduct = product('license_key');
    const snippet = buildLicenseSdkSnippet(licenseProduct, 'https://dashboard.example.com/api');

    expect(snippet).toContain(`productId: '${licenseProduct.id}'`);
    expect(snippet).toContain("apiBase: 'https://dashboard.example.com/api'");
    expect(snippet).toContain('await license.deactivate()');
  });
});
