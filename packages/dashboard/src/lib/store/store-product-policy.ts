import { z } from 'zod';
import type {
  StoreDeliveryType,
  StoreProductType,
} from './operator-licensing-guide';

export const storeProductFacetSchema = z.enum([
  'downloadable',
  'license-key',
  'discord-perk',
  'subscription',
  'virtual-good',
  'ticket-service',
  'free',
]);

export const storeProductFacetsSchema = z.array(storeProductFacetSchema).max(7);

export type StoreProductFacet = z.infer<typeof storeProductFacetSchema>;

export const defaultStoreProductFacets: readonly StoreProductFacet[] = [
  'downloadable',
  'license-key',
  'subscription',
  'free',
];

export const storeProductFacetOptions: readonly {
  readonly value: StoreProductFacet;
  readonly label: string;
  readonly description: string;
}[] = [
  { value: 'license-key', label: 'Dynamic licensing', description: 'Runtime validation, heartbeat, and revocation.' },
  { value: 'downloadable', label: 'Static licensing', description: 'Entitled, watermarked, single-use file delivery.' },
  { value: 'subscription', label: 'Subscriptions', description: 'Recurring billing products.' },
  { value: 'free', label: 'Free products', description: 'Products with no customer charge.' },
];

export type StoreProductPolicy = {
  readonly enabledFacets: readonly StoreProductFacet[];
  readonly discordFulfillmentEnabled: boolean;
  readonly allowedDeliveryTypes: readonly StoreDeliveryType[];
};

export type StoreProductChoice = {
  readonly type: StoreProductType;
  readonly deliveryType: StoreDeliveryType;
  readonly grantedRoleIds: readonly string[];
  readonly grantedChannelIds: readonly string[];
};

export type StoreProductPolicyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export function parseStoreProductFacets(value: unknown): readonly StoreProductFacet[] {
  const parsed = storeProductFacetsSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultStoreProductFacets;
}

export function evaluateStoreProductPolicy(
  enabledFacets: readonly StoreProductFacet[],
): StoreProductPolicy {
  const enabled = new Set(enabledFacets);
  const discordFulfillmentEnabled = true;
  const allowedDeliveryTypes: StoreDeliveryType[] = [];
  if (enabled.has('license-key')) allowedDeliveryTypes.push('license_key');
  if (enabled.has('downloadable')) allowedDeliveryTypes.push('file');
  return { enabledFacets, discordFulfillmentEnabled, allowedDeliveryTypes };
}

export function validateStoreProductChoice(
  policy: StoreProductPolicy,
  choice: StoreProductChoice,
): StoreProductPolicyResult {
  if (choice.type === 'subscription' && !policy.enabledFacets.includes('subscription')) {
    return { ok: false, error: 'Subscriptions are disabled by Storefront policy.' };
  }
  if (choice.type === 'free' && !policy.enabledFacets.includes('free')) {
    return { ok: false, error: 'Free products are disabled by Storefront policy.' };
  }
  if (!policy.allowedDeliveryTypes.includes(choice.deliveryType)) {
    return { ok: false, error: 'This delivery type is disabled by Storefront policy.' };
  }
  if (
    !policy.discordFulfillmentEnabled
    && (choice.grantedRoleIds.length > 0 || choice.grantedChannelIds.length > 0)
  ) {
    return { ok: false, error: 'Discord fulfillment benefits are disabled by Storefront policy.' };
  }
  return { ok: true };
}
