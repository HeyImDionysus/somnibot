ALTER TABLE public.level_rewards
  ALTER COLUMN role_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS reward_type TEXT NOT NULL DEFAULT 'role',
  ADD COLUMN IF NOT EXISTS remove_role_id TEXT,
  ADD COLUMN IF NOT EXISTS currency_amount BIGINT,
  ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES public.economy_items(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS item_quantity INTEGER,
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.level_rewards
  DROP CONSTRAINT IF EXISTS level_rewards_payload_check;

ALTER TABLE public.level_rewards
  ADD CONSTRAINT level_rewards_payload_check CHECK (
    (
      reward_type = 'role'
      AND role_id ~ '^[0-9]{17,20}$'
      AND (remove_role_id IS NULL OR remove_role_id ~ '^[0-9]{17,20}$')
      AND remove_role_id IS DISTINCT FROM role_id
      AND currency_amount IS NULL
      AND item_id IS NULL
      AND item_quantity IS NULL
      AND (remove_at_level IS NULL OR remove_at_level > level)
    )
    OR (
      reward_type = 'currency'
      AND role_id IS NULL
      AND remove_role_id IS NULL
      AND remove_at_level IS NULL
      AND currency_amount BETWEEN 1 AND 1000000000
      AND item_id IS NULL
      AND item_quantity IS NULL
    )
    OR (
      reward_type = 'item'
      AND role_id IS NULL
      AND remove_role_id IS NULL
      AND remove_at_level IS NULL
      AND currency_amount IS NULL
      AND item_id IS NOT NULL
      AND item_quantity BETWEEN 1 AND 1000
    )
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS level_rewards_reward_identity_key
  ON public.level_rewards (
    guild_id,
    level,
    reward_type,
    COALESCE(role_id, ''),
    COALESCE(item_id::TEXT, '')
  );

CREATE TABLE IF NOT EXISTS public.level_reward_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL CHECK (member_id ~ '^[0-9]{17,20}$'),
  reward_id UUID NOT NULL REFERENCES public.level_rewards(id) ON DELETE RESTRICT,
  delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('award', 'expiry')),
  reached_level INTEGER NOT NULL CHECK (reached_level BETWEEN 1 AND 1000000),
  status TEXT NOT NULL CHECK (status IN ('queued', 'completed')),
  action_id UUID REFERENCES public.bot_action_queue(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (guild_id, member_id, reward_id, delivery_kind)
);

CREATE INDEX IF NOT EXISTS level_reward_deliveries_member_idx
  ON public.level_reward_deliveries (guild_id, member_id, created_at DESC);

ALTER TABLE public.level_reward_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS level_reward_deliveries_owner_access
  ON public.level_reward_deliveries;
CREATE POLICY level_reward_deliveries_owner_access
  ON public.level_reward_deliveries
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.users
      WHERE users.id = auth.uid()
        AND users.is_owner = true
    )
  );

REVOKE ALL ON TABLE public.level_reward_deliveries
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.level_reward_deliveries
  TO service_role;

