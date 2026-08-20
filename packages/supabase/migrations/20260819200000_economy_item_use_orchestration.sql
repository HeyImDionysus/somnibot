BEGIN;

CREATE TABLE IF NOT EXISTS public.economy_item_use_operations (
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  requested_item TEXT NOT NULL,
  item_id UUID NOT NULL REFERENCES public.economy_items(id) ON DELETE RESTRICT,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (guild_id, user_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_economy_item_use_operations_created
  ON public.economy_item_use_operations (created_at);

ALTER TABLE public.economy_item_use_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON public.economy_item_use_operations;
CREATE POLICY service_role_all ON public.economy_item_use_operations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.economy_item_use_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.economy_item_use_operations TO service_role;

CREATE OR REPLACE FUNCTION public.economy_use_item_atomic(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_item_selector TEXT,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.economy_item_use_operations%ROWTYPE;
  v_item public.economy_items%ROWTYPE;
  v_inventory public.economy_inventory%ROWTYPE;
  v_effect_type TEXT;
  v_amount BIGINT;
  v_role_id TEXT;
  v_xp_result JSONB;
  v_action_id UUID;
  v_result JSONB;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = ''
     OR p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = ''
     OR p_item_selector IS NULL OR pg_catalog.btrim(p_item_selector) = ''
     OR p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'economy_use_item_atomic: guild, user, item, and request are required';
  END IF;

  IF pg_catalog.length(p_item_selector) > 64 OR pg_catalog.length(p_request_id) > 128 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'economy_use_item_atomic: item or request identity is too long';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'economy-item-use:' || p_guild_id || ':' || p_user_id || ':' || p_request_id,
      0
    )
  );

  SELECT * INTO v_existing
    FROM public.economy_item_use_operations
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id
     AND request_id = p_request_id
   FOR UPDATE;

  IF FOUND THEN
    IF pg_catalog.lower(v_existing.requested_item) <> pg_catalog.lower(pg_catalog.btrim(p_item_selector)) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'economy_use_item_atomic: request identity was reused for a different item';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_item
    FROM public.economy_items
   WHERE guild_id = p_guild_id
     AND active = true
     AND (
       id::text = pg_catalog.btrim(p_item_selector)
       OR pg_catalog.lower(name) = pg_catalog.lower(pg_catalog.btrim(p_item_selector))
     )
   ORDER BY CASE WHEN id::text = pg_catalog.btrim(p_item_selector) THEN 0 ELSE 1 END
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'code', 'item_not_found',
      'message', 'That active inventory item could not be found.'
    );
  END IF;

  IF NOT v_item.usable OR v_item.use_effect IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'code', 'not_consumable',
      'message', 'That item works automatically and cannot be used manually.'
    );
  END IF;

  v_effect_type := v_item.use_effect ->> 'type';
  IF v_effect_type NOT IN ('wallet_credit', 'xp_credit', 'role_grant') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'code', 'unsupported_effect',
      'message', 'This item does not have a supported consumable behavior.'
    );
  END IF;

  SELECT * INTO v_inventory
    FROM public.economy_inventory
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id
     AND item_id = v_item.id
   FOR UPDATE;

  IF NOT FOUND OR v_inventory.quantity < 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'code', 'not_owned',
      'message', 'You do not own that item.'
    );
  END IF;

  IF v_effect_type IN ('wallet_credit', 'xp_credit') THEN
    IF (v_item.use_effect ->> 'amount') IS NULL
       OR (v_item.use_effect ->> 'amount') !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'economy_use_item_atomic: consumable amount is invalid';
    END IF;
    v_amount := (v_item.use_effect ->> 'amount')::BIGINT;
    IF v_amount > 1000000000 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'economy_use_item_atomic: consumable amount exceeds the supported maximum';
    END IF;
  END IF;

  IF v_effect_type = 'role_grant' THEN
    v_role_id := v_item.use_effect ->> 'role_id';
    IF v_role_id IS NULL OR v_role_id !~ '^[0-9]{17,20}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'economy_use_item_atomic: role consumable is missing a valid role';
    END IF;
  END IF;

  IF v_inventory.quantity = 1 THEN
    DELETE FROM public.economy_inventory WHERE id = v_inventory.id;
  ELSE
    UPDATE public.economy_inventory
       SET quantity = quantity - 1,
           updated_at = pg_catalog.now()
     WHERE id = v_inventory.id;
  END IF;

  IF v_effect_type = 'wallet_credit' THEN
    PERFORM public.economy_credit_wallet(
      p_guild_id,
      p_user_id,
      v_amount,
      'Used ' || v_item.name
    );
  ELSIF v_effect_type = 'xp_credit' THEN
    v_xp_result := public.increment_member_xp(
      p_guild_id,
      p_user_id,
      v_amount::INTEGER,
      false,
      0
    );
  ELSE
    INSERT INTO public.bot_action_queue (guild_id, action, payload, status)
    VALUES (
      p_guild_id,
      'bulk_role_add',
      pg_catalog.jsonb_build_object(
        'member_id', p_user_id,
        'role_id', v_role_id,
        'source', 'economy_item_use',
        'item_id', v_item.id,
        'request_id', p_request_id
      ),
      'pending'
    )
    RETURNING id INTO v_action_id;
  END IF;

  v_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'status', 'applied',
    'replayed', false,
    'item_id', v_item.id,
    'item_name', v_item.name,
    'item_emoji', v_item.emoji,
    'effect_type', v_effect_type,
    'amount', v_amount,
    'role_id', v_role_id,
    'action_id', v_action_id,
    'xp_result', v_xp_result
  ));

  INSERT INTO public.economy_item_use_operations (
    guild_id,
    user_id,
    request_id,
    requested_item,
    item_id,
    result
  ) VALUES (
    p_guild_id,
    p_user_id,
    p_request_id,
    pg_catalog.btrim(p_item_selector),
    v_item.id,
    v_result
  );

  INSERT INTO public.audit_logs (
    guild_id,
    actor_type,
    actor_id,
    action,
    category,
    target_type,
    target_id,
    details,
    correlation_id,
    occurrence_key,
    success
  ) VALUES (
    p_guild_id,
    'member',
    p_user_id,
    'economy.item_used',
    'economy',
    'economy_item',
    v_item.id::TEXT,
    pg_catalog.jsonb_build_object(
      'item_name', v_item.name,
      'effect_type', v_effect_type,
      'amount', v_amount,
      'role_id', v_role_id,
      'action_id', v_action_id
    ),
    p_request_id,
    'economy.item_used:' || p_request_id,
    true
  ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_use_item_atomic(TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_use_item_atomic(TEXT, TEXT, TEXT, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.restore_failed_economy_role_item_use()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_operation public.economy_item_use_operations%ROWTYPE;
BEGIN
  IF OLD.status = 'failed'
     OR NEW.status <> 'failed'
     OR NEW.action <> 'bulk_role_add'
     OR NEW.payload ->> 'source' <> 'economy_item_use' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_operation
    FROM public.economy_item_use_operations
   WHERE guild_id = NEW.guild_id
     AND user_id = NEW.payload ->> 'member_id'
     AND request_id = NEW.payload ->> 'request_id'
     AND item_id::TEXT = NEW.payload ->> 'item_id'
   FOR UPDATE;

  IF NOT FOUND OR v_operation.result ->> 'delivery_compensated' = 'true' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.economy_inventory (guild_id, user_id, item_id, quantity)
  VALUES (v_operation.guild_id, v_operation.user_id, v_operation.item_id, 1)
  ON CONFLICT (guild_id, user_id, item_id) DO UPDATE
    SET quantity = public.economy_inventory.quantity + 1,
        updated_at = pg_catalog.now();

  UPDATE public.economy_item_use_operations
     SET result = result || pg_catalog.jsonb_build_object(
       'status', 'rejected',
       'code', 'role_delivery_failed',
       'message', 'The role could not be delivered, so the item was returned.',
       'delivery_compensated', true
     )
   WHERE guild_id = v_operation.guild_id
     AND user_id = v_operation.user_id
     AND request_id = v_operation.request_id;

  INSERT INTO public.audit_logs (
    guild_id,
    actor_type,
    actor_id,
    action,
    category,
    target_type,
    target_id,
    details,
    correlation_id,
    occurrence_key,
    success,
    error_message
  ) VALUES (
    v_operation.guild_id,
    'system',
    'action-queue',
    'economy.item_use_delivery_failed',
    'economy',
    'economy_item',
    v_operation.item_id::TEXT,
    pg_catalog.jsonb_build_object('action_id', NEW.id),
    v_operation.request_id,
    'economy.item_use_delivery_failed:' || v_operation.request_id,
    false,
    NEW.error_message
  ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS economy_role_item_delivery_failure_restore ON public.bot_action_queue;
CREATE TRIGGER economy_role_item_delivery_failure_restore
AFTER UPDATE OF status ON public.bot_action_queue
FOR EACH ROW EXECUTE FUNCTION public.restore_failed_economy_role_item_use();

REVOKE ALL ON FUNCTION public.restore_failed_economy_role_item_use()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_failed_economy_role_item_use()
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
