import type {
  CommerceProductIdentity,
  PayPalOnboardingStatus,
} from '@/components/store/onboarding-types';

export function getDashboardApiBase(origin: string): string {
  return `${origin.replace(/\/$/, '')}/api`;
}

export function buildLicenseSdkSnippet(
  product: CommerceProductIdentity,
  apiBase: string,
): string {
  return `import { SomniLicense } from '@somnibot/license-sdk';

const license = new SomniLicense({
  apiBase: '${apiBase}',
  licenseKey: userEnteredLicenseKey,
  productId: '${product.id}',
  deviceFingerprint: stableDeviceFingerprint,
  deviceName: 'Customer device',
  appVersion: '1.0.0',
});

const result = await license.validate();
if (!result.valid) {
  throw new Error(result.error ?? 'License validation failed');
}

// Validation starts the configured heartbeat. On shutdown:
await license.deactivate();
license.destroy();`;
}

export function describePayPalReadiness(status: PayPalOnboardingStatus): {
  readonly ready: boolean;
  readonly title: string;
  readonly detail: string;
} {
  if (!status.credentialsConfigured) {
    return {
      ready: false,
      title: 'PayPal credentials missing',
      detail: 'Add the Client ID and Client Secret in Settings before creating a paid product.',
    };
  }
  if (!status.webhookIdConfigured || !status.webhookUrlReady) {
    return {
      ready: false,
      title: 'PayPal webhook incomplete',
      detail: 'Configure a PayPal Webhook ID and a public HTTPS callback URL before taking payments.',
    };
  }
  if (!status.lastWebhook) {
    return {
      ready: false,
      title: 'Configured, delivery not yet observed',
      detail: 'The credentials and callback are configured, but this server has not recorded a signed PayPal webhook yet.',
    };
  }
  if (status.lastWebhook.result === 'error' || status.lastWebhook.result === 'pending') {
    return {
      ready: false,
      title: 'Latest webhook needs attention',
      detail: `The latest observed webhook is ${status.lastWebhook.result}. Open Store diagnostics before enabling sales.`,
    };
  }
  return {
    ready: true,
    title: 'Signed webhook observed',
    detail: `The latest webhook was processed as ${status.lastWebhook.result} at ${status.lastWebhook.processedAt ?? 'an unknown time'}.`,
  };
}
