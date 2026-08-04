import { describe, expect, it } from 'vitest';
import { guildConfigPatchSchema } from '../lib/guild-config-schema';

describe('portal/store guild controls', () => {
  it('accepts the documented control values', () => {
    const parsed = guildConfigPatchSchema.safeParse({
      product_types_enabled: ['subscription', 'free'],
      repeat_purchase_policy: 'stackable',
      free_claim_policy: 'repeatable',
      gifting_enabled: true,
      public_celebration_enabled: true,
      celebration_channel_id: '123456789012345678',
      store_brand_source: 'custom',
      max_storefront_products: 9,
      portal_session_ttl_ms: 604800000,
      download_link_ttl_ms: 300000,
      self_service_cancellation: true,
      cancellation_timing: 'end-of-term',
      refund_requests_enabled: true,
      service_requests_enabled: true,
      portal_brand_source: 'guild-profile',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unsafe TTLs, invalid policy enums, and non-snowflake channels', () => {
    const parsed = guildConfigPatchSchema.safeParse({
      portal_session_ttl_ms: 1,
      download_link_ttl_ms: 30,
      cancellation_timing: 'later',
      celebration_channel_id: 'not-a-snowflake',
    });
    expect(parsed.success).toBe(false);
  });
});
