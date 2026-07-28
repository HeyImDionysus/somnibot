import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../supabase/migrations/20260727041000_checkout_double_charge_rails.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('checkout double-charge migration safety contracts', () => {
  it('preserves an existing active checkout before ranking later recovery rows', () => {
    expect(migration).toMatch(
      /ORDER BY\s+paid_order\.checkout_active DESC,\s+paid_order\.created_at DESC,\s+paid_order\.id DESC/i,
    );
  });

  it('redefines guild purge to lock and delete holds then claims before paid parents', () => {
    const purgeDefinition = migration.slice(
      migration.lastIndexOf('CREATE OR REPLACE FUNCTION public.purge_guild_data'),
    );
    const orderLock = purgeDefinition.indexOf('PERFORM paid_order.id');
    const entitlementCancellation = purgeDefinition.indexOf(
      'UPDATE public.entitlements AS entitlement',
    );
    const pendingGate = purgeDefinition.indexOf('IF v_pending > 0 THEN');
    const pendingOrderCancellation = purgeDefinition.indexOf(
      'UPDATE public.orders AS paid_order',
    );
    const completedOrderCancellation = purgeDefinition.lastIndexOf(
      'UPDATE public.orders AS paid_order',
    );
    const paymentDelete = purgeDefinition.indexOf('DELETE FROM public.payments');
    const holdDelete = migration.lastIndexOf(
      'DELETE FROM public.commerce_fulfillment_holds',
    );
    const claimDelete = migration.lastIndexOf(
      'DELETE FROM public.commerce_fulfillment_claims',
    );
    const outwardDelete = migration.lastIndexOf(
      'DELETE FROM public.commerce_fulfillment_outward_intents',
    );
    const proofDelete = migration.lastIndexOf(
      'DELETE FROM public.commerce_checkout_deactivation_proofs',
    );
    const entitlementDelete = migration.lastIndexOf('DELETE FROM public.entitlements');
    const orderDelete = migration.lastIndexOf('DELETE FROM public.orders');

    expect(holdDelete).toBeGreaterThan(0);
    expect(claimDelete).toBeGreaterThan(holdDelete);
    expect(outwardDelete).toBeGreaterThan(claimDelete);
    expect(proofDelete).toBeGreaterThan(outwardDelete);
    expect(entitlementDelete).toBeGreaterThan(proofDelete);
    expect(orderDelete).toBeGreaterThan(entitlementDelete);
    expect(orderLock).toBeGreaterThan(0);
    expect(entitlementCancellation).toBeGreaterThan(orderLock);
    expect(pendingOrderCancellation).toBeGreaterThan(orderLock);
    expect(entitlementCancellation).toBeGreaterThan(pendingOrderCancellation);
    expect(completedOrderCancellation).toBeGreaterThan(pendingGate);
    expect(paymentDelete).toBeGreaterThan(completedOrderCancellation);
  });

  it('guards checkout retirement and provides a private proof-backed RPC', () => {
    expect(migration).toContain('commerce_deactivate_pending_checkout');
    expect(migration).toContain('commerce_checkout_deactivation_proofs');
    expect(migration).toContain('authenticated callers cannot retire an active checkout');
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.commerce_deactivate_pending_checkout[\s\S]+FROM PUBLIC, anon, authenticated/i,
    );
  });

  it('owns durable per-order outward event and receipt intent state', () => {
    expect(migration).toContain('commerce_fulfillment_outward_intents');
    expect(migration).toContain('commerce_begin_fulfillment_outward_intent');
    expect(migration).toContain('commerce_resume_fulfillment_outward_intent');
    expect(migration).toContain('commerce_finish_fulfillment_outward_intent');
    expect(migration).toContain("'sending', 'sent', 'uncertain'");
    const resumeDefinition = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.commerce_resume_fulfillment_outward_intent',
      ),
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.commerce_finish_fulfillment_outward_intent',
      ),
    );
    expect(resumeDefinition).toContain('FOR UPDATE');
    expect(resumeDefinition).toContain("'disposition', 'absent'");
    expect(resumeDefinition).toContain(
      'RETURN public.commerce_begin_fulfillment_outward_intent',
    );
  });
});
