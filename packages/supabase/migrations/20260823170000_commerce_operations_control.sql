BEGIN;

CREATE TABLE IF NOT EXISTS public.commerce_product_launch_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  is_tutorial boolean NOT NULL DEFAULT false,
  tutorial_visibility text NOT NULL DEFAULT 'visible'
    CHECK (tutorial_visibility IN ('visible', 'hidden', 'disabled')),
  environment text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'live')),
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'validating', 'sandbox_verifying', 'ready', 'live', 'failed', 'retired')),
  stages jsonb NOT NULL DEFAULT '{"product":"pending","policy":"pending","pricing":"pending","integration":"pending","sandbox_transaction":"pending","webhook":"pending","entitlement":"pending","fulfillment":"pending","reversal":"pending"}'::jsonb,
  launch_receipt jsonb,
  launch_receipt_hash text,
  last_error text,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_at timestamptz,
  activated_at timestamptz,
  UNIQUE (guild_id, product_id),
  CONSTRAINT commerce_product_launch_version_positive CHECK (version > 0),
  CONSTRAINT commerce_product_launch_receipt_hash CHECK (
    launch_receipt_hash IS NULL OR launch_receipt_hash ~ '^[a-f0-9]{64}$'
  )
);

CREATE TABLE IF NOT EXISTS public.commerce_revenue_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN (
    'paypal_event', 'reconciliation', 'fulfillment', 'role_delivery', 'license_delivery',
    'download', 'refund', 'cancellation', 'dispute', 'fraud', 'identity'
  )),
  source_id text NOT NULL,
  category text NOT NULL CHECK (category IN (
    'unattributed_paypal_event', 'reconciliation_difference', 'stalled_fulfillment',
    'failed_role_delivery', 'failed_license_delivery', 'download_problem',
    'refund_discrepancy', 'cancellation_discrepancy', 'payment_dispute',
    'fraud_hold', 'customer_identity_conflict'
  )),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'in_progress', 'resolved', 'compensated', 'dismissed')),
  owner_id text,
  operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  entitlement_id uuid REFERENCES public.entitlements(id) ON DELETE SET NULL,
  title text NOT NULL,
  safe_detail text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution_code text,
  resolution_note text,
  version integer NOT NULL DEFAULT 1,
  detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  UNIQUE (guild_id, source_kind, source_id),
  CONSTRAINT commerce_revenue_exception_version_positive CHECK (version > 0),
  CONSTRAINT commerce_revenue_exception_resolution_coherent CHECK (
    (state IN ('open', 'in_progress') AND resolved_at IS NULL)
    OR (state IN ('resolved', 'compensated', 'dismissed') AND resolved_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.commerce_revenue_exception_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exception_id uuid NOT NULL REFERENCES public.commerce_revenue_exceptions(id) ON DELETE CASCADE,
  guild_id text NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.commerce_risk_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  exception_id uuid UNIQUE REFERENCES public.commerce_revenue_exceptions(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'investigating', 'confirmed', 'resolved', 'dismissed')),
  fulfillment_action text NOT NULL DEFAULT 'hold'
    CHECK (fulfillment_action IN ('hold', 'continue', 'revoke', 'restore')),
  entitlement_action text NOT NULL DEFAULT 'hold'
    CHECK (entitlement_action IN ('hold', 'continue', 'suspend', 'revoke', 'restore')),
  customer_notification text NOT NULL DEFAULT 'pending'
    CHECK (customer_notification IN ('pending', 'sent', 'not_required', 'failed')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution_note text,
  owner_id text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  CONSTRAINT commerce_risk_case_kind_check CHECK (kind IN (
    'suspected_fraud', 'confirmed_fraud', 'payment_dispute', 'chargeback',
    'ordinary_refund', 'duplicate_payment', 'support_cancellation'
  )),
  CONSTRAINT commerce_risk_case_version_positive CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS public.commerce_risk_effect_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  risk_case_id uuid NOT NULL REFERENCES public.commerce_risk_cases(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  effect_kind text NOT NULL CHECK (effect_kind IN ('fulfillment', 'entitlement', 'notification')),
  requested_action text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed', 'failed', 'compensated')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (risk_case_id, operation_id, effect_kind)
);

CREATE INDEX IF NOT EXISTS idx_commerce_launch_runs_attention
  ON public.commerce_product_launch_runs (guild_id, state, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_one_tutorial_per_guild
  ON public.commerce_product_launch_runs (guild_id)
  WHERE is_tutorial = true;
CREATE INDEX IF NOT EXISTS idx_commerce_revenue_exceptions_attention
  ON public.commerce_revenue_exceptions (guild_id, state, severity, detected_at);
CREATE INDEX IF NOT EXISTS idx_commerce_revenue_exception_events_history
  ON public.commerce_revenue_exception_events (guild_id, exception_id, created_at);
CREATE INDEX IF NOT EXISTS idx_commerce_risk_cases_attention
  ON public.commerce_risk_cases (guild_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_commerce_risk_effect_actions_pending
  ON public.commerce_risk_effect_actions (guild_id, state, created_at);

ALTER TABLE public.commerce_product_launch_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_revenue_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_revenue_exception_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_risk_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_risk_effect_actions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.commerce_product_launch_runs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.commerce_revenue_exceptions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.commerce_revenue_exception_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.commerce_risk_cases FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.commerce_risk_effect_actions FROM PUBLIC, anon, authenticated, service_role;

DROP POLICY IF EXISTS service_role_all ON public.commerce_product_launch_runs;
DROP POLICY IF EXISTS service_role_all ON public.commerce_revenue_exceptions;
DROP POLICY IF EXISTS service_role_all ON public.commerce_revenue_exception_events;
DROP POLICY IF EXISTS service_role_all ON public.commerce_risk_cases;
DROP POLICY IF EXISTS service_role_all ON public.commerce_risk_effect_actions;
CREATE POLICY service_role_all ON public.commerce_product_launch_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON public.commerce_revenue_exceptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON public.commerce_revenue_exception_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON public.commerce_risk_cases
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON public.commerce_risk_effect_actions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.commerce_product_launch_runs TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.commerce_revenue_exceptions TO service_role;
GRANT SELECT, INSERT ON public.commerce_revenue_exception_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.commerce_risk_cases TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.commerce_risk_effect_actions TO service_role;

ALTER TABLE public.commerce_portal_requests
  DROP CONSTRAINT IF EXISTS commerce_portal_requests_type_check;
ALTER TABLE public.commerce_portal_requests
  ADD CONSTRAINT commerce_portal_requests_type_check
  CHECK (type IN ('refund', 'service', 'identity_relink', 'download_help'));

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider_fee_cents integer,
  ADD COLUMN IF NOT EXISTS provider_net_cents integer;
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_provider_amounts_nonnegative;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_provider_amounts_nonnegative CHECK (
    (provider_fee_cents IS NULL OR provider_fee_cents >= 0)
    AND (provider_net_cents IS NULL OR provider_net_cents >= 0)
    AND (provider_fee_cents IS NULL OR provider_net_cents IS NULL
      OR provider_fee_cents + provider_net_cents = amount_cents)
  );

CREATE OR REPLACE FUNCTION public.commerce_capture_alert_exception()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_category text;
  v_source_kind text := 'paypal_event';
  v_exception_id uuid;
BEGIN
  IF NEW.alert_type !~ '^(paypal_|commerce_|license_delivery|download_|entitlement_)' THEN
    RETURN NEW;
  END IF;
  v_category := CASE
    WHEN NEW.alert_type LIKE '%dispute%' THEN 'payment_dispute'
    WHEN NEW.alert_type LIKE '%fraud%' THEN 'fraud_hold'
    WHEN NEW.alert_type LIKE '%reconcil%' THEN 'reconciliation_difference'
    WHEN NEW.alert_type LIKE '%role%' THEN 'failed_role_delivery'
    WHEN NEW.alert_type LIKE '%license%' THEN 'failed_license_delivery'
    WHEN NEW.alert_type LIKE '%download%' THEN 'download_problem'
    WHEN NEW.alert_type LIKE '%refund%' THEN 'refund_discrepancy'
    WHEN NEW.alert_type LIKE '%cancel%' THEN 'cancellation_discrepancy'
    WHEN NEW.alert_type LIKE '%identity%' THEN 'customer_identity_conflict'
    ELSE 'unattributed_paypal_event'
  END;
  v_source_kind := CASE
    WHEN v_category = 'payment_dispute' THEN 'dispute'
    WHEN v_category = 'fraud_hold' THEN 'fraud'
    WHEN v_category = 'reconciliation_difference' THEN 'reconciliation'
    WHEN v_category IN ('failed_role_delivery', 'failed_license_delivery') THEN 'fulfillment'
    WHEN v_category = 'download_problem' THEN 'download'
    WHEN v_category = 'refund_discrepancy' THEN 'refund'
    WHEN v_category = 'cancellation_discrepancy' THEN 'cancellation'
    WHEN v_category = 'customer_identity_conflict' THEN 'identity'
    ELSE 'paypal_event'
  END;
  INSERT INTO public.commerce_revenue_exceptions (
    guild_id, source_kind, source_id, category, severity, title, safe_detail, evidence
  ) VALUES (
    NEW.guild_id, v_source_kind, NEW.id::text, v_category, NEW.severity,
    NEW.title, NEW.message, jsonb_build_object('alert_id', NEW.id, 'alert_type', NEW.alert_type)
  )
  ON CONFLICT (guild_id, source_kind, source_id) DO NOTHING
  RETURNING id INTO v_exception_id;
  IF v_exception_id IS NOT NULL AND v_category IN ('payment_dispute', 'fraud_hold') THEN
    INSERT INTO public.commerce_risk_cases (
      guild_id, exception_id, kind, evidence
    ) VALUES (
      NEW.guild_id,
      v_exception_id,
      CASE WHEN v_category = 'payment_dispute' THEN 'payment_dispute' ELSE 'suspected_fraud' END,
      jsonb_build_object('alert_id', NEW.id, 'alert_type', NEW.alert_type)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_capture_fraud_exception()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_exception_id uuid;
BEGIN
  INSERT INTO public.commerce_revenue_exceptions (
    guild_id, source_kind, source_id, category, severity, order_id, customer_id,
    title, safe_detail, evidence
  ) VALUES (
    NEW.guild_id, 'fraud', NEW.id::text, 'fraud_hold',
    CASE WHEN NEW.severity IN ('info', 'warning', 'critical') THEN NEW.severity ELSE 'warning' END,
    NEW.order_id, NEW.customer_id, 'Fraud signal requires review', NEW.signal_type,
    jsonb_build_object('fraud_signal_id', NEW.id, 'signal_type', NEW.signal_type)
  )
  ON CONFLICT (guild_id, source_kind, source_id) DO NOTHING
  RETURNING id INTO v_exception_id;
  IF v_exception_id IS NOT NULL THEN
    INSERT INTO public.commerce_risk_cases (
      guild_id, exception_id, order_id, customer_id, kind, evidence
    ) VALUES (
      NEW.guild_id, v_exception_id, NEW.order_id, NEW.customer_id,
      'suspected_fraud', jsonb_build_object('fraud_signal_id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_capture_fulfillment_exception()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.commerce_revenue_exceptions (
    guild_id, source_kind, source_id, category, severity, order_id, customer_id,
    title, safe_detail, evidence
  ) VALUES (
    NEW.guild_id, 'fulfillment', NEW.order_id::text, 'stalled_fulfillment', 'critical',
    NEW.order_id, NEW.customer_id, 'Fulfillment is held',
    replace(NEW.hold_reason, '_', ' '),
    jsonb_build_object('hold_reason', NEW.hold_reason, 'product_id', NEW.product_id)
  )
  ON CONFLICT (guild_id, source_kind, source_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commerce_alert_exception_trigger ON public.alerts;
CREATE TRIGGER commerce_alert_exception_trigger
AFTER INSERT ON public.alerts
FOR EACH ROW EXECUTE FUNCTION public.commerce_capture_alert_exception();

DROP TRIGGER IF EXISTS commerce_fraud_exception_trigger ON public.fraud_signals;
CREATE TRIGGER commerce_fraud_exception_trigger
AFTER INSERT ON public.fraud_signals
FOR EACH ROW EXECUTE FUNCTION public.commerce_capture_fraud_exception();

DROP TRIGGER IF EXISTS commerce_fulfillment_exception_trigger ON public.commerce_fulfillment_holds;
CREATE TRIGGER commerce_fulfillment_exception_trigger
AFTER INSERT ON public.commerce_fulfillment_holds
FOR EACH ROW EXECUTE FUNCTION public.commerce_capture_fulfillment_exception();

REVOKE ALL ON FUNCTION public.commerce_capture_alert_exception() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_capture_fraud_exception() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_capture_fulfillment_exception() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.commerce_transition_revenue_exception(
  p_guild_id text,
  p_exception_id uuid,
  p_expected_version integer,
  p_actor_id text,
  p_action text,
  p_to_state text,
  p_resolution_code text DEFAULT NULL,
  p_resolution_note text DEFAULT NULL
)
RETURNS public.commerce_revenue_exceptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before public.commerce_revenue_exceptions%ROWTYPE;
  v_after public.commerce_revenue_exceptions%ROWTYPE;
BEGIN
  IF p_to_state NOT IN ('open', 'in_progress', 'resolved', 'compensated', 'dismissed') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid exception state';
  END IF;
  SELECT * INTO v_before
  FROM public.commerce_revenue_exceptions
  WHERE id = p_exception_id AND guild_id = p_guild_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'exception not found';
  END IF;
  IF v_before.version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'exception version conflict';
  END IF;
  UPDATE public.commerce_revenue_exceptions
  SET state = p_to_state,
      owner_id = CASE WHEN p_to_state = 'in_progress' THEN p_actor_id ELSE owner_id END,
      resolution_code = CASE WHEN p_to_state IN ('resolved', 'compensated', 'dismissed') THEN p_resolution_code ELSE NULL END,
      resolution_note = CASE WHEN p_to_state IN ('resolved', 'compensated', 'dismissed') THEN p_resolution_note ELSE NULL END,
      resolved_at = CASE WHEN p_to_state IN ('resolved', 'compensated', 'dismissed') THEN clock_timestamp() ELSE NULL END,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = v_before.id
  RETURNING * INTO v_after;
  INSERT INTO public.commerce_revenue_exception_events (
    exception_id, guild_id, operation_id, actor_id, action, from_state, to_state, detail
  ) VALUES (
    v_after.id, v_after.guild_id, v_after.operation_id, p_actor_id, p_action,
    v_before.state, v_after.state,
    jsonb_build_object('resolution_code', p_resolution_code, 'resolution_note', p_resolution_note)
  );
  RETURN v_after;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_transition_revenue_exception(
  text, uuid, integer, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_transition_revenue_exception(
  text, uuid, integer, text, text, text, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_transition_risk_case(
  p_guild_id text,
  p_risk_case_id uuid,
  p_expected_version integer,
  p_actor_id text,
  p_action text,
  p_resolution_note text
)
RETURNS public.commerce_risk_cases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before public.commerce_risk_cases%ROWTYPE;
  v_after public.commerce_risk_cases%ROWTYPE;
  v_next_kind text;
  v_terminal boolean;
BEGIN
  SELECT * INTO v_before
  FROM public.commerce_risk_cases
  WHERE id = p_risk_case_id AND guild_id = p_guild_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'risk case not found';
  END IF;
  IF v_before.version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'risk case version conflict';
  END IF;
  v_next_kind := CASE v_before.kind || ':' || p_action
    WHEN 'suspected_fraud:confirm_fraud' THEN 'confirmed_fraud'
    WHEN 'suspected_fraud:dismiss' THEN 'dismissed'
    WHEN 'confirmed_fraud:record_dispute' THEN 'payment_dispute'
    WHEN 'confirmed_fraud:record_chargeback' THEN 'chargeback'
    WHEN 'payment_dispute:record_chargeback' THEN 'chargeback'
    WHEN 'payment_dispute:record_refund' THEN 'ordinary_refund'
    WHEN 'ordinary_refund:dismiss' THEN 'dismissed'
    WHEN 'duplicate_payment:record_refund' THEN 'ordinary_refund'
    WHEN 'support_cancellation:record_refund' THEN 'ordinary_refund'
    WHEN 'support_cancellation:dismiss' THEN 'dismissed'
    ELSE NULL
  END;
  IF v_next_kind IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'risk transition is not allowed';
  END IF;
  v_terminal := v_next_kind IN ('dismissed', 'chargeback', 'ordinary_refund');
  UPDATE public.commerce_risk_cases
  SET kind = CASE WHEN v_next_kind = 'dismissed' THEN kind ELSE v_next_kind END,
      state = CASE WHEN v_next_kind = 'dismissed' THEN 'dismissed' WHEN v_terminal THEN 'resolved' ELSE 'confirmed' END,
      fulfillment_action = CASE v_next_kind
        WHEN 'confirmed_fraud' THEN 'revoke' WHEN 'payment_dispute' THEN 'hold'
        WHEN 'chargeback' THEN 'revoke' WHEN 'ordinary_refund' THEN 'revoke'
        WHEN 'dismissed' THEN 'continue' ELSE fulfillment_action END,
      entitlement_action = CASE v_next_kind
        WHEN 'confirmed_fraud' THEN 'suspend' WHEN 'payment_dispute' THEN 'suspend'
        WHEN 'chargeback' THEN 'revoke' WHEN 'ordinary_refund' THEN 'revoke'
        WHEN 'dismissed' THEN 'continue' ELSE entitlement_action END,
      customer_notification = CASE WHEN v_next_kind = 'dismissed' THEN 'not_required' ELSE 'pending' END,
      resolution_note = p_resolution_note,
      owner_id = p_actor_id,
      operation_id = gen_random_uuid(),
      version = version + 1,
      resolved_at = CASE WHEN v_terminal THEN clock_timestamp() ELSE NULL END,
      updated_at = clock_timestamp()
  WHERE id = v_before.id
  RETURNING * INTO v_after;

  INSERT INTO public.commerce_risk_effect_actions (
    guild_id, risk_case_id, operation_id, effect_kind, requested_action, payload
  ) VALUES
    (v_after.guild_id, v_after.id, v_after.operation_id, 'fulfillment', v_after.fulfillment_action,
      jsonb_build_object('order_id', v_after.order_id, 'payment_id', v_after.payment_id, 'actor_id', p_actor_id)),
    (v_after.guild_id, v_after.id, v_after.operation_id, 'entitlement', v_after.entitlement_action,
      jsonb_build_object('order_id', v_after.order_id, 'customer_id', v_after.customer_id, 'actor_id', p_actor_id)),
    (v_after.guild_id, v_after.id, v_after.operation_id, 'notification',
      CASE WHEN v_after.customer_notification = 'not_required' THEN 'skip' ELSE 'notify' END,
      jsonb_build_object('order_id', v_after.order_id, 'customer_id', v_after.customer_id, 'risk_kind', v_after.kind));
  RETURN v_after;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_transition_risk_case(text, uuid, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_transition_risk_case(text, uuid, integer, text, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_activate_product_launch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_run public.commerce_product_launch_runs%ROWTYPE;
  v_activated_at timestamptz := clock_timestamp();
BEGIN
  IF NEW.active IS NOT TRUE OR OLD.active IS TRUE THEN RETURN NEW; END IF;
  SELECT * INTO v_run
  FROM public.commerce_product_launch_runs
  WHERE guild_id = NEW.guild_id AND product_id = NEW.id
  FOR UPDATE;
  IF NOT FOUND OR v_run.state <> 'ready' OR v_run.launch_receipt_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product launch is not ready';
  END IF;
  UPDATE public.commerce_product_launch_runs
  SET state = 'live', environment = 'live', activated_at = v_activated_at,
      launch_receipt = COALESCE(launch_receipt, '{}'::jsonb) || jsonb_build_object(
        'activation', jsonb_build_object(
          'product_id', NEW.id, 'active', true, 'activated_at', v_activated_at,
          'product_revision', NEW.updated_at
        )
      ),
      updated_by = 'system:product-activation', version = version + 1,
      updated_at = v_activated_at
  WHERE id = v_run.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commerce_product_launch_activation_readback ON public.products;
CREATE TRIGGER commerce_product_launch_activation_readback
AFTER UPDATE OF active ON public.products
FOR EACH ROW EXECUTE FUNCTION public.commerce_activate_product_launch();
REVOKE ALL ON FUNCTION public.commerce_activate_product_launch() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.commerce_create_tutorial_launch(
  p_guild_id text,
  p_actor_id text
)
RETURNS public.commerce_product_launch_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing public.commerce_product_launch_runs%ROWTYPE;
  v_product_id uuid := gen_random_uuid();
  v_run public.commerce_product_launch_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_existing FROM public.commerce_product_launch_runs
  WHERE guild_id = p_guild_id AND is_tutorial = true FOR UPDATE;
  IF FOUND THEN
    UPDATE public.commerce_product_launch_runs
    SET tutorial_visibility = 'visible', updated_by = p_actor_id,
        version = version + 1, updated_at = clock_timestamp()
    WHERE id = v_existing.id RETURNING * INTO v_existing;
    RETURN v_existing;
  END IF;
  INSERT INTO public.products (
    id, guild_id, name, description, type, delivery_type, price_cents, currency,
    granted_role_ids, granted_channel_ids, active, sort_order, metadata
  ) VALUES (
    v_product_id, p_guild_id, 'SomniBot Product Launch Tutorial',
    'Inactive sandbox tutorial for pricing, SDK integration, fulfillment, reversal, and launch verification.',
    'free', 'license_key', 0, 'USD', '{}', '{}', false, 0,
    jsonb_build_object('somnibot_tutorial', jsonb_build_object(
      'schemaVersion', 1, 'sandboxSafe', true, 'walkthrough', jsonb_build_array(
        'pricing', 'fulfillment', 'entitlements', 'sdk_handoff', 'sandbox_purchase',
        'webhook', 'cancellation', 'refund', 'revocation', 'launch_receipt'
      )
    ))
  );
  INSERT INTO public.commerce_product_launch_runs (
    guild_id, product_id, is_tutorial, tutorial_visibility, environment, state,
    created_by, updated_by
  ) VALUES (
    p_guild_id, v_product_id, true, 'visible', 'sandbox', 'draft', p_actor_id, p_actor_id
  ) RETURNING * INTO v_run;
  RETURN v_run;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_create_tutorial_launch(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_create_tutorial_launch(text, text) TO service_role;

COMMIT;
