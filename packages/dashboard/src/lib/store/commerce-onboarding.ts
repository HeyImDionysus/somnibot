import type {
  CommerceProductIdentity,
  PayPalOnboardingStatus,
} from '@/components/store/onboarding-types';
const WEBHOOK_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ProductIntegrationGuide = {
  readonly mode: 'dynamic' | 'static';
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly string[];
};

export function buildProductIntegrationGuide(
  product: CommerceProductIdentity,
): ProductIntegrationGuide {
  if (product.delivery_type === 'license_key') {
    return {
      mode: 'dynamic',
      title: 'Dynamic licensing',
      summary: 'This saved Store product issues a license key and uses validation, heartbeat, and deactivation through SomniBot.',
      steps: [
        'Complete the product license policy and confirm it reads back from Store.',
        'Run a real Sandbox purchase so PayPal, entitlement, and key issuance use the supported path.',
        'Verify validation, heartbeat, retryable outages, terminal revocation, and deactivation in Licensing.',
      ],
    };
  }
  return {
    mode: 'static',
    title: 'Static licensed delivery',
    summary: 'This saved Store product delivers protected buyer-specific derivatives while SomniBot controls entitlement and future access.',
    steps: [
      'Upload only a clean supported master artifact; never pre-embed customer identity or license secrets.',
      'Run a real Sandbox purchase and download through the customer portal.',
      'Verify buyer-specific derivation, signed delivery, watermark survival, and future-access revocation in Licensing.',
    ],
  };
}

export function describePayPalReadiness(status: PayPalOnboardingStatus): {
  readonly ready: boolean;
  readonly state: 'missing' | 'incomplete' | 'unobserved' | 'degraded' | 'stale' | 'ready';
  readonly title: string;
  readonly detail: string;
} {
  if (!status.credentialsConfigured) {
    return {
      ready: false,
      state: 'missing',
      title: 'PayPal credentials missing',
      detail: 'Add the Client ID and Client Secret in Settings before creating a paid product.',
    };
  }
  if (!status.webhookIdConfigured || !status.webhookUrlReady) {
    return {
      ready: false,
      state: 'incomplete',
      title: 'PayPal webhook incomplete',
      detail: 'Configure a PayPal Webhook ID and a public HTTPS callback URL before taking payments.',
    };
  }
  if (!status.lastWebhook) {
    return {
      ready: false,
      state: 'unobserved',
      title: 'Configured, delivery not yet observed',
      detail: 'The credentials and callback are configured, but this server has not recorded a signed PayPal webhook yet.',
    };
  }
  if (status.lastWebhook.result === 'error' || status.lastWebhook.result === 'pending') {
    return {
      ready: false,
      state: 'degraded',
      title: 'Latest webhook needs attention',
      detail: `The latest observed webhook is ${status.lastWebhook.result}. Open Store diagnostics before enabling sales.`,
    };
  }
  const checkedAt = Date.parse(status.checkedAt);
  const processedAt = status.lastWebhook.processedAt
    ? Date.parse(status.lastWebhook.processedAt)
    : Number.NaN;
  if (
    !Number.isFinite(checkedAt)
    || !Number.isFinite(processedAt)
    || checkedAt - processedAt > WEBHOOK_EVIDENCE_MAX_AGE_MS
  ) {
    return {
      ready: false,
      state: 'stale',
      title: 'Signed webhook evidence is stale',
      detail: 'Run a PayPal sandbox purchase and observe a new signed webhook before enabling sales.',
    };
  }
  return {
    ready: true,
    state: 'ready',
    title: 'Signed webhook observed',
    detail: `The latest webhook was processed as ${status.lastWebhook.result} at ${status.lastWebhook.processedAt ?? 'an unknown time'}.`,
  };
}