CREATE OR REPLACE FUNCTION public.apply_level_reward_delivery(
  p_guild_id TEXT,
  p_member_id TEXT,
  p_reward_id UUID,
  p_delivery_kind TEXT,
  p_reached_level INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reward public.level_rewards%ROWTYPE;
  v_item public.economy_items%ROWTYPE;
  v_delivery public.level_reward_deliveries%ROWTYPE;
  v_existing public.level_reward_deliveries%ROWTYPE;
  v_action_id UUID;
  v_payload JSONB;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = ''
     OR p_member_id !~ '^[0-9]{17,20}$'
     OR p_delivery_kind NOT IN ('award', 'expiry')
     OR p_reached_level < 1 THEN
    RAISE EXCEPTION 'invalid level reward delivery identity' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_reward
    FROM public.level_rewards
   WHERE id = p_reward_id
     AND guild_id = p_guild_id
     AND active = true
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'level reward not found for guild' USING ERRCODE = 'P0002';
  END IF;

  IF p_delivery_kind = 'award' AND v_reward.level > p_reached_level THEN
    RAISE EXCEPTION 'reward level has not been reached' USING ERRCODE = '22023';
  END IF;
  IF p_delivery_kind = 'expiry' AND (
    v_reward.reward_type <> 'role'
    OR v_reward.remove_at_level IS NULL
    OR v_reward.remove_at_level > p_reached_level
  ) THEN
    RAISE EXCEPTION 'role reward expiry has not been reached' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.level_reward_deliveries (
    guild_id,
    member_id,
    reward_id,
    delivery_kind,
    reached_level,
    status
  ) VALUES (
    p_guild_id,
    p_member_id,
    p_reward_id,
    p_delivery_kind,
    p_reached_level,
    CASE
      WHEN v_reward.reward_type = 'role' THEN 'queued'
      ELSE 'completed'
    END
  )
  ON CONFLICT (guild_id, member_id, reward_id, delivery_kind) DO NOTHING
  RETURNING * INTO v_delivery;

  IF NOT FOUND THEN
    SELECT *
      INTO v_existing
      FROM public.level_reward_deliveries
     WHERE guild_id = p_guild_id
       AND member_id = p_member_id
       AND reward_id = p_reward_id
       AND delivery_kind = p_delivery_kind;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'level reward replay readback missing' USING ERRCODE = 'P0002';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'replayed',
      'delivery_id', v_existing.id,
      'status', v_existing.status,
      'reward_type', v_reward.reward_type,
      'role_id', v_reward.role_id,
      'remove_role_id', v_reward.remove_role_id,
      'currency_amount', v_reward.currency_amount,
      'item_id', v_reward.item_id,
      'item_quantity', v_reward.item_quantity
    );
  END IF;

  IF p_delivery_kind = 'award' AND v_reward.reward_type = 'currency' THEN
    PERFORM public.economy_credit_wallet(
      p_guild_id,
      p_member_id,
      v_reward.currency_amount,
      'Level ' || v_reward.level || ' reward'
    );
    UPDATE public.level_reward_deliveries
       SET completed_at = now()
     WHERE id = v_delivery.id;
  ELSIF p_delivery_kind = 'award' AND v_reward.reward_type = 'item' THEN
    SELECT *
      INTO v_item
      FROM public.economy_items
     WHERE id = v_reward.item_id
       AND guild_id = p_guild_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reward item not found for guild' USING ERRCODE = 'P0002';
    END IF;
    PERFORM public.economy_upsert_inventory(
      p_guild_id,
      p_member_id,
      v_reward.item_id,
      v_reward.item_quantity,
      v_item.durability
    );
    UPDATE public.level_reward_deliveries
       SET completed_at = now()
     WHERE id = v_delivery.id;
  ELSE
    v_action_id := v_delivery.id;
    v_payload := pg_catalog.jsonb_build_object(
      'delivery_id', v_delivery.id,
      'guild_id', p_guild_id,
      'member_id', p_member_id,
      'reward_id', p_reward_id,
      'delivery_kind', p_delivery_kind,
      'grant_role_id', CASE WHEN p_delivery_kind = 'award' THEN v_reward.role_id ELSE NULL END,
      'remove_role_id', CASE
        WHEN p_delivery_kind = 'expiry' THEN v_reward.role_id
        ELSE v_reward.remove_role_id
      END
    );

    INSERT INTO public.bot_action_queue (id, guild_id, action, payload, status)
    VALUES (v_action_id, p_guild_id, 'deliver_level_reward_roles', v_payload, 'pending');

    UPDATE public.level_reward_deliveries
       SET action_id = v_action_id
     WHERE id = v_delivery.id;
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
    correlation_id,
    occurrence_key,
    success
  ) VALUES (
    p_guild_id,
    'member',
    p_member_id,
    'levels.reward_delivered',
    'levels',
    'level_reward',
    p_reward_id::TEXT,
    pg_catalog.jsonb_build_object(
      'delivery_id', v_delivery.id,
      'delivery_kind', p_delivery_kind,
      'reward_type', v_reward.reward_type,
      'reached_level', p_reached_level,
      'action_id', v_action_id
    ),
    v_delivery.id::TEXT,
    'levels.reward_delivered:' || v_delivery.id::TEXT,
    true
  );

  RETURN pg_catalog.jsonb_build_object(
    'outcome', 'applied',
    'delivery_id', v_delivery.id,
    'status', CASE WHEN v_reward.reward_type = 'role' THEN 'queued' ELSE 'completed' END,
    'reward_type', v_reward.reward_type,
    'role_id', v_reward.role_id,
    'remove_role_id', v_reward.remove_role_id,
    'currency_amount', v_reward.currency_amount,
    'item_id', v_reward.item_id,
    'item_quantity', v_reward.item_quantity
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_level_reward_delivery(TEXT, TEXT, UUID, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_level_reward_delivery(TEXT, TEXT, UUID, TEXT, INTEGER)
  TO service_role;

CREATE OR REPLACE FUNCTION public.complete_level_reward_role_delivery(
  p_delivery_id UUID,
  p_action_id UUID,
  p_guild_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.level_reward_deliveries
     SET status = 'completed',
         completed_at = COALESCE(completed_at, now())
   WHERE id = p_delivery_id
     AND guild_id = p_guild_id
     AND action_id = p_action_id
     AND status = 'queued';

  IF FOUND THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.level_reward_deliveries
     WHERE id = p_delivery_id
       AND guild_id = p_guild_id
       AND action_id = p_action_id
       AND status = 'completed'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_level_reward_role_delivery(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_level_reward_role_delivery(UUID, UUID, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.stage_crossed_level_rewards()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_level INTEGER := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE OLD.level END;
  v_reward public.level_rewards%ROWTYPE;
BEGIN
  IF NEW.level <= v_old_level THEN RETURN NEW; END IF;

  FOR v_reward IN
    SELECT reward.*
      FROM public.level_rewards AS reward
     WHERE reward.guild_id = NEW.guild_id
       AND reward.active = true
       AND reward.level > v_old_level
       AND reward.level <= NEW.level
       AND NOT (
         reward.reward_type = 'role'
         AND reward.remove_at_level IS NOT NULL
         AND reward.remove_at_level > v_old_level
         AND reward.remove_at_level <= NEW.level
       )
     ORDER BY reward.level, reward.id
  LOOP
    PERFORM public.apply_level_reward_delivery(
      NEW.guild_id, NEW.member_id, v_reward.id, 'award', NEW.level
    );
  END LOOP;

  FOR v_reward IN
    SELECT reward.*
      FROM public.level_rewards AS reward
     WHERE reward.guild_id = NEW.guild_id
       AND reward.active = true
       AND reward.reward_type = 'role'
       AND reward.remove_at_level > v_old_level
       AND reward.remove_at_level <= NEW.level
     ORDER BY reward.remove_at_level, reward.id
  LOOP
    PERFORM public.apply_level_reward_delivery(
      NEW.guild_id, NEW.member_id, v_reward.id, 'expiry', NEW.level
    );
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_levels_stage_crossed_rewards ON public.member_levels;
CREATE TRIGGER member_levels_stage_crossed_rewards
AFTER INSERT OR UPDATE OF level ON public.member_levels
FOR EACH ROW EXECUTE FUNCTION public.stage_crossed_level_rewards();

REVOKE ALL ON FUNCTION public.stage_crossed_level_rewards()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.level_reward_retry_dlq(
  p_dlq_id UUID,
  p_guild_id TEXT
)
RETURNS TABLE (action_id UUID, action_status TEXT, disposition TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dlq public.action_queue_dlq%ROWTYPE;
  v_action public.bot_action_queue%ROWTYPE;
  v_delivery public.level_reward_deliveries%ROWTYPE;
  v_disposition TEXT;
BEGIN
  SELECT dlq.* INTO v_dlq
    FROM public.action_queue_dlq AS dlq
   WHERE dlq.id = p_dlq_id
     AND dlq.guild_id = p_guild_id
   FOR UPDATE;
  IF NOT FOUND OR v_dlq.retried IS TRUE THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, 'already_retried'::TEXT;
    RETURN;
  END IF;
  IF v_dlq.action <> 'deliver_level_reward_roles'
     OR v_dlq.original_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, 'invalid_carrier'::TEXT;
    RETURN;
  END IF;

  SELECT queue.* INTO v_action
    FROM public.bot_action_queue AS queue
   WHERE queue.id = v_dlq.original_id::UUID
   FOR UPDATE;
  SELECT delivery.* INTO v_delivery
    FROM public.level_reward_deliveries AS delivery
   WHERE delivery.id = v_action.id
   FOR UPDATE;
  IF v_action.id IS NULL
     OR v_action.guild_id IS DISTINCT FROM p_guild_id
     OR v_action.action IS DISTINCT FROM v_dlq.action
     OR v_action.payload IS DISTINCT FROM v_dlq.payload
     OR v_action.payload ->> 'delivery_id' IS DISTINCT FROM v_action.id::TEXT
     OR v_delivery.id IS NULL
     OR v_delivery.guild_id IS DISTINCT FROM p_guild_id
     OR v_delivery.action_id IS DISTINCT FROM v_action.id
     OR v_delivery.status <> 'queued' THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, 'invalid_carrier'::TEXT;
    RETURN;
  END IF;

  IF v_action.status IN ('failed', 'staged') THEN
    UPDATE public.bot_action_queue AS queue
       SET status = 'pending', claim_token = NULL, started_at = NULL,
           completed_at = NULL, error_message = NULL, next_retry_at = NULL,
           retry_count = queue.retry_count + 1
     WHERE queue.id = v_action.id
     RETURNING queue.* INTO v_action;
    v_disposition := 'reopened';
  ELSIF v_action.status IN ('pending', 'processing') THEN
    v_disposition := 'already_active';
  ELSIF v_action.status = 'completed' THEN
    v_disposition := 'already_completed';
  ELSE
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, 'invalid_carrier'::TEXT;
    RETURN;
  END IF;

  UPDATE public.action_queue_dlq
     SET retried = true, retried_at = COALESCE(retried_at, pg_catalog.clock_timestamp())
   WHERE id = v_dlq.id;
  RETURN QUERY SELECT v_action.id, v_action.status, v_disposition;
END;
$$;

REVOKE ALL ON FUNCTION public.level_reward_retry_dlq(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.level_reward_retry_dlq(UUID, TEXT)
  TO service_role;
