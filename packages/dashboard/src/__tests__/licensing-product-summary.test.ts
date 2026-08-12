import { describe, expect, it } from 'vitest';
import { parseLicensingProducts } from '@/lib/store/licensing-products';

describe('licensing product summary', () => {
  it('classifies saved Store delivery as dynamic or static', () => {
    const products = parseLicensingProducts({
      success: true,
      data: [
        {
          id: 'dynamic-product',
          name: 'SafePaste',
          type: 'one_time',
          delivery_type: 'license_key',
          active: true,
          granted_role_ids: [],
          granted_channel_ids: [],
          plans: [],
          product_files: [],
          product_license_config: {
            max_devices: 2,
            heartbeat_interval_seconds: 300,
            offline_grace_period_seconds: 3600,
          },
        },
        {
          id: 'static-product',
          name: 'Asset Pack',
          type: 'subscription',
          delivery_type: 'file',
          active: false,
          granted_role_ids: ['role-id'],
          granted_channel_ids: ['channel-id'],
          plans: [{ id: 'plan-id', active: true }],
          product_files: [{ id: 'file-id' }],
          product_license_config: [],
        },
      ],
    });

    expect(products).toEqual([
      expect.objectContaining({ mode: 'dynamic', maxInstallations: 2, fileCount: 0 }),
      expect.objectContaining({ mode: 'static', planCount: 1, fileCount: 1, discordBenefitCount: 2 }),
    ]);
  });

  it('rejects malformed product responses instead of presenting guessed status', () => {
    expect(() => parseLicensingProducts({ success: true, data: [{ name: 'Missing identity' }] }))
      .toThrow('Store product readback is invalid');
  });

  it('also accepts the array relationship shape used by older Supabase metadata', () => {
    const [product] = parseLicensingProducts({
      success: true,
      data: [{
        id: 'array-policy-product',
        name: 'Array Policy Product',
        type: 'subscription',
        delivery_type: 'license_key',
        active: true,
        granted_role_ids: [],
        granted_channel_ids: [],
        plans: [],
        product_files: [],
        product_license_config: [{
          max_devices: 3,
          heartbeat_interval_seconds: 60,
          offline_grace_period_seconds: 600,
        }],
      }],
    });

    expect(product).toEqual(expect.objectContaining({
      maxInstallations: 3,
      heartbeatSeconds: 60,
      offlineGraceSeconds: 600,
    }));
  });
});
