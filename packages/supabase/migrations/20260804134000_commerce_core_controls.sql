-- Commerce-core runtime controls: fraud thresholds, license recovery policy,
-- and PayPal processing policy. All defaults preserve the existing behavior.

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS paypal_legacy_usd_sale_tolerance boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS paypal_environment text NOT NULL DEFAULT 'sandbox',
  ADD COLUMN IF NOT EXISTS paypal_refund_strategy text NOT NULL DEFAULT 'provider-first',
  ADD COLUMN IF NOT EXISTS paypal_webhook_stale_processing_ms integer NOT NULL DEFAULT 300000,
  ADD COLUMN IF NOT EXISTS paypal_webhook_verify_attempts integer NOT NULL DEFAULT 3;

ALTER TABLE public.guild_config
  DROP CONSTRAINT IF EXISTS guild_config_paypal_environment_check,
  ADD CONSTRAINT guild_config_paypal_environment_check
    CHECK (paypal_environment IN ('sandbox', 'live')),
  DROP CONSTRAINT IF EXISTS guild_config_paypal_refund_strategy_check,
  ADD CONSTRAINT guild_config_paypal_refund_strategy_check
    CHECK (paypal_refund_strategy IN ('provider-first', 'local-first')),
  DROP CONSTRAINT IF EXISTS guild_config_paypal_stale_processing_check,
  ADD CONSTRAINT guild_config_paypal_stale_processing_check
    CHECK (paypal_webhook_stale_processing_ms BETWEEN 60000 AND 86400000),
  DROP CONSTRAINT IF EXISTS guild_config_paypal_verify_attempts_check,
  ADD CONSTRAINT guild_config_paypal_verify_attempts_check
    CHECK (paypal_webhook_verify_attempts BETWEEN 1 AND 10);

ALTER TABLE public.product_license_config
  ADD COLUMN IF NOT EXISTS rotation_policy text NOT NULL DEFAULT 'rotate-and-invalidate',
  ADD COLUMN IF NOT EXISTS self_service_device_removal boolean NOT NULL DEFAULT true;

ALTER TABLE public.product_license_config
  DROP CONSTRAINT IF EXISTS product_license_config_rotation_policy_check,
  ADD CONSTRAINT product_license_config_rotation_policy_check
    CHECK (rotation_policy IN ('rotate-and-invalidate', 'disabled'));

ALTER TABLE public.fraud_rules
  DROP CONSTRAINT IF EXISTS fraud_rules_rule_type_check,
  ADD CONSTRAINT fraud_rules_rule_type_check
    CHECK (rule_type IN (
      'velocity_limit', 'device_limit', 'ip_mismatch', 'failed_payment',
      'critical_incident', 'amount_threshold', 'pattern_match'
    ));
