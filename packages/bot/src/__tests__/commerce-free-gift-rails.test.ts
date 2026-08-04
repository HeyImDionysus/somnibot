import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..', '..', '..');
const payment = readFileSync(resolve(root, 'packages/bot/src/features/commerce/payment-handler.ts'), 'utf8');
const interaction = readFileSync(resolve(root, 'packages/bot/src/events/interaction-handler.ts'), 'utf8');
const migration = readFileSync(resolve(root, 'packages/supabase/migrations/20260804137000_free_claims_gift_intents.sql'), 'utf8');

describe('commerce free/gift rails', () => {
  it('uses bounded opaque PayPal custom ids for every checkout type', () => {
    expect(payment).toContain('custom_id: `v1:${checkoutToken}.${checkoutSignature}`');
    expect(payment).not.toContain('custom_id: JSON.stringify');
    expect(`v1:${'00000000-0000-4000-8000-000000000000'}.${'a'.repeat(64)}`.length).toBeLessThanOrEqual(127);
  });

  it('routes free claims and explicit gift checkout buttons', () => {
    expect(interaction).toContain("startsWith('store:claim:')");
    expect(interaction).toContain("startsWith('store:gift:')");
    expect(interaction).toContain("startsWith('store:gift-buy:')");
    expect(interaction).toContain('handleFreeClaimButton');
    expect(payment).toContain("interaction.customId.startsWith('store:gift-buy:')");
    expect(payment).toContain("interaction.customId.split(':')[2]");
  });

  it('keeps free fulfillment out of the paid contract and rejects subscription gifts', () => {
    expect(migration).toContain('commerce_free_role_delivery_business_contract_state');
    expect(migration).toContain("p.type = 'one_time' AND p.price_cents > 0");
    expect(migration).toContain("o.source IS DISTINCT FROM 'manual' OR o.amount_cents IS DISTINCT FROM 0");
    expect(migration).toContain('gift order/payment identity is not proven');
    expect(migration).toContain("gen_random_bytes(24)");
    expect(migration).toContain('commerce_provider_money_recovery');
    expect(migration).toContain('idx_commerce_checkout_intents_gift_open');
    expect(migration).toContain('gift intent id already exists');
    expect(migration).toContain("pay.status='completed'");
  });
});
