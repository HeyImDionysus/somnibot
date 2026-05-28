-- V5 Audit Remediation V2
-- Addresses findings: §4.1 wallet cap, §5.1 LIKE injection, §8.1 audit log immutability

-- ── §4.1: Add wallet upper-bound check constraint ────────────────────
-- Prevents BIGINT overflow via repeated economy_add_balance calls.
-- Cap at 10 trillion (10_000_000_000_000) which is far beyond any
-- reasonable in-game economy while preventing overflow territory.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'economy_wallets_wallet_bounds'
  ) THEN
    ALTER TABLE economy_wallets
      ADD CONSTRAINT economy_wallets_wallet_bounds
      CHECK (wallet >= 0 AND wallet <= 10000000000000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'economy_wallets_bank_bounds'
  ) THEN
    ALTER TABLE economy_wallets
      ADD CONSTRAINT economy_wallets_bank_bounds
      CHECK (bank >= 0 AND bank <= 10000000000000);
  END IF;
END $$;


-- ── §5.1: Fix LIKE injection in search_guild_members ─────────────────
-- Escape % and _ in user-supplied p_query to prevent wildcard injection.
CREATE OR REPLACE FUNCTION search_guild_members(
  p_guild_id TEXT,
  p_query TEXT DEFAULT NULL,
  p_ids TEXT[] DEFAULT NULL,
  p_page INT DEFAULT 1,
  p_page_size INT DEFAULT 50
)
RETURNS TABLE (
  members JSONB,
  total_matches BIGINT,
  page INT,
  page_size INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_members JSONB;
  v_filtered JSONB;
  v_total BIGINT;
  v_offset INT;
  v_q TEXT;
BEGIN
  -- Clamp page size
  IF p_page_size > 200 THEN p_page_size := 200; END IF;
  IF p_page < 1 THEN p_page := 1; END IF;
  v_offset := (p_page - 1) * p_page_size;

  -- Fetch the full members JSONB from guild_live_state
  SELECT gls.members INTO v_members
  FROM public.guild_live_state gls
  WHERE gls.guild_id = p_guild_id;

  IF v_members IS NULL THEN
    RETURN QUERY SELECT '[]'::JSONB, 0::BIGINT, p_page, p_page_size;
    RETURN;
  END IF;

  -- Mode 1: Search by query string
  IF p_query IS NOT NULL AND p_query <> '' THEN
    -- V5 Audit §5.1: Escape LIKE metacharacters to prevent wildcard injection
    v_q := REPLACE(REPLACE(REPLACE(LOWER(p_query), '\', '\\'), '%', '\%'), '_', '\_');

    SELECT jsonb_agg(elem), count(*)
    INTO v_filtered, v_total
    FROM jsonb_array_elements(v_members) elem
    WHERE LOWER(elem ->> 'username') LIKE '%' || v_q || '%' ESCAPE '\'
       OR LOWER(COALESCE(elem ->> 'displayName', '')) LIKE '%' || v_q || '%' ESCAPE '\'
       OR elem ->> 'id' = p_query;

  -- Mode 2: Resolve specific IDs
  ELSIF p_ids IS NOT NULL AND array_length(p_ids, 1) > 0 THEN
    SELECT jsonb_agg(elem)
    INTO v_filtered
    FROM jsonb_array_elements(v_members) elem
    WHERE elem ->> 'id' = ANY(p_ids);

    -- V5 Audit §14.2: Use result set size instead of extra subquery
    v_total := COALESCE(jsonb_array_length(v_filtered), 0);

  -- Mode 3: Return all (paginated)
  ELSE
    v_filtered := v_members;
    v_total := jsonb_array_length(v_members);
  END IF;

  IF v_filtered IS NULL THEN
    v_filtered := '[]'::JSONB;
    v_total := 0;
  END IF;

  -- Paginate the filtered results
  RETURN QUERY
    SELECT
      COALESCE(
        (SELECT jsonb_agg(val)
         FROM (
           SELECT val
           FROM jsonb_array_elements(v_filtered) val
           OFFSET v_offset
           LIMIT p_page_size
         ) sub),
        '[]'::JSONB
      ),
      COALESCE(v_total, 0::BIGINT),
      p_page,
      p_page_size;
END;
$$;

-- Ensure the function is only callable by service_role
REVOKE ALL ON FUNCTION search_guild_members(TEXT, TEXT, TEXT[], INT, INT) FROM PUBLIC, anon, authenticated;


-- ── §8.1: Audit log immutability trigger ─────────────────────────────
-- Prevents deletion of audit log entries at the database level.
CREATE OR REPLACE FUNCTION prevent_audit_log_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Audit log entries cannot be deleted';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_prevent_audit_log_delete'
  ) THEN
    CREATE TRIGGER trg_prevent_audit_log_delete
      BEFORE DELETE ON audit_logs
      FOR EACH ROW
      EXECUTE FUNCTION prevent_audit_log_delete();
  END IF;
END $$;
