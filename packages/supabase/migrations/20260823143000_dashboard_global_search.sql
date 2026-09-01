CREATE OR REPLACE FUNCTION public.search_dashboard_control_center(
  p_guild_id TEXT,
  p_query TEXT,
  p_kinds TEXT[],
  p_limit INTEGER DEFAULT 25
)
RETURNS TABLE (
  kind TEXT,
  id TEXT,
  label TEXT,
  description TEXT,
  href TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_query TEXT;
  v_limit INTEGER;
BEGIN
  IF p_guild_id IS NULL OR p_query IS NULL OR pg_catalog.btrim(p_query) = ''
     OR p_kinds IS NULL OR NOT p_kinds <@ ARRAY['products', 'customers', 'members', 'incidents', 'audits']::TEXT[] THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'dashboard search: valid guild, query, and authorized kinds are required';
  END IF;
  v_query := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.lower(pg_catalog.btrim(p_query)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_limit := pg_catalog.least(50, pg_catalog.greatest(1, COALESCE(p_limit, 25)));

  RETURN QUERY
  WITH authorized_results AS (
    SELECT 'products'::TEXT AS kind, product.id::TEXT AS id, product.name AS label,
           COALESCE(product.description, 'Store product') AS description,
           '/store?productId=' || product.id::TEXT AS href
      FROM public.products AS product
     WHERE 'products' = ANY(p_kinds) AND product.guild_id = p_guild_id
       AND (pg_catalog.lower(product.name) LIKE v_query ESCAPE '\' OR pg_catalog.lower(COALESCE(product.description, '')) LIKE v_query ESCAPE '\')
    UNION ALL
    SELECT 'customers', customer.id::TEXT, COALESCE(NULLIF(customer.discord_username, ''), customer.discord_id),
           'Customer identity and entitlement record', '/customers/' || customer.id::TEXT
      FROM public.customers AS customer
     WHERE 'customers' = ANY(p_kinds) AND customer.guild_id = p_guild_id
       AND (pg_catalog.lower(customer.discord_username) LIKE v_query ESCAPE '\'
         OR pg_catalog.lower(COALESCE(customer.email, '')) LIKE v_query ESCAPE '\'
         OR customer.discord_id = pg_catalog.btrim(p_query))
    UNION ALL
    SELECT 'members', member.discord_id, COALESCE(NULLIF(member.username, ''), member.discord_id),
           'Guild member', '/members?search=' || member.discord_id
      FROM public.members AS member
     WHERE 'members' = ANY(p_kinds) AND member.guild_id = p_guild_id
       AND (pg_catalog.lower(member.username) LIKE v_query ESCAPE '\' OR member.discord_id = pg_catalog.btrim(p_query))
    UNION ALL
    SELECT 'incidents', incident.id::TEXT, incident.title,
           'Incident ' || incident.status || ' · ' || incident.severity, '/incidents?id=' || incident.id::TEXT
      FROM public.incidents AS incident
     WHERE 'incidents' = ANY(p_kinds) AND incident.guild_id = p_guild_id
       AND (pg_catalog.lower(incident.title) LIKE v_query ESCAPE '\' OR pg_catalog.lower(COALESCE(incident.description, '')) LIKE v_query ESCAPE '\')
    UNION ALL
    SELECT 'audits', audit.id::TEXT, audit.action,
           COALESCE(audit.category, 'Audit event') || ' · ' || COALESCE(audit.target_type, 'operation'), '/audit?search=' || audit.id::TEXT
      FROM public.audit_logs AS audit
     WHERE 'audits' = ANY(p_kinds) AND audit.guild_id = p_guild_id
       AND (pg_catalog.lower(audit.action) LIKE v_query ESCAPE '\'
         OR pg_catalog.lower(COALESCE(audit.target_id, '')) LIKE v_query ESCAPE '\'
         OR pg_catalog.lower(COALESCE(audit.actor_id, '')) LIKE v_query ESCAPE '\')
  )
  SELECT result.kind, result.id, result.label, result.description, result.href
    FROM authorized_results AS result
   ORDER BY result.kind, result.label, result.id
   LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.search_dashboard_control_center(TEXT, TEXT, TEXT[], INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_dashboard_control_center(TEXT, TEXT, TEXT[], INTEGER)
  TO service_role;

COMMENT ON FUNCTION public.search_dashboard_control_center(TEXT, TEXT, TEXT[], INTEGER) IS
  'Guild-isolated dynamic dashboard search. The authenticated API supplies only result kinds authorized for the active staff role.';
