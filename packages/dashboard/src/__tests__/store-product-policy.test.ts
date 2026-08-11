import { describe, expect, it } from 'vitest';
import {
  evaluateStoreProductPolicy,
  validateStoreProductChoice,
} from '@/lib/store/store-product-policy';

describe('store product policy', () => {
  it('exposes only dynamic and static delivery even when legacy facets remain stored', () => {
    const policy = evaluateStoreProductPolicy([
      'license-key',
      'downloadable',
      'discord-perk',
      'virtual-good',
      'subscription',
    ]);

    expect(policy.discordFulfillmentEnabled).toBe(true);
    expect(policy.allowedDeliveryTypes).toEqual(['license_key', 'file']);
    expect(validateStoreProductChoice(policy, {
      type: 'subscription',
      deliveryType: 'access_pass',
      grantedRoleIds: [],
      grantedChannelIds: [],
    })).toMatchObject({ ok: false });
    expect(validateStoreProductChoice(policy, {
      type: 'subscription',
      deliveryType: 'license_key',
      grantedRoleIds: ['123456789012345678'],
      grantedChannelIds: [],
    })).toEqual({ ok: true });
    expect(validateStoreProductChoice(policy, {
      type: 'subscription',
      deliveryType: 'license_key',
      grantedRoleIds: ['123456789012345678'],
      grantedChannelIds: ['234567890123456789'],
    })).toEqual({ ok: true });
    expect(validateStoreProductChoice(policy, {
      type: 'one_time',
      deliveryType: 'file',
      grantedRoleIds: ['123456789012345678'],
      grantedChannelIds: ['234567890123456789'],
    })).toEqual({ ok: true });
  });

  it('keeps Discord benefits independent from legacy access-pass delivery types', () => {
    const policy = evaluateStoreProductPolicy(['downloadable', 'discord-perk', 'virtual-good']);

    expect(policy.discordFulfillmentEnabled).toBe(true);
    expect(policy.allowedDeliveryTypes).toEqual(['file']);
  });

  it('requires the matching product facet for subscription and free products', () => {
    const policy = evaluateStoreProductPolicy(['license-key']);

    expect(validateStoreProductChoice(policy, {
      type: 'subscription',
      deliveryType: 'license_key',
      grantedRoleIds: [],
      grantedChannelIds: [],
    })).toMatchObject({ ok: false });
    expect(validateStoreProductChoice(policy, {
      type: 'free',
      deliveryType: 'license_key',
      grantedRoleIds: [],
      grantedChannelIds: [],
    })).toMatchObject({ ok: false });
  });
});
