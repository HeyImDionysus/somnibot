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

  it('creates proof evidence before replay ranking and never reactivates proved rows', () => {
    const proofTable = migration.indexOf(
      'CREATE TABLE IF NOT EXISTS public.commerce_checkout_deactivation_proofs',
    );
    const ranking = migration.indexOf('WITH ranked AS');
    const proofRetirement = migration.indexOf(
      'UPDATE public.orders AS proved_order',
    );
    const rankingDefinition = migration.slice(
      ranking,
      migration.indexOf(
        'CREATE UNIQUE INDEX uniq_orders_pending_one_time_checkout',
      ),
    );

    expect(proofTable).toBeGreaterThan(0);
    expect(proofTable).toBeLessThan(ranking);
    expect(proofRetirement).toBeGreaterThan(proofTable);
    expect(proofRetirement).toBeLessThan(ranking);
    expect(rankingDefinition).toContain('commerce_checkout_deactivation_proofs');
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
    const pendingProofCheck = purgeDefinition.indexOf(
      'commerce_checkout_deactivation_proofs',
      pendingOrderCancellation,
    );
    const postGatePendingCancellation = purgeDefinition.indexOf(
      "paid_order.status = 'pending';",
      pendingGate,
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
    expect(purgeDefinition).toMatch(
      /paid_order\.status IN\s*\(\s*'pending'\s*,\s*'completed'\s*,\s*'pending_review'\s*\)/i,
    );
    expect(entitlementCancellation).toBeGreaterThan(orderLock);
    expect(pendingOrderCancellation).toBeGreaterThan(orderLock);
    expect(pendingProofCheck).toBeGreaterThan(pendingOrderCancellation);
    expect(pendingProofCheck).toBeLessThan(pendingGate);
    expect(entitlementCancellation).toBeGreaterThan(pendingOrderCancellation);
    expect(postGatePendingCancellation).toBeGreaterThan(pendingGate);
    expect(completedOrderCancellation).toBeGreaterThan(pendingGate);
    expect(completedOrderCancellation).toBeGreaterThan(postGatePendingCancellation);
    expect(paymentDelete).toBeGreaterThan(completedOrderCancellation);
  });

  it('guards checkout retirement and provides a private proof-backed RPC', () => {
    expect(migration).toContain('commerce_deactivate_pending_checkout');
    expect(migration).toContain('commerce_checkout_deactivation_proofs');
    expect(migration).toContain('authenticated callers cannot retire an active checkout');
    expect(migration).toContain(
      'authenticated callers cannot rewrite a provider-payable checkout',
    );
    expect(migration).toContain(
      'authenticated callers cannot delete a provider-payable checkout',
    );
    expect(migration).toMatch(
      /CREATE TRIGGER commerce_orders_normalize_checkout_active\s+BEFORE INSERT OR UPDATE OR DELETE/i,
    );
    expect(migration).toMatch(
      /OLD\.status IN\s*\(\s*'pending'\s*,\s*'completed'\s*,\s*'pending_review'\s*\)/i,
    );
    expect(migration).toMatch(
      /CURRENT_USER IN\s*\(\s*'anon'\s*,\s*'authenticated'\s*,\s*'service_role'\s*\)/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.commerce_deactivate_pending_checkout[\s\S]+FROM PUBLIC, anon, authenticated/i,
    );
  });

  it('blocks durable paid work before and during a new checkout reservation', () => {
    const blockerDefinition = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.commerce_find_checkout_blocker',
      ),
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.commerce_inspect_checkout_blocker',
      ),
    );
    expect(blockerDefinition).toContain('pg_advisory_xact_lock');
    expect(blockerDefinition).toContain('commerce_fulfillment_holds');
    expect(blockerDefinition).toContain("'paid_hold'");
    expect(blockerDefinition).toContain("'provider_checkout'");
    expect(blockerDefinition).toContain("'paid_fulfillment'");
    expect(blockerDefinition).toContain("paid_order.status IN ('completed', 'pending_review')");
    expect(blockerDefinition).not.toContain('alert.resolved');
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.commerce_inspect_checkout_blocker\(\s*TEXT,\s*UUID,\s*UUID\s*\) TO service_role/i,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER commerce_orders_reservation_guard\s+BEFORE INSERT OR UPDATE OF checkout_active/i,
    );
    expect(migration).toContain('commerce_checkout_blocked');
  });

  it('owns durable per-order outward event and receipt intent state', () => {
    expect(migration).toContain('commerce_fulfillment_outward_intents');
    expect(migration).toContain('outward_generation_id');
    expect(migration).toContain('commerce_begin_fulfillment_outward_intent');
    expect(migration).toContain('commerce_resume_fulfillment_outward_intent');
    expect(migration).toContain('commerce_finish_fulfillment_outward_intent');
    expect(migration).toContain("'sending', 'sent', 'uncertain'");
    for (const intentKind of [
      'subscription_renewed_event',
      'subscription_cancelled_event',
      'subscription_cancelled_dm',
      'subscription_payment_failed_lapsed_event',
      'subscription_payment_failed_event',
      'subscription_payment_failed_dm',
      'subscription_suspended_event',
      'subscription_suspended_dm',
    ]) {
      expect(migration).toContain(`'${intentKind}'`);
    }
    expect(migration).toMatch(
      /p_outward_generation_id[\s\S]+outward_generation_id IS DISTINCT FROM p_outward_generation_id/i,
    );
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
    expect(migration).toMatch(
      /ALTER TABLE public\.commerce_role_delivery_intents[\s\S]+ADD COLUMN IF NOT EXISTS outward_generation_id UUID/i,
    );
    expect(migration).toMatch(
      /ALTER TABLE public\.bot_action_queue[\s\S]+ADD COLUMN IF NOT EXISTS outward_generation_id UUID/i,
    );
    expect(migration).toContain('commerce_revoke_subscription_fulfillment');
    expect(migration).toContain('commerce_start_payment_failure_grace_fulfillment');
    expect(migration).toContain('commerce_prepare_action_outward_generation');
  });

  it('fences every lifecycle outward effect to the current accepted generation', () => {
    const classifier = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.commerce_classify_lifecycle_outward_authority',
      ),
      migration.indexOf(
        'REVOKE ALL ON FUNCTION public.commerce_classify_lifecycle_outward_authority',
      ),
    );

    for (const intentKind of [
      'subscription_renewed_event',
      'subscription_cancelled_event',
      'subscription_cancelled_dm',
      'subscription_payment_failed_lapsed_event',
      'subscription_payment_failed_event',
      'subscription_payment_failed_dm',
      'subscription_suspended_event',
      'subscription_suspended_dm',
    ]) {
      expect(classifier).toContain(`'${intentKind}'`);
    }
    expect(classifier).toContain('commerce_subscription_lifecycle_events');
    expect(classifier).toContain("event_row.disposition = 'accepted'");
    expect(classifier).toContain('commerce_subscription_lifecycle_heads');
    expect(classifier).toContain(
      'v_head.last_webhook_event_id IS DISTINCT FROM v_event.webhook_event_id',
    );
    expect(classifier).toContain(
      'v_head.generation IS DISTINCT FROM v_event.generation',
    );
    expect(classifier).toContain("RETURN 'superseded'");

    const generatedBegin = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.commerce_begin_fulfillment_outward_intent(',
        migration.indexOf(
          'CREATE OR REPLACE FUNCTION public.commerce_classify_lifecycle_outward_authority',
        ),
      ),
      migration.indexOf(
        'REVOKE ALL ON FUNCTION public.commerce_begin_fulfillment_outward_intent(',
        migration.indexOf(
          'CREATE OR REPLACE FUNCTION public.commerce_classify_lifecycle_outward_authority',
        ),
      ),
    );
    expect(generatedBegin).toMatch(
      /p_intent_kind IN\s*\(\s*'subscription_cancelled_event'\s*,\s*'subscription_cancelled_dm'\s*\)[\s\S]+ARRAY\[\s*'subscription_cancelled_event'\s*,\s*'subscription_cancelled_dm'\s*\]::TEXT\[\]/i,
    );

    const actionClassifier = migration.slice(
      migration.lastIndexOf(
        'CREATE OR REPLACE FUNCTION public.commerce_classify_action_outward_state',
      ),
      migration.lastIndexOf(
        'REVOKE ALL ON FUNCTION public.commerce_classify_action_outward_state',
      ),
    );
    expect(actionClassifier).toMatch(
      /v_action\.action = 'fulfill_cancellation'[\s\S]+outward\.intent_kind IN\s*\(\s*'subscription_cancelled_event'\s*,\s*'subscription_cancelled_dm'\s*\)/i,
    );
    expect(actionClassifier).toMatch(
      /v_action\.action = 'fulfill_suspension'[\s\S]+fulfillment_type' = 'subscription_suspended'[\s\S]+outward\.intent_kind IN\s*\(\s*'subscription_suspended_event'\s*,\s*'subscription_suspended_dm'\s*\)/i,
    );
  });

  it('defers provider cancellation fulfillment until the paid-through boundary', () => {
    const lifecycleAction = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.commerce_create_or_recover_subscription_lifecycle_action',
      ),
      migration.indexOf(
        'REVOKE ALL ON FUNCTION public.commerce_create_or_recover_subscription_lifecycle_action',
      ),
    );

    expect(lifecycleAction).toMatch(
      /v_next_retry_at := CASE[\s\S]+BILLING\.SUBSCRIPTION\.CANCELLED[\s\S]+provider_paid_through_at > pg_catalog\.clock_timestamp\(\)[\s\S]+THEN v_event\.provider_paid_through_at/i,
    );
    expect(lifecycleAction).toMatch(
      /INSERT INTO public\.bot_action_queue[\s\S]+next_retry_at[\s\S]+v_next_retry_at/i,
    );
  });

  it('persists a critical operator alert when a rotated key loses its receipt carrier', () => {
    expect(migration).toContain('commerce_license_rotation_delivery_held');
    expect(migration).toContain('uniq_alerts_unresolved_license_rotation_delivery');
    expect(migration).toContain(
      'commerce_rotate_license_and_stage_receipt: held delivery alert was not persisted',
    );
  });

  it('serializes every non-commerce access activation against payable checkouts', () => {
    expect(migration).toContain('commerce_guard_noncommerce_entitlement_activation');
    expect(migration).toMatch(
      /CREATE TRIGGER commerce_entitlements_checkout_guard\s+BEFORE INSERT OR UPDATE/i,
    );
    const activationGuard = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.commerce_guard_noncommerce_entitlement_activation',
      ),
      migration.indexOf(
        'REVOKE ALL ON FUNCTION public.commerce_guard_noncommerce_entitlement_activation',
      ),
    );
    expect(activationGuard).toContain('pg_advisory_xact_lock');
    expect(activationGuard).toContain('commerce_checkout_deactivation_proofs');
    expect(activationGuard).toContain("'manual', 'giveaway', 'automation'");
    expect(activationGuard).toContain("'active', 'pending', 'grace_period', 'suspended'");
  });
});
