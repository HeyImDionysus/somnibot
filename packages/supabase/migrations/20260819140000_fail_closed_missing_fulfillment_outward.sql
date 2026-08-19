CREATE OR REPLACE FUNCTION public.commerce_classify_action_outward_state(
  p_action_id UUID,
  p_claim_token UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action public.bot_action_queue%ROWTYPE;
  v_intent public.commerce_role_delivery_intents%ROWTYPE;
  v_generation UUID;
  v_order_id UUID;
  v_required_kinds TEXT[];
  v_required_count INTEGER;
  v_resolved_count INTEGER;
  v_has_legacy_rows BOOLEAN := false;
BEGIN
  SELECT queue.*
    INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = p_action_id
     AND queue.status = 'processing'
     AND queue.claim_token = p_claim_token
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'stale_claim';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-role-delivery-action:' || p_action_id::TEXT,
      0
    )
  );
  SELECT intent.*
    INTO v_intent
    FROM public.commerce_role_delivery_intents AS intent
   WHERE intent.action_id = p_action_id
      OR intent.cleanup_action_id = p_action_id
   ORDER BY CASE WHEN intent.action_id = p_action_id THEN 0 ELSE 1 END
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    -- A bound attempt with a live mutation token owns this carrier. Generic
    -- queue finalization/recovery must never run behind the binder and
    -- reclassify that in-flight attempt through the legacy no-intent path.
    IF v_intent.mutation_token IS NOT NULL
       OR v_intent.cleanup_mutation_token IS NOT NULL THEN
      RETURN 'intent_raced';
    END IF;
    IF v_intent.action_id IS DISTINCT FROM p_action_id
       OR v_intent.contract_kind IS DISTINCT FROM 'paid'
       OR v_intent.delivery_confirmed_at IS NULL
       OR v_intent.last_delivery_outcome IS DISTINCT FROM 'live'
    THEN
      RETURN 'delegate';
    END IF;
    v_generation := v_intent.outward_generation_id;
    v_order_id := v_intent.order_id;
    IF v_action.guild_id IS DISTINCT FROM v_intent.guild_id
       OR v_action.payload ->> 'guild_id' IS DISTINCT FROM v_intent.guild_id
       OR v_action.payload ->> 'order_id' IS DISTINCT FROM v_intent.order_id::TEXT THEN
      RETURN 'operator_held';
    END IF;
    IF v_action.action = 'fulfill_purchase'
       AND v_action.payload ->> 'fulfillment_type' = 'one_time_purchase' THEN
      v_required_kinds := ARRAY[
        'purchase_completed_event',
        'receipt_dm'
      ]::TEXT[];
    ELSIF v_action.action = 'fulfill_subscription'
       AND v_action.payload ->> 'fulfillment_type' = 'subscription_activated' THEN
      v_required_kinds := ARRAY[
        'subscription_activated_event',
        'receipt_dm'
      ]::TEXT[];
    ELSIF v_action.action = 'fulfill_subscription'
       AND v_action.payload ->> 'fulfillment_type' = 'subscription_renewed' THEN
      v_required_kinds := ARRAY['subscription_renewed_event']::TEXT[];
    ELSE
      RETURN 'operator_held';
    END IF;
  ELSE
    -- Fresh statement under the action/advisory lock is the no-intent race
    -- recheck. A binder cannot commit behind this classification.
    PERFORM 1
      FROM public.commerce_role_delivery_intents AS intent
     WHERE intent.action_id = p_action_id
        OR intent.cleanup_action_id = p_action_id;
    IF FOUND THEN
      RETURN 'intent_raced';
    END IF;

    v_generation := v_action.outward_generation_id;
    IF v_generation IS NULL THEN
      RETURN 'delegate';
    END IF;
    IF v_action.lane IS DISTINCT FROM 'commerce'
       OR pg_catalog.jsonb_typeof(v_action.payload) IS DISTINCT FROM 'object'
       OR v_action.payload ->> 'guild_id' IS DISTINCT FROM v_action.guild_id
       OR v_action.payload ->> 'order_id' IS NULL
       OR v_action.payload ->> 'order_id'
            !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RETURN 'operator_held';
    END IF;
    v_order_id := (v_action.payload ->> 'order_id')::UUID;
    IF v_action.action = 'deliver_receipt' THEN
      v_required_kinds := ARRAY['receipt_dm']::TEXT[];
    ELSIF v_action.action = 'fulfill_cancellation'
       AND v_action.payload ->> 'fulfillment_type' = 'subscription_cancelled' THEN
      v_required_kinds := ARRAY[
        'subscription_cancelled_event',
        'subscription_cancelled_dm'
      ]::TEXT[];
    ELSIF v_action.action = 'fulfill_suspension'
       AND v_action.payload ->> 'fulfillment_type' = 'subscription_suspended' THEN
      v_required_kinds := ARRAY[
        'subscription_suspended_event',
        'subscription_suspended_dm'
      ]::TEXT[];
    ELSIF v_action.action = 'fulfill_suspension'
       AND v_action.payload ->> 'fulfillment_type' = 'subscription_payment_failed' THEN
      v_required_kinds := ARRAY[
        'subscription_payment_failed_lapsed_event',
        'subscription_payment_failed_event',
        'subscription_payment_failed_dm'
      ]::TEXT[];
    ELSE
      RETURN 'operator_held';
    END IF;
  END IF;

  v_required_count := pg_catalog.cardinality(v_required_kinds);
  IF v_generation IS NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.commerce_fulfillment_outward_intents AS outward
       WHERE outward.order_id = v_order_id
         AND outward.guild_id = v_action.guild_id
         AND outward.outward_generation_id IS NULL
         AND outward.intent_kind = ANY(v_required_kinds)
    ) INTO v_has_legacy_rows;
    IF NOT v_has_legacy_rows THEN
      RETURN 'requeue';
    END IF;
  END IF;

  -- Lock every existing required row in deterministic order.  A fresh creator
  -- cannot pass its carrier FOR SHARE while this function owns the action.
  PERFORM outward.id
    FROM public.commerce_fulfillment_outward_intents AS outward
   WHERE outward.order_id = v_order_id
     AND outward.outward_generation_id IS NOT DISTINCT FROM v_generation
     AND outward.intent_kind = ANY(v_required_kinds)
   ORDER BY outward.id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM public.commerce_fulfillment_outward_intents AS outward
     WHERE outward.order_id = v_order_id
       AND outward.outward_generation_id IS NOT DISTINCT FROM v_generation
       AND outward.intent_kind = ANY(v_required_kinds)
       AND outward.guild_id IS DISTINCT FROM v_action.guild_id
  ) THEN
    RETURN 'operator_held';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.commerce_fulfillment_outward_intents AS outward
     WHERE outward.order_id = v_order_id
       AND outward.guild_id = v_action.guild_id
       AND outward.outward_generation_id IS NOT DISTINCT FROM v_generation
       AND outward.intent_kind = ANY(v_required_kinds)
       AND outward.state = 'superseded'
       AND NOT (
         (
           v_action.action = 'fulfill_subscription'
           AND v_action.payload ->> 'fulfillment_type' = 'subscription_renewed'
           AND outward.intent_kind = 'subscription_renewed_event'
         )
          OR (
            v_action.action = 'fulfill_cancellation'
            AND v_action.payload ->> 'fulfillment_type' = 'subscription_cancelled'
            AND outward.intent_kind IN (
              'subscription_cancelled_event',
              'subscription_cancelled_dm'
            )
          )
          OR (
            v_action.action = 'fulfill_suspension'
            AND v_action.payload ->> 'fulfillment_type' = 'subscription_payment_failed'
            AND outward.intent_kind IN (
              'subscription_payment_failed_lapsed_event',
              'subscription_payment_failed_event',
              'subscription_payment_failed_dm'
            )
          )
          OR (
            v_action.action = 'fulfill_suspension'
            AND v_action.payload ->> 'fulfillment_type' = 'subscription_suspended'
            AND outward.intent_kind IN (
              'subscription_suspended_event',
              'subscription_suspended_dm'
            )
          )
       )
  ) THEN
    RETURN 'operator_held';
  END IF;

  UPDATE public.commerce_fulfillment_outward_intents AS outward
     SET state = 'uncertain',
         attempt_token = NULL,
         uncertain_at = COALESCE(
           outward.uncertain_at,
           pg_catalog.clock_timestamp()
         ),
         last_error = COALESCE(
           outward.last_error,
           'queue finalization observed an unresolved external attempt'
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE outward.order_id = v_order_id
     AND outward.guild_id = v_action.guild_id
     AND outward.outward_generation_id IS NOT DISTINCT FROM v_generation
     AND outward.intent_kind = ANY(v_required_kinds)
     AND outward.state = 'sending';

  IF EXISTS (
    SELECT 1
      FROM public.commerce_fulfillment_outward_intents AS outward
     WHERE outward.order_id = v_order_id
       AND outward.guild_id = v_action.guild_id
       AND outward.outward_generation_id IS NOT DISTINCT FROM v_generation
       AND outward.intent_kind = ANY(v_required_kinds)
       AND outward.state = 'uncertain'
  ) THEN
    RETURN 'operator_held';
  END IF;

  SELECT pg_catalog.count(*)
    INTO v_resolved_count
    FROM public.commerce_fulfillment_outward_intents AS outward
   WHERE outward.order_id = v_order_id
     AND outward.guild_id = v_action.guild_id
     AND outward.outward_generation_id IS NOT DISTINCT FROM v_generation
     AND outward.intent_kind = ANY(v_required_kinds)
     AND outward.state IN ('sent', 'superseded');
  IF v_resolved_count = v_required_count THEN
    RETURN 'complete';
  END IF;
  RETURN 'requeue';
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_classify_action_outward_state(
  UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;
