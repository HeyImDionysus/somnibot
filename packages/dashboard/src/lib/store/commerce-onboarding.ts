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
      summary: 'The addendum inspects the real project and implements the same validate, heartbeat, and deactivation contract in its existing language and runtime.',
      steps: [
        'Copy the generated addendum into the project creation or implementation prompt.',
        'Let the implementer inspect the project before choosing its HTTP or SDK integration.',
        'Prove validation, heartbeat, retryable outages, terminal revocation, and deactivation against Sandbox.',
      ],
    };
  }
  return {
    mode: 'static',
    title: 'Static licensed delivery',
    summary: 'The addendum prepares a clean master while SomniBot controls entitlement, single-use delivery, buyer-specific watermarking, and future-access revocation.',
    steps: [
      'Copy the generated addendum into the project creation or export prompt.',
      'Upload only the clean master artifact; never pre-embed customer identity or license secrets.',
      'Prove buyer-specific derivation, signed delivery, watermark survival, and future-access revocation in Sandbox.',
    ],
  };
}

export function getDashboardApiBase(origin: string): string {
  return `${origin.replace(/\/$/, '')}/api`;
}

export function buildLicensingAddendumPrompt(
  product: CommerceProductIdentity,
  apiBase: string,
): string {
  const guide = buildProductIntegrationGuide(product);
  const buyerRoleIds = product.granted_role_ids.length > 0
    ? product.granted_role_ids.join(',')
    : 'NONE';
  const buyerChannelIds = 'granted_channel_ids' in product
    && Array.isArray(product.granted_channel_ids)
    && product.granted_channel_ids.length > 0
    ? product.granted_channel_ids.join(',')
    : 'NONE';
  const header = `SOMNIBOT UNIVERSAL LICENSING ADDENDUM
PROJECT_NAME: ${product.name}
PRODUCT_ID: ${product.id}
API_BASE: ${apiBase}
LICENSING_MODE: ${guide.mode.toUpperCase()}
DISCORD_BUYER_ROLE_IDS: ${buyerRoleIds}
DISCORD_BUYER_CHANNEL_IDS: ${buyerChannelIds}`;

  if (guide.mode === 'dynamic') {
    return `${header}

Treat this addendum as a required part of the project specification. First inspect this project before choosing an integration. Reuse its current language, runtime, architecture, configuration, error model, and test conventions. Do not convert the project, add a second runtime, or ask the owner to choose from a catalogue of project types.

SomniBot's database entitlement is the purchase authority. If a Discord buyer role or channel list is not NONE, grant those product benefits only after the entitlement becomes active, remove them after refund or revocation, and reconcile transient Discord failures. Discord mirrors fulfillment; it must never substitute for the entitlement or license verdict, and the server itself is not the product.

Implement the canonical licensing lifecycle:
1. Accept a customer-entered license key through an appropriate secure UX or configuration boundary. Never hard-code or log the raw key.
2. Create a stable per-installation device identifier that is not a hardware fingerprint or secret.
3. Validate against ${apiBase}/license/validate with PRODUCT_ID and the device identity before enabling paid features.
4. Maintain the server-directed heartbeat through ${apiBase}/license/heartbeat. Treat timeouts, network failures, 429, and 5xx as retryable or offline-grace states, never as revocation.
5. Treat revoked, expired, suspended, over-device-limit, and invalidated-session verdicts as terminal. Disable licensed features without corrupting customer data and explain the recovery action.
6. Deactivate the exact active session through ${apiBase}/license/deactivate on explicit sign-out or device removal and on reliable shutdown paths. Do not claim unload delivery where the runtime cannot guarantee it.
7. Keep free or local-only behavior usable when the product specification allows it. Gate only licensed capabilities.
8. For browser-delivered clients, never embed privileged credentials. Use same-origin licensing calls unless SomniBot reports an explicit product-scoped allowed origin.

Acceptance proof is mandatory: valid activation, server-directed heartbeat, restart recovery, retryable outage, offline grace, terminal revocation, device-limit denial, deactivation, and secret-redaction tests. The final test must exercise the real built artifact against SomniBot Sandbox, not only mocks. Return an evidence receipt containing the product ID, test time, non-secret session suffix, and every lifecycle verdict.`;
  }

  return `${header}

Treat this addendum as a required part of the project specification. First inspect the requested output and produce a clean, deterministic master artifact. Do not add a runtime SDK, heartbeat loop, license key field, Discord access, or executable wrapper merely to license static content.

SomniBot's database entitlement is the purchase authority. If a Discord buyer role or channel list is not NONE, grant those product benefits only after the entitlement becomes active, remove them after refund or revocation, and reconcile transient Discord failures. Discord mirrors fulfillment; it must never substitute for the entitlement, and the server itself is not the product.

Implement the canonical static-delivery contract:
1. Keep the master free of customer identity, order data, license secrets, and irreversible watermark text. Generate deterministic output so a delivered derivative can be traced to its exact master hash.
2. Deliver only after SomniBot proves a live entitlement and mints an expiring, single-use signed download. A revoked or refunded entitlement must block every future download, update, and replacement link.
3. Before delivery, create a buyer-specific derivative from a server-held HMAC seed. Combine content-aware visible marks, repeated low-salience micro-patterns, and format-appropriate invisible fingerprints. Spread identifiers across the content so one crop, page extraction, metadata strip, resize, recompression, contrast change, or local inpainting does not remove the whole signal.
4. Emit a cryptographically signed watermark manifest containing the master hash, derivative hash, product ID, non-secret entitlement reference, algorithm version, and verification hints. Never expose the HMAC secret or raw buyer credentials.
5. Fail closed if buyer-specific derivative generation or manifest signing is unavailable. Never silently deliver the unmarked master as a successful licensed download.
6. Be truthful about revocation: it can block every future download, update, and supported access, but cannot erase copies already downloaded. Watermark evidence supports investigation; it is not remote deletion or a promise that removal is impossible.

Acceptance proof is mandatory: authorized download, signed-link single use, expired-link denial, refund or revocation denial, per-buyer derivative differences, manifest verification, and watermark survival after crop, screenshot or render, resize, recompression, contrast change, page or file extraction, metadata stripping, and bounded AI or inpainting cleanup. The final test must use harmless generated fixtures for every supported static format and must never expose real customer data.`;
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
