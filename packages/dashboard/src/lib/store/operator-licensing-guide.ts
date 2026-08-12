export type StoreProductType = 'one_time' | 'subscription' | 'free';
export type StoreDeliveryType = 'file' | 'link' | 'access_pass' | 'license_key' | 'mixed';

export interface OperatorLicensingGuide {
  kind: 'download' | 'software' | 'subscription' | 'discord_perk' | 'mixed';
  title: string;
  summary: string;
  keyRequired: boolean;
  steps: string[];
}

export interface ProductDeliveryChoice {
  type: StoreProductType;
  deliveryType: StoreDeliveryType;
  grantedRoleCount?: number;
}

/**
 * Translate product settings into the delivery/licensing model an operator is
 * actually configuring. Keep this pure so the creation form, product cards,
 * tests, and future setup surfaces cannot drift into contradictory advice.
 */
export function getOperatorLicensingGuide(
  choice: ProductDeliveryChoice,
): OperatorLicensingGuide {
  if (
    choice.deliveryType === 'access_pass'
  ) {
    return {
      kind: 'discord_perk',
      title: 'Discord perk or role',
      summary: 'Do not issue a license key. The granted Discord role or channel access is the product.',
      keyRequired: false,
      steps: [
        'Use Access Pass delivery.',
        'Select every role the customer should receive; SomniBot applies and later revokes the entitlement.',
        'Keep the bot role above every granted role so Discord allows delivery.',
      ],
    };
  }

  if (choice.deliveryType === 'file' || choice.deliveryType === 'link') {
    const includesDiscordRole = (choice.grantedRoleCount ?? 0) > 0;
    return {
      kind: 'download',
      title: 'Download-once file or link',
      summary: includesDiscordRole
        ? 'Deliver the download and the configured Discord role; neither replaces the other.'
        : 'Do not issue a license key. Deliver an expiring, single-use signed link.',
      keyRequired: false,
      steps: [
        'Use File or Link delivery and upload the customer download.',
        ...(includesDiscordRole
          ? ['Select every bonus Discord role and keep the bot role above it so fulfillment can deliver both benefits.']
          : []),
        'SomniBot issues a five-minute portal link and consumes its nonce on delivery, so the same link cannot be reused.',
        'A new link still requires a live entitlement; deactivating the product does not erase prior customer access.',
      ],
    };
  }

  if (choice.deliveryType === 'mixed') {
    // Fulfillment mints a license key ONLY for the exact license_key
    // delivery type (handleCaptureCompleted), and staged license payloads
    // are rejected for mixed — promising a key here sold buyers a bundle
    // that never delivers one.
    return {
      kind: 'mixed',
      title: 'Mixed delivery bundle',
      summary:
        'Bundle Discord roles with a download in one purchase. No license key is issued for mixed delivery.',
      keyRequired: false,
      steps: [
        'Upload the file or link and select every bundled Discord role; keep the bot role above the granted roles.',
        'Test-purchase and verify every bundled delivery — fulfillment grants each part separately.',
        'Need a key? Use License Key delivery instead: keys are minted only for that exact delivery type, never for mixed.',
      ],
    };
  }

  if (choice.type === 'subscription') {
    return {
      kind: 'subscription',
      title: 'Recurring software subscription',
      summary: 'Issue a license key and keep it valid only while the paid entitlement is live.',
      keyRequired: true,
      steps: [
        'Use License Key delivery and attach an active PayPal billing plan.',
        'Set the machine limit and heartbeat interval in the product license settings.',
        'Your app must handle active, grace-period, cancelled, and unavailable responses explicitly.',
      ],
    };
  }

  if (choice.deliveryType === 'license_key') {
    return {
      kind: 'software',
      title: 'Software that phones home',
      summary: 'Issue a license key, enforce a machine count, and choose an outage policy in your app.',
      keyRequired: true,
      steps: [
        'Set the machine limit, heartbeat interval, and offline grace period in the product license settings.',
        'Fail open: on a temporary unavailable response, keep a previously valid cached session working only for the configured offline grace period.',
        'Fail closed: on a temporary unavailable response, stop access until validation succeeds. This is stricter but can lock out paying customers during an outage.',
      ],
    };
  }

  // The union is exhaustive, but keep a truthful fallback if a future
  // delivery type reaches an older dashboard bundle.
  return {
    kind: 'download',
    title: 'Download-once file or link',
    summary: 'Do not issue a license key. Deliver an expiring, single-use signed link.',
    keyRequired: false,
    steps: [
      'Use File or Link delivery and upload the customer download.',
      'SomniBot issues a five-minute portal link and consumes its nonce on delivery, so the same link cannot be reused.',
      'A new link still requires a live entitlement; deactivating the product does not erase prior customer access.',
    ],
  };
}
