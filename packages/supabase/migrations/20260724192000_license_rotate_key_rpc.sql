-- =============================================================================
-- Rotate-and-invalidate is contracted but was IMPOSSIBLE at the data model.
--
-- The catalog contracts license rotation (commerce-licenses SET-B / the
-- commerce-portal rotation surface): "rotate-and-invalidate issues a fresh key
-- and kills the old one immediately", the successor "carries the entitlement",
-- and "exactly one new key is issued" under replay/race. The entitlement's
-- composite identity FK (commerce_entitlement_license_identity_fk) forces the
-- successor key to share the predecessor's (order_id, guild_id, customer_id,
-- product_id) tuple — but idx_license_keys_order_id (20260518000101, "One
-- license key per order") was UNIQUE on bare (order_id), so ANY successor row
-- for the order was rejected with 23505 forever. Rotation could not exist.
-- The fleet SET-B proof surfaced this as two findings: the rotate-and-
-- invalidate failure, plus a hash-only false alarm downstream of the same
-- rejected insert (the successor row the probe re-read never existed).
--
-- This migration makes the contracted rotation real while KEEPING the
-- duplicate-fulfillment fence that index was for:
--
--   * idx_license_keys_order_id narrows to one LIVE key per order — the same
--     status set ('pending_activation','active','suspended') the
--     commerce_required_order_status generated column treats as live. A replayed
--     fulfillment still cannot mint a second live key; a terminal (revoked/
--     expired) predecessor no longer blocks its rotation successor.
--   * license_keys.rotated_to_key_id records the old→new lineage (masked
--     rotation history; the replay fence returns the completed rotation).
--   * commerce_guard_noncommerce_origin_update (20260711030000) gains the
--     tightest possible rotation carve-out: entitlements.license_key_id may
--     move ONLY along that recorded lineage (predecessor revoked-as-rotated
--     and pointing at the successor) with every other identity/snapshot field
--     still lifetime-immutable — the successor is the SAME grant with a
--     re-minted credential, not a materially different one, and the composite
--     entitlement→license identity FK still forces the identical commerce
--     tuple on top of the lineage check.
--   * license_rotate_key(...) is the atomic production primitive (mirrors
--     license_validate_device: FOR UPDATE + SECURITY DEFINER): it revokes the
--     old key FIRST (the terminal-transition trigger drains its live sessions
--     in the same transaction), mints the hash-only successor for the same
--     commerce tuple, moves the entitlement binding, and audits key.rotated
--     linking old and new key ids — ids and display suffixes only, never a
--     plaintext. Replaying it returns 'already_rotated' with the existing
--     successor instead of minting again; two racers serialize on the row lock
--     so the loser observes the completed rotation.
-- =============================================================================
BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. One LIVE key per order (was: one key per order EVER, which forbade the
--    contracted successor row outright).
-- ────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_license_keys_order_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_license_keys_order_id
  ON public.license_keys (order_id)
  WHERE order_id IS NOT NULL
    AND status IN ('pending_activation', 'active', 'suspended');

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Rotation lineage: the revoked predecessor points at its successor.
--    ON DELETE SET NULL so a swept successor degrades the pointer instead of
--    blocking deletion (the run sweep removes whole guilds at once).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.license_keys
  ADD COLUMN IF NOT EXISTS rotated_to_key_id UUID
    REFERENCES public.license_keys(id) ON DELETE SET NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Rotation carve-out in the entitlement grant-identity guard. The guard's
--    contract ("a materially different grant must be a new entitlement rather
--    than rewriting historical delivery authority") stands: only license_key_id
--    may change, and only to the successor its predecessor key recorded during
--    rotate-and-invalidate. Everything else remains lifetime-immutable.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.commerce_guard_noncommerce_origin_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.guild_id IS NOT DISTINCT FROM OLD.guild_id
     AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
     AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.source IS NOT DISTINCT FROM OLD.source
     AND NEW.type IS NOT DISTINCT FROM OLD.type
     AND NEW.plan_id IS NOT DISTINCT FROM OLD.plan_id
     AND NEW.granted_role_ids IS NOT DISTINCT FROM OLD.granted_role_ids
     AND NEW.granted_channel_ids IS NOT DISTINCT FROM OLD.granted_channel_ids THEN
    IF NEW.license_key_id IS NOT DISTINCT FROM OLD.license_key_id THEN
      RETURN NEW;
    END IF;
    -- Key-rotation carve-out: the entitlement may follow ONLY the recorded
    -- rotate-and-invalidate lineage — the predecessor key must be revoked as
    -- rotated and must itself point at exactly this successor.
    IF OLD.license_key_id IS NOT NULL
       AND NEW.license_key_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM public.license_keys AS predecessor
          WHERE predecessor.id = OLD.license_key_id
            AND predecessor.rotated_to_key_id = NEW.license_key_id
            AND predecessor.status = 'revoked'
            AND predecessor.revocation_reason = 'rotated'
       ) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'entitlement grant identity and snapshots are lifetime-immutable';
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. The atomic rotate-and-invalidate primitive.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.license_rotate_key(
  p_license_key_id UUID,
  p_new_key_hash TEXT,
  p_new_key_prefix TEXT,
  p_new_key_suffix TEXT,
  p_actor_discord_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old public.license_keys%ROWTYPE;
  v_new_id UUID;
  v_now TIMESTAMPTZ := now();
BEGIN
  -- Serialize concurrent rotations of the same key on the row lock.
  SELECT * INTO v_old
    FROM public.license_keys
    WHERE id = p_license_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Replay / losing racer: the rotation already completed — return it, never
  -- mint a further key ("exactly one new key is issued").
  IF v_old.status = 'revoked' AND v_old.revocation_reason = 'rotated' THEN
    RETURN jsonb_build_object(
      'status', 'already_rotated',
      'old_key_id', v_old.id,
      'new_key_id', v_old.rotated_to_key_id
    );
  END IF;

  IF v_old.status NOT IN ('pending_activation', 'active', 'suspended') THEN
    RETURN jsonb_build_object('status', 'not_rotatable', 'key_status', v_old.status);
  END IF;

  -- Invalidate the old key FIRST: the one-live-key-per-order fence then admits
  -- the successor, and commerce_license_terminal_deactivates_sessions drains
  -- the old key's live sessions inside this same transaction.
  UPDATE public.license_keys
     SET status = 'revoked',
         revoked_at = v_now,
         revocation_reason = 'rotated'
   WHERE id = v_old.id;

  -- Mint the hash-only successor for the same commerce identity tuple (the
  -- entitlement's composite FK requires it). Status carries over so a pending
  -- key rotates to a pending key and an active one stays seamlessly active.
  INSERT INTO public.license_keys (
    order_id, customer_id, product_id, guild_id,
    key_hash, key_prefix, key_suffix, bound_discord_id,
    status, activated_at, expires_at
  ) VALUES (
    v_old.order_id, v_old.customer_id, v_old.product_id, v_old.guild_id,
    p_new_key_hash, p_new_key_prefix, p_new_key_suffix, v_old.bound_discord_id,
    v_old.status,
    CASE WHEN v_old.status = 'active' THEN COALESCE(v_old.activated_at, v_now) END,
    v_old.expires_at
  )
  RETURNING id INTO v_new_id;

  UPDATE public.license_keys
     SET rotated_to_key_id = v_new_id
   WHERE id = v_old.id;

  -- The successor carries the entitlement uninterrupted.
  UPDATE public.entitlements
     SET license_key_id = v_new_id
   WHERE license_key_id = v_old.id;

  -- Audit the rotation linking old and new key ids — ids and display suffixes
  -- only, never a plaintext key (never-reveal).
  INSERT INTO public.audit_logs (
    guild_id, actor_type, actor_id, action, target_type, target_id, category, details
  ) VALUES (
    v_old.guild_id,
    CASE WHEN p_actor_discord_id IS NULL THEN 'system' ELSE 'user' END,
    COALESCE(p_actor_discord_id, 'system'),
    'key.rotated',
    'license_key',
    v_old.id::text,
    'commerce',
    jsonb_build_object(
      'old_key_id', v_old.id,
      'new_key_id', v_new_id,
      'old_key_suffix', v_old.key_suffix,
      'new_key_suffix', p_new_key_suffix
    )
  );

  RETURN jsonb_build_object(
    'status', 'rotated',
    'old_key_id', v_old.id,
    'new_key_id', v_new_id
  );
END;
$$;

-- Backend-only, like license_validate_device.
REVOKE ALL ON FUNCTION public.license_rotate_key FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.license_rotate_key TO service_role;

COMMIT;
