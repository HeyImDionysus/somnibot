import { describe, expect, it } from 'vitest';
import {
  evaluateStoreProductPolicy,
  validateStoreProductChoice,
} from '@/lib/store/store-product-policy';

describe('store product policy', () => {
  it('makes a software-only policy exclude Discord access, mixed delivery, and grants', () => {
    const policy = evaluateStoreProductPolicy(['license-key', 'subscription']);

    expect(policy.discordAccessEnabled).toBe(false);
    expect(policy.allowedDeliveryTypes).toEqual(['license_key']);
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
    })).toMatchObject({ ok: false });
  });

  it('requires explicit Discord and download facets for mixed delivery', () => {
    expect(evaluateStoreProductPolicy(['downloadable']).allowedDeliveryTypes).not.toContain('mixed');
    expect(evaluateStoreProductPolicy(['discord-perk']).allowedDeliveryTypes).not.toContain('mixed');
    expect(evaluateStoreProductPolicy(['downloadable', 'discord-perk']).allowedDeliveryTypes).toContain('mixed');
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
