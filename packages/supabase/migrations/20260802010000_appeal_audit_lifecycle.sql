-- Appeal lifecycle audit coverage.
--
-- The trigger keeps submitted, approved, denied, and expired audit entries in
-- the same transaction as their appeal transition. Before replacing a stray
-- manually installed copy, verify it is the exact known pre-release object;
-- a different object must be investigated rather than overwritten.

DO $$
DECLARE
  v_function_oid pg_catalog.oid;
  v_trigger_oid pg_catalog.oid;
  v_trigger_function_oid pg_catalog.oid;
  v_trigger_type pg_catalog.int2;
BEGIN
  SELECT p.oid
    INTO v_function_oid
    FROM pg_catalog.pg_proc AS p
    INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'audit_appeal_lifecycle'
     AND p.pronargs = 0;

  SELECT t.oid, t.tgfoid, t.tgtype
    INTO v_trigger_oid, v_trigger_function_oid, v_trigger_type
    FROM pg_catalog.pg_trigger AS t
   WHERE t.tgrelid = 'public.appeals'::pg_catalog.regclass
     AND t.tgname = 'trg_audit_appeal_lifecycle'
     AND NOT t.tgisinternal;

  IF v_function_oid IS NULL AND v_trigger_oid IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'unexpected appeal audit trigger without its known function';
  END IF;

  IF v_function_oid IS NOT NULL THEN
    IF pg_catalog.md5(pg_catalog.pg_get_functiondef(v_function_oid))
       <> '5589be0edf72c6a6560aaa1b465d6c4a' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'unexpected audit_appeal_lifecycle definition; refusing replacement';
    END IF;

    IF v_trigger_oid IS NULL
       OR v_trigger_function_oid <> v_function_oid
       OR v_trigger_type <> 21 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'unexpected appeal audit trigger definition; refusing replacement';
    END IF;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_appeal_lifecycle ON public.appeals;
DROP FUNCTION IF EXISTS public.audit_appeal_lifecycle();

CREATE FUNCTION public.audit_appeal_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action pg_catalog.text;
  v_actor_type pg_catalog.text;
  v_actor_id pg_catalog.text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'appeal.submitted';
    v_actor_type := 'discord';
    v_actor_id := NEW.appellant_discord_id;
  ELSIF OLD.status IS DISTINCT FROM NEW.status
        AND NEW.status IN ('approved', 'denied', 'expired') THEN
    v_action := 'appeal.' || NEW.status;
    v_actor_type := CASE WHEN NEW.reviewer_id IS NULL THEN 'system' ELSE 'dashboard' END;
    v_actor_id := COALESCE(NEW.reviewer_id, 'appeals-sweeper');
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_logs (
    guild_id,
    actor_type,
    actor_id,
    action,
    category,
    target_type,
    target_id,
    details,
    before_state,
    after_state,
    occurrence_key,
    success
  ) VALUES (
    NEW.guild_id,
    v_actor_type,
    v_actor_id,
    v_action,
    'moderation',
    'appeal',
    NEW.id::pg_catalog.text,
    pg_catalog.jsonb_build_object(
      'infraction_id', NEW.infraction_id,
      'appellant_discord_id', NEW.appellant_discord_id
    ),
    CASE WHEN TG_OP = 'UPDATE' THEN pg_catalog.jsonb_build_object('status', OLD.status) ELSE NULL END,
    pg_catalog.jsonb_build_object('status', NEW.status, 'reviewer_id', NEW.reviewer_id),
    v_action || ':' || NEW.id::pg_catalog.text,
    true
  )
  ON CONFLICT (guild_id, occurrence_key) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_appeal_lifecycle() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_appeal_lifecycle() TO service_role;

CREATE TRIGGER trg_audit_appeal_lifecycle
AFTER INSERT OR UPDATE OF status ON public.appeals
FOR EACH ROW
EXECUTE FUNCTION public.audit_appeal_lifecycle();

COMMENT ON FUNCTION public.audit_appeal_lifecycle() IS
  'Atomically records appeal lifecycle audit rows with occurrence-key dedupe.';
