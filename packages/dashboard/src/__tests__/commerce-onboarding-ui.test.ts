import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProductIntegrationPanel } from '@/components/store/product-integration-panel';
import { SubscriptionPlanEditor } from '@/components/store/subscription-plan-editor';
import {
  buildLicenseSdkSnippet,
  describePayPalReadiness,
} from '@/lib/store/commerce-onboarding';
import type {
  CommerceProductIdentity,
  PayPalOnboardingStatus,
  SubscriptionPlanDraft,
} from '@/components/store/onboarding-types';

const product: CommerceProductIdentity = {
  id: '00000000-0000-4000-8000-000000000123',
  name: 'Creator Pro',
  paypal_product_id: 'PROD-SANDBOX-123',
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

const planDraft: SubscriptionPlanDraft = {
  name: 'Monthly Pro',
  interval_unit: 'MONTH',
  interval_count: 1,
  price_cents: 1900,
  currency: 'USD',
  trial_days: 14,
  active: true,
};

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

describe('commerce creator onboarding', () => {
  it('renders every initial subscription-plan decision in the product flow', () => {
    const html = renderToStaticMarkup(createElement(SubscriptionPlanEditor, {
      productId: null,
      currency: 'USD',
      draft: planDraft,
      initialPlans: [],
      onDraftChange: vi.fn(),
      onReadback: vi.fn(),
    }));

    expect(html).toContain('Subscription plan');
    expect(html).toContain('Billing interval');
    expect(html).toContain('Charge every');
    expect(html).toContain('Price (USD)');
    expect(html).toContain('Free trial (days)');
    expect(html).toContain('Available for new subscriptions');
    expect(html).toContain('value="14"');
  });

  it('renders exact integration identifiers, commands, SDK config, and safe validation route', () => {
    const html = renderToStaticMarkup(createElement(ProductIntegrationPanel, {
      product,
      apiBase: 'https://dashboard.example.com/api',
      environment: 'sandbox',
    }));

    expect(html).toContain('Integrate Creator Pro');
    expect(html).toContain(product.id);
    expect(html).toContain('PROD-SANDBOX-123');
    expect(html).toContain('PLAN-SANDBOX-456');
    expect(html).toContain('npm install @somnibot/license-sdk');
    expect(html).toContain('pnpm add @somnibot/license-sdk');
    expect(html).toContain('https://dashboard.example.com/api');
    expect(html).toContain('stableDeviceFingerprint');
    expect(html).toContain('Sandbox');
    expect(html).toContain('does not mint an administrator test key');
  });

  it('identifies the preserved product and exposes retry after policy failure', () => {
    const html = renderToStaticMarkup(createElement(ProductIntegrationPanel, {
      product,
      apiBase: 'https://dashboard.example.com/api',
      environment: 'sandbox',
      recoveryMessage: 'The license policy write failed.',
      recoveryActionLabel: 'Retry license policy',
      onRetry: vi.fn(),
    }));

    expect(html).toContain('Product preserved; setup needs a retry');
    expect(html).toContain(product.id);
    expect(html).toContain('Retry license policy');
  });

  it('does not call configured PayPal ready until a signed webhook is observed', () => {
    expect(describePayPalReadiness(status()).title).toBe('Configured, delivery not yet observed');
    expect(describePayPalReadiness(status({
      lastWebhook: {
        result: 'success',
        processedAt: '2026-08-10T11:59:00.000Z',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
      },
    }))).toMatchObject({ ready: true, title: 'Signed webhook observed' });
  });

  it('builds a copyable SDK snippet with the authoritative product and API base', () => {
    const snippet = buildLicenseSdkSnippet(product, 'https://dashboard.example.com/api');
    expect(snippet).toContain(`productId: '${product.id}'`);
    expect(snippet).toContain("apiBase: 'https://dashboard.example.com/api'");
    expect(snippet).toContain('await license.deactivate()');
  });
});
