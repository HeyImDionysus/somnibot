CREATE OR REPLACE FUNCTION public.license_validate_lookup(
  p_key_hash TEXT,
  p_product_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key RECORD;
  v_entitlement RECORD;
  v_config RECORD;
  v_customer RECORD;
  v_product RECORD;
BEGIN
  SELECT * INTO v_key
    FROM public.license_keys
    WHERE key_hash = p_key_hash
    LIMIT 1;

  IF v_key IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT * INTO v_entitlement
    FROM public.entitlements
    WHERE license_key_id = v_key.id
    LIMIT 1;

  SELECT * INTO v_config
    FROM public.product_license_config
    WHERE product_id = p_product_id
    LIMIT 1;

  SELECT discord_username, discord_id INTO v_customer
    FROM public.customers
    WHERE id = v_key.customer_id
    LIMIT 1;

  SELECT
    guild_id,
    metadata -> 'completed_project_licensing' AS licensing_metadata
  INTO v_product
    FROM public.products
    WHERE id = p_product_id
    LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    'key_id', v_key.id,
    'key_status', v_key.status,
    'key_product_id', v_key.product_id,
    'key_customer_id', v_key.customer_id,
    'key_failed_attempts', COALESCE(v_key.failed_attempts, 0),
    'entitlement_id', v_entitlement.id,
    'entitlement_status', v_entitlement.status,
    'entitlement_expires_at', v_entitlement.expires_at,
    'entitlement_grace_period_ends_at', v_entitlement.grace_period_ends_at,
    'entitlement_plan_id', v_entitlement.plan_id,
    'config_max_devices', v_config.max_devices,
    'config_device_policy', v_config.device_policy,
    'config_feature_flags', v_config.feature_flags,
    'config_tier', v_config.tier,
    'config_heartbeat_interval_seconds', v_config.heartbeat_interval_seconds,
    'config_sdk_cache_ttl_ms', v_config.sdk_cache_ttl_ms,
    'config_offline_grace_period_seconds', v_config.offline_grace_period_seconds,
    'config_require_discord_guild_membership', v_config.require_discord_guild_membership,
    'config_license_mode', v_config.license_mode,
    'customer_discord_username', v_customer.discord_username,
    'customer_discord_id', v_customer.discord_id,
    'product_guild_id', v_product.guild_id,
    'product_licensing_metadata', v_product.licensing_metadata
  );
END;
$$;

REVOKE ALL ON FUNCTION public.license_validate_lookup(text, uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.license_validate_lookup(text, uuid)
  TO service_role;
