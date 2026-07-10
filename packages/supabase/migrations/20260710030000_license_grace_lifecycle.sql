-- =============================================================================
-- [commerce] License grace-period lifecycle (W2 hardening)
--
-- A `grace_period` entitlement is a paying customer whose payment failed.
-- Three gaps let that state decay invisibly or persist forever:
--
--   1. Entering grace_period raised no operator-visible signal. The bot now
--      writes an `alerts` row (alert_type = 'entitlement_grace_period') on
--      entry; this migration adds the partial unique index that makes the
--      dedupe atomic at the database (same pattern as
--      uniq_alerts_unresolved_fraud_check_failure, 20260709170000): at most
--      ONE unresolved grace alert per entitlement, concurrent writers get a
--      23505 which the application treats as dedupe success.
--
--   2. The reconciliation sweep selects rows with
--      `grace_period_ends_at < now()` — a grace_period row whose deadline is
--      NULL can never match and sits in grace forever. The application-side
--      writer (EntitlementService.suspend) always sets the deadline, so NULLs
--      can only come from legacy/manual writes; backfill them with a
--      deterministic deadline so the sweep can retire them.
--
--   3. POST /api/license/validate trusted the stale `grace_period` status:
--      a lapsed-but-unreconciled row kept validating until the next 6-hourly
--      sweep. The composite lookup RPC now also returns
--      `entitlement_grace_period_ends_at` so the route can compute the window
--      at validation time and reject a lapsed grace entitlement immediately.
-- =============================================================================

-- ── 1. Atomic dedupe for the grace-period operator alert ────────────────────

-- Defensive cleanup so the unique index can build even if duplicate
-- unresolved rows already exist: keep the newest, resolve the rest.
-- (alert_type 'entitlement_grace_period' first ships with this change, so
-- in practice this is a no-op.)
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY guild_id, (metadata->>'entitlement_id')
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM public.alerts
  WHERE alert_type = 'entitlement_grace_period'
    AND resolved = false
)
UPDATE public.alerts a
   SET resolved    = true,
       resolved_at = now(),
       updated_at  = now()
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_entitlement_grace
  ON public.alerts (guild_id, ((metadata->>'entitlement_id')))
  WHERE alert_type = 'entitlement_grace_period' AND resolved = false;

-- ── 2. Backfill deadline-less grace_period rows ─────────────────────────────

-- Deterministic fallback: 3 days (the default grace window in
-- EntitlementService.suspend) from the row's last update. These rows were
-- invisible to the reconciliation sweep's `grace_period_ends_at < now()`
-- filter and to the validate route's window math.
UPDATE public.entitlements
   SET grace_period_ends_at = COALESCE(updated_at, created_at, now()) + interval '3 days',
       updated_at           = now()
 WHERE status = 'grace_period'
   AND grace_period_ends_at IS NULL;

-- Make the invalid state unrepresentable going forward: a grace_period row
-- without a deadline is invisible to the reconciliation sweep and to the
-- validate route's window math, i.e. a paid entitlement that decays forever.
-- The only application writer (EntitlementService.suspend) sets the deadline
-- in the same UPDATE as the status, so this only rejects future buggy or
-- manual writes — loudly, instead of silently minting a perpetual license.
-- (Runs in the same transaction as the backfill above, so it validates.)
ALTER TABLE public.entitlements
  ADD CONSTRAINT entitlements_grace_period_has_deadline
  CHECK (status <> 'grace_period' OR grace_period_ends_at IS NOT NULL);

-- ── 3. Expose the grace window in the composite validation lookup ───────────

-- Identical to 20260624000000 except for the added
-- `entitlement_grace_period_ends_at` field.
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
    'entitlement_grace_period_ends_at', v_entitlement.grace_period_ends_at,
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

REVOKE ALL ON FUNCTION public.license_validate_lookup(text, uuid) FROM public, anon, authenticated;
