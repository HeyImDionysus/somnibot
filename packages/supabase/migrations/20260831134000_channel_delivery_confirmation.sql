BEGIN;

ALTER TABLE public.commerce_role_delivery_intents
  ADD COLUMN completed_channel_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN channel_delivery_confirmed_at timestamptz;

CREATE FUNCTION public.commerce_confirm_channel_delivery(
  p_action_id uuid, p_claim_token uuid, p_order_id uuid, p_guild_id text,
  p_outward_generation_id uuid, p_channel_ids text[]
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  observed public.commerce_role_delivery_intents%ROWTYPE;
  intent public.commerce_role_delivery_intents%ROWTYPE;
  carrier public.bot_action_queue%ROWTYPE;
  purchase public.orders%ROWTYPE;
  entitlement public.entitlements%ROWTYPE;
BEGIN
  IF p_action_id IS NULL OR p_claim_token IS NULL OR p_outward_generation_id IS NULL
     OR p_channel_ids IS NULL OR pg_catalog.cardinality(p_channel_ids) = 0
     OR public.commerce_jsonb_snowflake_snapshot_matches(pg_catalog.to_jsonb(p_channel_ids), p_channel_ids) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Exact channel delivery identity is required';
  END IF;

  SELECT * INTO observed FROM public.commerce_role_delivery_intents
   WHERE action_id = p_action_id AND order_id = p_order_id AND guild_id = p_guild_id
     AND outward_generation_id = p_outward_generation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Channel delivery generation is unavailable';
  END IF;

  SELECT * INTO purchase FROM public.orders WHERE id = observed.order_id FOR SHARE;
  PERFORM 1 FROM public.customers WHERE id = observed.customer_id FOR SHARE;
  SELECT * INTO entitlement FROM public.entitlements WHERE id = observed.entitlement_id FOR SHARE;
  SELECT * INTO intent FROM public.commerce_role_delivery_intents WHERE id = observed.id FOR UPDATE;
  SELECT * INTO carrier FROM public.bot_action_queue WHERE id = p_action_id FOR UPDATE;

  IF intent.outward_generation_id IS DISTINCT FROM p_outward_generation_id
     OR intent.action_id IS DISTINCT FROM p_action_id
     OR carrier.status IS DISTINCT FROM 'processing' OR carrier.claim_token IS DISTINCT FROM p_claim_token
     OR carrier.guild_id IS DISTINCT FROM p_guild_id OR carrier.lane IS DISTINCT FROM 'commerce'
     OR intent.contract_kind IS DISTINCT FROM 'paid' OR intent.state IS DISTINCT FROM 'open'
     OR intent.delivery_confirmed_at IS NULL OR intent.last_delivery_outcome IS DISTINCT FROM 'live'
     OR public.commerce_role_delivery_contract_state(intent.id) IS DISTINCT FROM 'live'
     OR purchase.grant_snapshot_frozen_at IS NULL
     OR purchase.guild_id IS DISTINCT FROM p_guild_id OR purchase.product_id IS DISTINCT FROM intent.product_id
     OR entitlement.guild_id IS DISTINCT FROM p_guild_id OR entitlement.order_id IS DISTINCT FROM p_order_id
     OR entitlement.product_id IS DISTINCT FROM intent.product_id
     OR entitlement.customer_id IS DISTINCT FROM intent.customer_id
     OR entitlement.granted_channel_ids IS DISTINCT FROM purchase.granted_channel_ids_snapshot
     OR public.commerce_jsonb_snowflake_snapshot_matches(carrier.payload->'granted_channel_ids', p_channel_ids) IS NOT TRUE
     OR public.commerce_jsonb_snowflake_snapshot_matches(pg_catalog.to_jsonb(p_channel_ids), purchase.granted_channel_ids_snapshot) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Channel delivery claim or frozen contract changed';
  END IF;

  IF intent.channel_delivery_confirmed_at IS NOT NULL THEN
    RETURN public.commerce_jsonb_snowflake_snapshot_matches(pg_catalog.to_jsonb(p_channel_ids), intent.completed_channel_ids);
  END IF;
  UPDATE public.commerce_role_delivery_intents
     SET completed_channel_ids = p_channel_ids, channel_delivery_confirmed_at = pg_catalog.clock_timestamp()
   WHERE id = intent.id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_confirm_channel_delivery(uuid,uuid,uuid,text,uuid,text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_confirm_channel_delivery(uuid,uuid,uuid,text,uuid,text[]) TO service_role;

CREATE FUNCTION public.commerce_guard_channel_delivery_confirmation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE confirmation_owner name;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.channel_delivery_confirmed_at IS NOT NULL OR NEW.completed_channel_ids <> '{}'::text[] THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Channel confirmation requires the claimed delivery RPC';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.channel_delivery_confirmed_at IS NOT DISTINCT FROM OLD.channel_delivery_confirmed_at
     AND NEW.completed_channel_ids IS NOT DISTINCT FROM OLD.completed_channel_ids THEN RETURN NEW; END IF;
  SELECT pg_catalog.pg_get_userbyid(proowner) INTO confirmation_owner FROM pg_catalog.pg_proc
   WHERE oid = 'public.commerce_confirm_channel_delivery(uuid,uuid,uuid,text,uuid,text[])'::regprocedure;
  IF CURRENT_USER IS DISTINCT FROM confirmation_owner OR OLD.channel_delivery_confirmed_at IS NOT NULL
     OR NEW.channel_delivery_confirmed_at IS NULL OR pg_catalog.cardinality(NEW.completed_channel_ids) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Channel delivery confirmation is immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_guard_channel_delivery_confirmation() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER commerce_guard_channel_delivery_confirmation
  BEFORE INSERT OR UPDATE OF completed_channel_ids, channel_delivery_confirmed_at
  ON public.commerce_role_delivery_intents FOR EACH ROW
  EXECUTE FUNCTION public.commerce_guard_channel_delivery_confirmation();

COMMIT;
