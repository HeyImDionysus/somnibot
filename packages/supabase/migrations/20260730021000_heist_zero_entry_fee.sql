-- Honor a configured zero heist entry fee without calling the positive-only
-- economy_subtract_balance RPC. The participant insert remains in the same
-- locked transaction, preserving join/resolution serialization.
CREATE OR REPLACE FUNCTION public.heist_join(
  p_heist_id     UUID,
  p_user_id      TEXT,
  p_role         TEXT,
  p_entry_fee    INTEGER,
  p_max          INTEGER,
  p_base_chance  INTEGER
)
RETURNS TABLE (
  status         TEXT,
  member_count   INTEGER,
  success_chance INTEGER,
  role           TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status   TEXT;
  v_guild_id TEXT;
  v_count    INTEGER;
  v_chance   INTEGER;
  v_debited  BOOLEAN;
BEGIN
  SELECT h.status, h.guild_id
    INTO v_status, v_guild_id
    FROM public.economy_heists h
   WHERE h.id = p_heist_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_heist'::TEXT, 0, 0, NULL::TEXT;
    RETURN;
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_count
    FROM public.economy_heist_participants p
   WHERE p.heist_id = p_heist_id;

  IF v_status <> 'recruiting' THEN
    RETURN QUERY SELECT 'not_recruiting'::TEXT, v_count, 0, NULL::TEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.economy_heist_participants p
     WHERE p.heist_id = p_heist_id AND p.user_id = p_user_id
  ) THEN
    v_chance := LEAST(95, GREATEST(0, p_base_chance + (v_count - 1) * 7));
    RETURN QUERY SELECT 'already_joined'::TEXT, v_count, v_chance, NULL::TEXT;
    RETURN;
  END IF;

  IF v_count >= p_max THEN
    v_chance := LEAST(95, GREATEST(0, p_base_chance + (v_count - 1) * 7));
    RETURN QUERY SELECT 'crew_full'::TEXT, v_count, v_chance, NULL::TEXT;
    RETURN;
  END IF;

  IF p_entry_fee < 0 THEN
    v_chance := LEAST(95, GREATEST(0, p_base_chance + (v_count - 1) * 7));
    RETURN QUERY SELECT 'invalid_entry_fee'::TEXT, v_count, v_chance, NULL::TEXT;
    RETURN;
  END IF;

  IF p_entry_fee = 0 THEN
    v_debited := true;
  ELSE
    BEGIN
      PERFORM public.economy_subtract_balance(v_guild_id, p_user_id, p_entry_fee);
      v_debited := true;
    EXCEPTION WHEN OTHERS THEN
      v_debited := false;
    END;
  END IF;

  IF NOT v_debited THEN
    v_chance := LEAST(95, GREATEST(0, p_base_chance + (v_count - 1) * 7));
    RETURN QUERY SELECT 'insufficient_funds'::TEXT, v_count, v_chance, NULL::TEXT;
    RETURN;
  END IF;

  INSERT INTO public.economy_heist_participants
    (heist_id, guild_id, user_id, role, entry_fee_paid)
  VALUES (p_heist_id, v_guild_id, p_user_id, p_role, p_entry_fee);

  v_count  := v_count + 1;
  v_chance := LEAST(95, GREATEST(0, p_base_chance + (v_count - 1) * 7));

  RETURN QUERY SELECT 'joined'::TEXT, v_count, v_chance, p_role;
END;
$$;

REVOKE ALL ON FUNCTION public.heist_join(UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heist_join(UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  TO service_role;
