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
  'discord-perk',
  'subscription',
  'virtual-good',
  'ticket-service',
  'free',
];

export const storeProductFacetOptions: readonly {
  readonly value: StoreProductFacet;
  readonly label: string;
  readonly description: string;
}[] = [
  { value: 'license-key', label: 'Licensed software', description: 'License-key delivery for apps and games.' },
  { value: 'downloadable', label: 'Downloads and links', description: 'Files or customer download links.' },
  { value: 'discord-perk', label: 'Discord access and bundles', description: 'Roles, private channels, access passes, and mixed bundles.' },
  { value: 'subscription', label: 'Subscriptions', description: 'Recurring billing products.' },
  { value: 'free', label: 'Free products', description: 'Products with no customer charge.' },
  { value: 'virtual-good', label: 'Virtual goods', description: 'Non-download digital goods.' },
  { value: 'ticket-service', label: 'Ticketed services', description: 'Service delivery through a support ticket.' },
];

export type StoreProductPolicy = {
  readonly enabledFacets: readonly StoreProductFacet[];
  readonly discordAccessEnabled: boolean;
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
  const discordAccessEnabled = enabled.has('discord-perk');
  const allowedDeliveryTypes: StoreDeliveryType[] = [];
  if (enabled.has('license-key')) allowedDeliveryTypes.push('license_key');
  if (enabled.has('downloadable')) allowedDeliveryTypes.push('file', 'link');
  if (discordAccessEnabled && enabled.has('virtual-good')) allowedDeliveryTypes.push('access_pass');
  if (discordAccessEnabled && enabled.has('downloadable')) allowedDeliveryTypes.push('mixed');
  return { enabledFacets, discordAccessEnabled, allowedDeliveryTypes };
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
    !policy.discordAccessEnabled
    && (choice.grantedRoleIds.length > 0 || choice.grantedChannelIds.length > 0)
  ) {
    return { ok: false, error: 'Discord roles and channels are disabled by Storefront policy.' };
  }
  return { ok: true };
}
