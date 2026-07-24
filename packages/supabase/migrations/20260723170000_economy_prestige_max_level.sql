-- =============================================================================
-- Prestige level / multiplier ceiling (game-economy-achievements-prestige).
--
-- The catalog contracts a prestige-max-level control (default 10) that keeps a
-- member's permanent earning multiplier "bounded ... forever", but no
-- guild_config column existed and economy_prestige_apply enforced no upper
-- bound: v_new_level = prestige_level + 1 and v_new_mult = multiplier_pct +
-- gain grew without limit, so a member could prestige indefinitely.
--
-- This adds the config column and threads a p_max_level bound into the RPC: a
-- member already at the cap is refused with status='prestige_capped' and the
-- level + multiplier are left unchanged.
-- =============================================================================

BEGIN;

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS economy_prestige_max_level integer NOT NULL DEFAULT 10;

-- Adding a parameter changes the signature; drop the old 6-arg overload so the
-- bot's 7-arg call resolves unambiguously.
DROP FUNCTION IF EXISTS public.economy_prestige_apply(TEXT, TEXT, INT, BIGINT, INT, TEXT);

CREATE OR REPLACE FUNCTION public.economy_prestige_apply(
  p_guild_id        TEXT,
  p_user_id         TEXT,
  p_min_level       INT,
  p_min_net_worth   BIGINT,
  p_multiplier_gain INT,
  p_max_level       INT,
  p_request_id      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prestige  public.economy_prestige%ROWTYPE;
  v_wallet    BIGINT;
  v_bank      BIGINT;
  v_net_worth BIGINT;
  v_level     INT;
  v_new_level INT;
  v_new_mult  INT;
BEGIN
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'economy_prestige_apply: p_request_id is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-role-income:' || p_guild_id || ':' || p_user_id, 0));

  SELECT * INTO v_prestige
    FROM public.economy_prestige
   WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;

  -- Idempotent replay: this interaction already prestiged this member.
  IF FOUND AND v_prestige.last_request_id = p_request_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'prestiged', 'replayed', true,
      'new_level', v_prestige.prestige_level, 'new_multiplier', v_prestige.multiplier_pct);
  END IF;

  -- Enforce the configured prestige ceiling: a member already at the cap cannot
  -- prestige again, so the permanent earning multiplier stays bounded. Checked
  -- before the level / net-worth gates so a capped member always sees the cap.
  IF p_max_level IS NOT NULL AND COALESCE(v_prestige.prestige_level, 0) >= p_max_level THEN
    RETURN pg_catalog.jsonb_build_object('status', 'prestige_capped', 'replayed', false,
      'level', COALESCE(v_prestige.prestige_level, 0), 'max_level', p_max_level);
  END IF;

  SELECT wallet, bank INTO v_wallet, v_bank
    FROM public.economy_wallets
   WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  v_net_worth := COALESCE(v_wallet, 0) + COALESCE(v_bank, 0);

  SELECT level INTO v_level
    FROM public.member_levels
   WHERE guild_id = p_guild_id AND member_id = p_user_id;
  v_level := COALESCE(v_level, 0);

  IF v_level < p_min_level THEN
    RETURN pg_catalog.jsonb_build_object('status', 'level_too_low', 'replayed', false, 'level', v_level);
  END IF;
  IF v_net_worth < p_min_net_worth THEN
    RETURN pg_catalog.jsonb_build_object('status', 'net_worth_too_low', 'replayed', false, 'net_worth', v_net_worth);
  END IF;

  v_new_level := COALESCE(v_prestige.prestige_level, 0) + 1;
  v_new_mult  := COALESCE(v_prestige.multiplier_pct, 0) + p_multiplier_gain;

  -- Reset wallet + bank (get_or_create so a member who never had a wallet row
  -- still lands one at zero, matching the prior upsert-nothing behavior).
  PERFORM public.economy_get_or_create_wallet(p_guild_id, p_user_id);
  UPDATE public.economy_wallets
     SET wallet = 0, bank = 0, updated_at = now()
   WHERE guild_id = p_guild_id AND user_id = p_user_id;

  INSERT INTO public.economy_prestige
    (guild_id, user_id, prestige_level, total_resets, multiplier_pct, last_prestige, last_request_id)
  VALUES (p_guild_id, p_user_id, v_new_level, 1, v_new_mult, now(), p_request_id)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    prestige_level  = v_new_level,
    total_resets    = public.economy_prestige.total_resets + 1,
    multiplier_pct  = v_new_mult,
    last_prestige   = now(),
    last_request_id = p_request_id;

  RETURN pg_catalog.jsonb_build_object('status', 'prestiged', 'replayed', false,
    'new_level', v_new_level, 'new_multiplier', v_new_mult);
END;
$$;

REVOKE ALL ON FUNCTION public.economy_prestige_apply(TEXT, TEXT, INT, BIGINT, INT, INT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_prestige_apply(TEXT, TEXT, INT, BIGINT, INT, INT, TEXT)
  TO service_role;

COMMIT;
