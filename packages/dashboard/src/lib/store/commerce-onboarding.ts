import type {
  CommerceProductIdentity,
  PayPalOnboardingStatus,
} from '@/components/store/onboarding-types';
import { getOperatorLicensingGuide } from './operator-licensing-guide';

const WEBHOOK_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PLATFORM_GUIDE_URL = 'https://github.com/HeyImDionysus/somnibot/blob/main/packages/license-sdk/docs/PLATFORMS.md';

export type ProductIntegrationGuide = {
  readonly kind: 'license' | 'download' | 'discord' | 'mixed';
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly string[];
  readonly runtimePaths: readonly {
    readonly id: 'node' | 'browser' | 'native';
    readonly label: string;
    readonly sameOriginOnly: boolean;
  }[];
  readonly nativeExamples: readonly {
    readonly language: 'Python' | '.NET' | 'Rust';
    readonly href: string;
  }[];
};

export function buildProductIntegrationGuide(
  product: CommerceProductIdentity,
): ProductIntegrationGuide {
  const fulfillment = getOperatorLicensingGuide({
    type: product.type,
    deliveryType: product.delivery_type,
    grantedRoleCount: product.granted_role_ids.length,
  });
  if (product.delivery_type === 'license_key') {
    return {
      kind: 'license',
      title: fulfillment.title,
      summary: fulfillment.summary,
      steps: fulfillment.steps,
      runtimePaths: [
        { id: 'node', label: 'Node, Electron, or server-side JavaScript', sameOriginOnly: false },
        { id: 'browser', label: 'Browser, PWA, HTML, or client-side JavaScript', sameOriginOnly: true },
        { id: 'native', label: 'Native app, executable, game, or non-JavaScript runtime', sameOriginOnly: false },
      ],
      nativeExamples: [
        { language: 'Python', href: `${PLATFORM_GUIDE_URL}#python` },
        { language: '.NET', href: `${PLATFORM_GUIDE_URL}#c--net` },
        { language: 'Rust', href: `${PLATFORM_GUIDE_URL}#rust` },
      ],
    };
  }
  const kind = product.delivery_type === 'access_pass'
    ? 'discord'
    : product.delivery_type === 'mixed'
      ? 'mixed'
      : 'download';
  return {
    kind,
    title: fulfillment.title,
    summary: fulfillment.summary,
    steps: fulfillment.steps,
    runtimePaths: [],
    nativeExamples: [],
  };
}

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
