CREATE OR REPLACE FUNCTION public.issue_portal_session_atomic(
  p_guild_id TEXT,
  p_customer_id UUID,
  p_token_hash TEXT,
  p_discord_id TEXT,
  p_expires_at TIMESTAMPTZ,
  p_ip_address TEXT,
  p_user_agent TEXT,
  p_max_sessions INTEGER DEFAULT 3
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session_id UUID;
  v_max_sessions INTEGER := LEAST(GREATEST(p_max_sessions, 1), 10);
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.customers AS customer
     WHERE customer.id = p_customer_id
       AND customer.guild_id = p_guild_id
       AND customer.discord_id = p_discord_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'portal session identity does not match the customer and guild';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_customer_id::TEXT, 0)
  );

  UPDATE public.portal_sessions AS session
     SET revoked = true
   WHERE session.id IN (
     SELECT active.id
       FROM public.portal_sessions AS active
      WHERE active.customer_id = p_customer_id
        AND active.guild_id = p_guild_id
        AND active.revoked = false
        AND active.expires_at > pg_catalog.now()
      ORDER BY active.created_at DESC, active.id DESC
      OFFSET GREATEST(v_max_sessions - 1, 0)
   );

  INSERT INTO public.portal_sessions (
    guild_id,
    customer_id,
    token_hash,
    discord_id,
    expires_at,
    ip_address,
    user_agent
  ) VALUES (
    p_guild_id,
    p_customer_id,
    p_token_hash,
    p_discord_id,
    p_expires_at,
    p_ip_address,
    p_user_agent
  )
  RETURNING id INTO v_session_id;

  RETURN v_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_portal_session_atomic(
  p_token_hash TEXT
) RETURNS TABLE (
  id UUID,
  guild_id TEXT,
  customer_id UUID,
  discord_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session_id UUID;
BEGIN
  SELECT session.id
    INTO v_session_id
    FROM public.portal_sessions AS session
   WHERE session.token_hash = p_token_hash
     AND session.revoked = false
     AND session.expires_at > pg_catalog.now()
   FOR UPDATE;

  IF v_session_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.portal_sessions AS session
     SET revoked = true
   WHERE session.id = v_session_id
     AND session.revoked = false
  RETURNING session.id, session.guild_id, session.customer_id, session.discord_id;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_portal_session_atomic(
  TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_portal_session_atomic(
  TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, INTEGER
) TO service_role;

REVOKE ALL ON FUNCTION public.revoke_portal_session_atomic(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_portal_session_atomic(TEXT)
  TO service_role;

COMMENT ON FUNCTION public.issue_portal_session_atomic(
  TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, INTEGER
) IS 'Atomically enforces the per-customer active portal-session cap and issues one session.';
COMMENT ON FUNCTION public.revoke_portal_session_atomic(TEXT)
  IS 'Atomically revokes one active portal session and returns the transition owner for auditing.';
