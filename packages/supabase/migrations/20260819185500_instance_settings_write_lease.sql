BEGIN;

CREATE TABLE IF NOT EXISTS public.instance_settings_write_leases (
  scope TEXT PRIMARY KEY,
  operation_id UUID NOT NULL,
  leased_until TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT instance_settings_write_leases_scope_nonempty
    CHECK (pg_catalog.length(pg_catalog.btrim(scope)) BETWEEN 1 AND 128)
);

ALTER TABLE public.instance_settings_write_leases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON public.instance_settings_write_leases;
CREATE POLICY service_role_all ON public.instance_settings_write_leases
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.instance_settings_write_leases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.instance_settings_write_leases TO service_role;

CREATE OR REPLACE FUNCTION public.claim_instance_settings_write_lease(
  p_scope TEXT,
  p_operation_id UUID,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claimed UUID;
BEGIN
  IF p_scope IS NULL OR pg_catalog.length(pg_catalog.btrim(p_scope)) NOT BETWEEN 1 AND 128
     OR p_operation_id IS NULL
     OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'claim_instance_settings_write_lease: invalid lease identity or duration';
  END IF;

  INSERT INTO public.instance_settings_write_leases (
    scope,
    operation_id,
    leased_until,
    updated_at
  ) VALUES (
    pg_catalog.btrim(p_scope),
    p_operation_id,
    pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (scope) DO UPDATE
    SET operation_id = EXCLUDED.operation_id,
        leased_until = EXCLUDED.leased_until,
        updated_at = EXCLUDED.updated_at
    WHERE public.instance_settings_write_leases.operation_id = EXCLUDED.operation_id
       OR public.instance_settings_write_leases.leased_until <= pg_catalog.clock_timestamp()
  RETURNING operation_id INTO v_claimed;

  RETURN v_claimed = p_operation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_instance_settings_write_lease(
  p_scope TEXT,
  p_operation_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted UUID;
BEGIN
  DELETE FROM public.instance_settings_write_leases
   WHERE scope = pg_catalog.btrim(p_scope)
     AND operation_id = p_operation_id
  RETURNING operation_id INTO v_deleted;

  RETURN v_deleted = p_operation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_instance_settings_write_lease(TEXT, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_instance_settings_write_lease(TEXT, UUID, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION public.release_instance_settings_write_lease(TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_instance_settings_write_lease(TEXT, UUID)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
