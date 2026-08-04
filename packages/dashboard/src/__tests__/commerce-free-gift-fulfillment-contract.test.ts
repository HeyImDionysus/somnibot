import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const migration = readFileSync(resolve(root, 'packages/supabase/migrations/20260804137000_free_claims_gift_intents.sql'), 'utf8');
const webhook = readFileSync(resolve(root, 'packages/dashboard/src/app/api/paypal/webhook/handlers.ts'), 'utf8');
const checkout = readFileSync(resolve(root, 'packages/bot/src/features/commerce/payment-handler.ts'), 'utf8');
const fulfillment = readFileSync(resolve(root, 'packages/bot/src/services/commerce-fulfillment.ts'), 'utf8');

describe('free claim and gift fulfillment rails', () => {
  it('exposes service-only atomic RPC contracts with replay and expiry guards', () => {
    expect(migration).toContain('commerce_claim_free_product');
    expect(migration).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(migration).toContain("COALESCE(v_policy,'one-claim') = 'one-claim'");
    expect(migration).toContain("v_intent.status='fulfilled'");
    expect(migration).toContain('expires_at <= pg_catalog.clock_timestamp()');
    expect(migration).toContain('p_guild_id');
    expect(migration).toContain('commerce_claim_gift_fulfillment');
  });

  it('carries only the opaque gift intent id through PayPal metadata', () => {
    expect(checkout).toContain('giftIntentId');
    expect(checkout).toContain('gift_checkout_token: giftIntentId');
    expect(checkout).toContain("createHmac('sha256'");
    expect(checkout).toContain('custom_id: `v1:${checkoutToken}.${checkoutSignature}`');
    expect(checkout).not.toContain('gi: giftIntentId');
    expect(checkout).not.toContain('recipient_discord_id: recipientId');
    expect(webhook).toContain("customId.match(/^v1:([0-9a-f-]{36})\\.([a-f0-9]{64})$/i)");
    expect(webhook).toContain('verifyCheckoutSignature(checkoutToken, checkoutSignature)');
    expect(webhook).toContain("giftLookup.eq('checkout_token', token)");
    expect(webhook).toContain('commerce_claim_gift_fulfillment');
    expect(webhook).toContain('gift_intent_invalid_or_replayed');
  });

  it('routes gift recipients through the existing fulfillment service', () => {
    expect(webhook).toContain('recipient_customer_id');
    expect(webhook).toContain('recipient_discord_id');
    expect(fulfillment).toContain('Gift recipient identity is missing or mismatched');
    expect(fulfillment).toContain('this.entitlementService.grant');
  });
});
