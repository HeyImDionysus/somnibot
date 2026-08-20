import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('../../../supabase/migrations/20260819211000_promotion_checkout_redemption.sql', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');

describe('promotion checkout redemption migration', () => {
  it('replaces the disabled write guard with constrained promotion writes', () => {
    expect(sql).toContain('DROP TRIGGER IF EXISTS commerce_promotions_disabled_write ON public.promotions');
    expect(sql).toContain('promotions_guild_coupon_code_key');
    expect(sql).toContain('promotions_integer_discount_value');
    expect(sql).toContain('ALTER COLUMN current_uses SET NOT NULL');
  });

  it('locks and freezes one authoritative integer-cent checkout price', () => {
    const reserve = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.commerce_reserve_checkout_pricing'),
      sql.indexOf('CREATE OR REPLACE FUNCTION public.commerce_create_and_bind_active_paid_checkout'),
    );
    expect(reserve).toContain('FROM public.commerce_checkout_intents');
    expect(reserve).toContain('FOR UPDATE');
    expect(reserve).toContain('FROM public.promotions');
    expect(reserve).toContain('pending_order.status = \'pending\'');
    expect(reserve).toContain('reserved.order_id IS NULL');
    expect(reserve).toContain('pg_advisory_xact_lock');
    expect(reserve.indexOf('pg_advisory_xact_lock')).toBeLessThan(reserve.indexOf("IF v_code = '' THEN"));
    expect(reserve).toContain('prior_intent.final_amount_cents IS NOT NULL');
    expect(reserve).toContain('SET promotion_id = v_promotion.id');
    expect(reserve).toContain('final_amount_cents = v_final');
  });

  it('binds the promotion to the order in the checkout transaction', () => {
    expect(sql).toContain('SELECT v_intent.final_amount_cents, currency');
    expect(sql).toContain('SET promotion_id = v_intent.promotion_id');
    expect(sql).toContain('discount_cents = v_intent.discount_cents');
    expect(sql).toContain('commerce_create_and_bind_active_paid_checkout: authoritative pricing mismatch');
    expect(sql).toContain('TO service_role');
  });

  it('recalculates both prior and new promotion usage on order transitions', () => {
    expect(sql).toContain("IF TG_OP <> 'INSERT' AND OLD.promotion_id IS NOT NULL THEN");
    expect(sql).toContain("IF TG_OP <> 'DELETE'");
    expect(sql).toContain('AFTER INSERT OR DELETE ON public.orders');
    expect(sql).toContain('AFTER UPDATE OF status, promotion_id ON public.orders');
  });
});
