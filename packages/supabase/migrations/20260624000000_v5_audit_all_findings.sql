-- V5 Audit — All findings remediation
-- Fixes: 4.1 (negative amount guard), 4.2 (INT→BIGINT), 3.1 (composite license lookup)

-- ────────────────────────────────────────────────────────────
-- §4.1 + §4.2: Harden economy RPCs — reject negative/zero amounts, widen to BIGINT
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION economy_add_balance(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount BIGINT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- V5 Audit §4.1: Guard against negative/zero amounts
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive, got %', p_amount;
  END IF;

  INSERT INTO public.economy_wallets (guild_id, user_id, wallet, updated_at)
  VALUES (p_guild_id, p_user_id, p_amount, now())
  ON CONFLICT (guild_id, user_id)
  DO UPDATE SET wallet = public.economy_wallets.wallet + p_amount, updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION economy_subtract_balance(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount BIGINT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- V5 Audit §4.1: Guard against negative/zero amounts
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive, got %', p_amount;
  END IF;

  UPDATE public.economy_wallets
  SET wallet = wallet - p_amount, updated_at = now()
  WHERE guild_id = p_guild_id AND user_id = p_user_id AND wallet >= p_amount;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;
END;
$$;

-- Maintain REVOKE (defense-in-depth — these are already revoked by v42 but
-- restate for safety after CREATE OR REPLACE)
REVOKE ALL ON FUNCTION economy_add_balance(text, text, bigint) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION economy_subtract_balance(text, text, bigint) FROM public, anon, authenticated;


-- ────────────────────────────────────────────────────────────
-- §3.1: Composite license lookup RPC — collapses 4 sequential queries into 1
-- Returns key + entitlement + product config + customer in a single call.
-- The atomic device-validation RPC (license_validate_device) stays separate
-- because it needs FOR UPDATE row locking.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION license_validate_lookup(
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
  -- 1. Look up key by hash
  SELECT * INTO v_key
    FROM public.license_keys
    WHERE key_hash = p_key_hash
    LIMIT 1;

  IF v_key IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- 2. Look up entitlement
  SELECT * INTO v_entitlement
    FROM public.entitlements
    WHERE license_key_id = v_key.id
    LIMIT 1;

  -- 3. Look up product license config
  SELECT * INTO v_config
    FROM public.product_license_config
    WHERE product_id = p_product_id
    LIMIT 1;

  -- 4. Look up customer
  SELECT discord_username, discord_id INTO v_customer
    FROM public.customers
    WHERE id = v_key.customer_id
    LIMIT 1;

  -- 5. Look up product guild_id (for fraud checks)
  SELECT guild_id INTO v_product
    FROM public.products
    WHERE id = p_product_id
    LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    -- Key fields
    'key_id', v_key.id,
    'key_status', v_key.status,
    'key_product_id', v_key.product_id,
    'key_customer_id', v_key.customer_id,
    'key_failed_attempts', COALESCE(v_key.failed_attempts, 0),
    -- Entitlement fields
    'entitlement_id', v_entitlement.id,
    'entitlement_status', v_entitlement.status,
    'entitlement_expires_at', v_entitlement.expires_at,
    -- Config fields (nullable — product may not have license config)
    'config_max_devices', v_config.max_devices,
    'config_device_policy', v_config.device_policy,
    'config_feature_flags', v_config.feature_flags,
    'config_tier', v_config.tier,
    'config_heartbeat_interval_seconds', v_config.heartbeat_interval_seconds,
    -- Customer fields (nullable)
    'customer_discord_username', v_customer.discord_username,
    'customer_discord_id', v_customer.discord_id,
    -- Product guild_id (for fraud checks)
    'product_guild_id', v_product.guild_id
  );
END;
$$;

REVOKE ALL ON FUNCTION license_validate_lookup(text, uuid) FROM public, anon, authenticated;
