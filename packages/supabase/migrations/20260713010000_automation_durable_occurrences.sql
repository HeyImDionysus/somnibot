-- Durable automation occurrences and execution/action claims.
-- This migration is intentionally separate from the active commerce recovery
-- migration. It closes replay races without broadening event/action ingress.

CREATE OR REPLACE FUNCTION public.automation_contract_is_valid(
  p_trigger_type TEXT,
  p_conditions JSONB,
  p_actions JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_entry JSONB;
BEGIN
  IF NOT COALESCE(p_trigger_type IN (
    'member.joined', 'member.left', 'member.verified', 'message.sent',
    'role.gained', 'role.lost', 'level.up', 'purchase.completed',
    'subscription.activated', 'subscription.lapsed', 'subscription.expired',
    'ticket.opened', 'ticket.closed', 'giveaway.ended', 'button.clicked',
    'reaction.added', 'voice.joined', 'voice.left', 'infraction.created'
  ), false)
     OR pg_catalog.jsonb_typeof(p_conditions) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(p_actions) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_conditions) > 5
     OR pg_catalog.jsonb_array_length(p_actions) > 10 THEN
    RETURN false;
  END IF;

  FOR v_entry IN SELECT value FROM pg_catalog.jsonb_array_elements(p_conditions)
  LOOP
    IF pg_catalog.jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_entry -> 'config') IS DISTINCT FROM 'object'
       OR NOT COALESCE(v_entry ->> 'type' IN (
         'has_role', 'missing_role', 'min_level', 'max_level', 'in_channel',
         'not_in_channel', 'has_entitlement', 'missing_entitlement',
         'message_contains', 'message_matches_regex', 'is_returning_member',
         'is_new_member', 'time_window', 'user_is'
       ), false) THEN
      RETURN false;
    END IF;
  END LOOP;

  FOR v_entry IN SELECT value FROM pg_catalog.jsonb_array_elements(p_actions)
  LOOP
    IF pg_catalog.jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_entry -> 'config') IS DISTINCT FROM 'object'
       OR NOT COALESCE(v_entry ->> 'type' IN (
         'send_message', 'send_dm', 'reply_to_message', 'give_role',
         'remove_role', 'add_reaction', 'delete_message', 'create_thread',
         'wait_delay', 'grant_entitlement', 'log_to_channel', 'create_ticket',
         'ban_member', 'kick_member', 'mute_member'
       ), false) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'automations_canonical_contract_check'
       AND conrelid = 'public.automations'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.automations
      ADD CONSTRAINT automations_canonical_contract_check
      CHECK (public.automation_contract_is_valid(trigger_type, conditions, actions))
      NOT VALID;
  END IF;
END;
$$;

CREATE TABLE public.automation_occurrences (
  id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'member.joined', 'member.left', 'member.verified', 'message.sent',
    'role.gained', 'role.lost', 'level.up', 'purchase.completed',
    'subscription.activated', 'subscription.lapsed', 'subscription.expired',
    'ticket.opened', 'ticket.closed', 'giveaway.ended', 'button.clicked',
    'reaction.added', 'voice.joined', 'voice.left', 'infraction.created'
  )),
  source_key TEXT NOT NULL CHECK (
    source_key <> '' AND source_key = pg_catalog.btrim(source_key)
    AND pg_catalog.length(source_key) <= 512
  ),
  event_data JSONB NOT NULL CHECK (pg_catalog.jsonb_typeof(event_data) = 'object'),
  chain_depth INTEGER NOT NULL DEFAULT 0 CHECK (chain_depth BETWEEN 0 AND 3),
  parent_action_execution_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (guild_id, source_key)
);

CREATE TABLE public.automation_transition_heads (
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  transition_key TEXT NOT NULL CHECK (
    transition_key <> '' AND transition_key = pg_catalog.btrim(transition_key)
    AND pg_catalog.length(transition_key) <= 512
  ),
  transition_state TEXT NOT NULL CHECK (
    transition_state <> '' AND transition_state = pg_catalog.btrim(transition_state)
    AND pg_catalog.length(transition_state) <= 512
  ),
  generation BIGINT NOT NULL CHECK (generation > 0),
  occurrence_id UUID REFERENCES public.automation_occurrences(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (guild_id, transition_key)
);

CREATE TABLE public.automation_durable_executions (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  occurrence_id UUID NOT NULL REFERENCES public.automation_occurrences(id) ON DELETE CASCADE,
  automation_id UUID NOT NULL,
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  automation_snapshot JSONB NOT NULL CHECK (
    pg_catalog.jsonb_typeof(automation_snapshot) = 'object'
  ),
  context_snapshot JSONB NOT NULL CHECK (
    pg_catalog.jsonb_typeof(context_snapshot) = 'object'
  ),
  status TEXT NOT NULL CHECK (status IN (
    'processing', 'succeeded', 'failed', 'uncertain'
  )),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  conditions_passed BOOLEAN,
  actions_executed INTEGER NOT NULL DEFAULT 0 CHECK (actions_executed >= 0),
  actions_failed INTEGER NOT NULL DEFAULT 0 CHECK (actions_failed >= 0),
  errors JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (pg_catalog.jsonb_typeof(errors) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (occurrence_id, automation_id)
);

CREATE TABLE public.automation_action_executions (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  execution_id UUID NOT NULL REFERENCES public.automation_durable_executions(id) ON DELETE CASCADE,
  action_index INTEGER NOT NULL CHECK (action_index BETWEEN 0 AND 9),
  action_type TEXT NOT NULL CHECK (action_type IN (
    'send_message', 'send_dm', 'reply_to_message', 'give_role',
    'remove_role', 'add_reaction', 'delete_message', 'create_thread',
    'wait_delay', 'grant_entitlement', 'log_to_channel', 'create_ticket',
    'ban_member', 'kick_member', 'mute_member'
  )),
  action_config JSONB NOT NULL CHECK (pg_catalog.jsonb_typeof(action_config) = 'object'),
  crash_policy TEXT NOT NULL CHECK (crash_policy IN ('retry', 'hold')),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'processing', 'succeeded', 'failed', 'uncertain'
  )),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  not_before TIMESTAMPTZ,
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (execution_id, action_index)
);

ALTER TABLE public.automation_occurrences
  ADD CONSTRAINT automation_occurrences_parent_action_fk
  FOREIGN KEY (parent_action_execution_id)
  REFERENCES public.automation_action_executions(id)
  ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX automation_occurrences_guild_created_idx
  ON public.automation_occurrences (guild_id, created_at DESC);
CREATE INDEX automation_durable_executions_resume_idx
  ON public.automation_durable_executions (guild_id, status, claimed_at);
CREATE INDEX automation_action_executions_resume_idx
  ON public.automation_action_executions (execution_id, status, not_before);

ALTER TABLE public.automation_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_transition_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_durable_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_action_executions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.automation_occurrences FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.automation_transition_heads FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.automation_durable_executions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.automation_action_executions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.automation_occurrences TO service_role;
GRANT ALL ON TABLE public.automation_transition_heads TO service_role;
GRANT ALL ON TABLE public.automation_durable_executions TO service_role;
GRANT ALL ON TABLE public.automation_action_executions TO service_role;

CREATE OR REPLACE FUNCTION public.automation_observe_transition(
  p_guild_id TEXT,
  p_transition_key TEXT,
  p_transition_state TEXT
)
RETURNS TABLE (disposition TEXT, generation BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_head public.automation_transition_heads%ROWTYPE;
  v_inserted BOOLEAN := false;
BEGIN
  IF p_guild_id IS NULL OR p_guild_id = '' OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR p_transition_key IS NULL OR p_transition_key = ''
     OR p_transition_key <> pg_catalog.btrim(p_transition_key)
     OR pg_catalog.length(p_transition_key) > 512
     OR p_transition_state IS NULL OR p_transition_state = ''
     OR p_transition_state <> pg_catalog.btrim(p_transition_state)
     OR pg_catalog.length(p_transition_state) > 512 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'automation_observe_transition: malformed transition identity';
  END IF;

  INSERT INTO public.automation_transition_heads (
    guild_id, transition_key, transition_state, generation, occurrence_id
  ) VALUES (
    p_guild_id, p_transition_key, p_transition_state, 1, NULL
  ) ON CONFLICT (guild_id, transition_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT head.* INTO v_head
    FROM public.automation_transition_heads AS head
   WHERE head.guild_id = p_guild_id
     AND head.transition_key = p_transition_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'automation_observe_transition: head disappeared';
  END IF;

  IF v_inserted OR v_head.transition_state = p_transition_state THEN
    RETURN QUERY SELECT CASE WHEN v_inserted THEN 'observed' ELSE 'duplicate' END,
      v_head.generation;
    RETURN;
  END IF;

  UPDATE public.automation_transition_heads
     SET transition_state = p_transition_state,
         generation = v_head.generation + 1,
         occurrence_id = NULL,
         updated_at = pg_catalog.clock_timestamp()
   WHERE guild_id = p_guild_id AND transition_key = p_transition_key
   RETURNING * INTO v_head;
  RETURN QUERY SELECT 'observed'::TEXT, v_head.generation;
END;
$$;

CREATE OR REPLACE FUNCTION public.automation_resolve_occurrence(
  p_candidate_occurrence_id UUID,
  p_guild_id TEXT,
  p_trigger_type TEXT,
  p_source_key TEXT,
  p_transition_key TEXT,
  p_transition_state TEXT,
  p_event_data JSONB,
  p_chain_depth INTEGER,
  p_parent_action_execution_id UUID DEFAULT NULL
)
RETURNS TABLE (
  disposition TEXT,
  occurrence_id UUID,
  event_data JSONB,
  chain_depth INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_occurrence public.automation_occurrences%ROWTYPE;
  v_head public.automation_transition_heads%ROWTYPE;
  v_occurrence_id UUID;
  v_source_key TEXT;
  v_generation BIGINT;
  v_inserted BOOLEAN := false;
  v_transition_mode BOOLEAN;
BEGIN
  v_transition_mode := p_transition_key IS NOT NULL OR p_transition_state IS NOT NULL;
  IF p_guild_id IS NULL OR p_guild_id = '' OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR NOT COALESCE(p_trigger_type IN (
       'member.joined', 'member.left', 'member.verified', 'message.sent',
       'role.gained', 'role.lost', 'level.up', 'purchase.completed',
       'subscription.activated', 'subscription.lapsed', 'subscription.expired',
       'ticket.opened', 'ticket.closed', 'giveaway.ended', 'button.clicked',
       'reaction.added', 'voice.joined', 'voice.left', 'infraction.created'
     ), false)
     OR pg_catalog.jsonb_typeof(p_event_data) IS DISTINCT FROM 'object'
     OR p_chain_depth IS NULL OR p_chain_depth NOT BETWEEN 0 AND 3
     OR (
       v_transition_mode AND (
         p_candidate_occurrence_id IS NOT NULL OR p_source_key IS NOT NULL
         OR p_transition_key IS NULL OR p_transition_state IS NULL
         OR p_transition_key = '' OR p_transition_state = ''
         OR p_transition_key <> pg_catalog.btrim(p_transition_key)
         OR p_transition_state <> pg_catalog.btrim(p_transition_state)
         OR pg_catalog.length(p_transition_key) > 512
         OR pg_catalog.length(p_transition_state) > 512
       )
     )
     OR (
       NOT v_transition_mode AND (
         p_candidate_occurrence_id IS NULL OR p_source_key IS NULL
         OR p_source_key = '' OR p_source_key <> pg_catalog.btrim(p_source_key)
         OR pg_catalog.length(p_source_key) > 512
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'automation_resolve_occurrence: malformed occurrence contract';
  END IF;

  IF NOT v_transition_mode THEN
    INSERT INTO public.automation_occurrences (
      id, guild_id, trigger_type, source_key, event_data, chain_depth,
      parent_action_execution_id
    ) VALUES (
      p_candidate_occurrence_id, p_guild_id, p_trigger_type, p_source_key,
      p_event_data, p_chain_depth, p_parent_action_execution_id
    ) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    SELECT occurrence.* INTO v_occurrence
      FROM public.automation_occurrences AS occurrence
     WHERE occurrence.guild_id = p_guild_id
       AND occurrence.source_key = p_source_key
     FOR UPDATE;
    IF NOT FOUND
       OR v_occurrence.id IS DISTINCT FROM p_candidate_occurrence_id
       OR v_occurrence.trigger_type IS DISTINCT FROM p_trigger_type
       OR v_occurrence.event_data IS DISTINCT FROM p_event_data
       OR v_occurrence.chain_depth IS DISTINCT FROM p_chain_depth
       OR v_occurrence.parent_action_execution_id IS DISTINCT FROM p_parent_action_execution_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'automation_resolve_occurrence: immutable identity conflict';
    END IF;
    RETURN QUERY SELECT CASE WHEN v_inserted THEN 'registered' ELSE 'duplicate' END,
      v_occurrence.id, v_occurrence.event_data, v_occurrence.chain_depth;
    RETURN;
  END IF;

  INSERT INTO public.automation_transition_heads (
    guild_id, transition_key, transition_state, generation, occurrence_id
  ) VALUES (
    p_guild_id, p_transition_key, p_transition_state, 1, NULL
  ) ON CONFLICT (guild_id, transition_key) DO NOTHING;

  SELECT head.* INTO v_head
    FROM public.automation_transition_heads AS head
   WHERE head.guild_id = p_guild_id
     AND head.transition_key = p_transition_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'automation_resolve_occurrence: transition head disappeared';
  END IF;

  IF v_head.transition_state = p_transition_state AND v_head.occurrence_id IS NOT NULL THEN
    SELECT occurrence.* INTO v_occurrence
      FROM public.automation_occurrences AS occurrence
     WHERE occurrence.id = v_head.occurrence_id
     FOR UPDATE;
    IF NOT FOUND OR v_occurrence.guild_id IS DISTINCT FROM p_guild_id
       OR v_occurrence.trigger_type IS DISTINCT FROM p_trigger_type THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'automation_resolve_occurrence: transition head conflict';
    END IF;
    RETURN QUERY SELECT 'duplicate'::TEXT, v_occurrence.id,
      v_occurrence.event_data, v_occurrence.chain_depth;
    RETURN;
  END IF;

  v_generation := CASE
    WHEN v_head.transition_state = p_transition_state THEN v_head.generation
    ELSE v_head.generation + 1
  END;
  v_occurrence_id := extensions.gen_random_uuid();
  v_source_key := p_transition_key || ':' || v_generation::TEXT;
  INSERT INTO public.automation_occurrences (
    id, guild_id, trigger_type, source_key, event_data, chain_depth,
    parent_action_execution_id
  ) VALUES (
    v_occurrence_id, p_guild_id, p_trigger_type, v_source_key, p_event_data,
    p_chain_depth, p_parent_action_execution_id
  );
  UPDATE public.automation_transition_heads
     SET transition_state = p_transition_state,
         generation = v_generation,
         occurrence_id = v_occurrence_id,
         updated_at = pg_catalog.clock_timestamp()
   WHERE guild_id = p_guild_id AND transition_key = p_transition_key;
  RETURN QUERY SELECT 'registered'::TEXT, v_occurrence_id, p_event_data, p_chain_depth;
END;
$$;

CREATE OR REPLACE FUNCTION public.automation_claim_execution(
  p_occurrence_id UUID,
  p_automation_id UUID,
  p_guild_id TEXT,
  p_automation_snapshot JSONB,
  p_context_snapshot JSONB
)
RETURNS TABLE (
  execution_id UUID,
  disposition TEXT,
  execution_status TEXT,
  claim_token UUID,
  automation_snapshot JSONB,
  context_snapshot JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_execution public.automation_durable_executions%ROWTYPE;
  v_occurrence public.automation_occurrences%ROWTYPE;
  v_inserted BOOLEAN := false;
  v_token UUID;
BEGIN
  IF p_occurrence_id IS NULL OR p_automation_id IS NULL
     OR p_guild_id IS NULL OR p_guild_id = '' OR p_guild_id <> pg_catalog.btrim(p_guild_id)
     OR pg_catalog.jsonb_typeof(p_automation_snapshot) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(p_context_snapshot) IS DISTINCT FROM 'object'
     OR p_automation_snapshot ->> 'id' IS DISTINCT FROM p_automation_id::TEXT THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'automation_claim_execution: malformed execution contract';
  END IF;
  SELECT occurrence.* INTO v_occurrence
    FROM public.automation_occurrences AS occurrence
   WHERE occurrence.id = p_occurrence_id
   FOR SHARE;
  IF NOT FOUND OR v_occurrence.guild_id IS DISTINCT FROM p_guild_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'automation_claim_execution: occurrence identity mismatch';
  END IF;

  v_token := extensions.gen_random_uuid();
  INSERT INTO public.automation_durable_executions (
    occurrence_id, automation_id, guild_id, automation_snapshot,
    context_snapshot, status, claim_token, claimed_at
  ) VALUES (
    p_occurrence_id, p_automation_id, p_guild_id, p_automation_snapshot,
    p_context_snapshot, 'processing', v_token, pg_catalog.clock_timestamp()
  ) ON CONFLICT (occurrence_id, automation_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT execution.* INTO v_execution
    FROM public.automation_durable_executions AS execution
   WHERE execution.occurrence_id = p_occurrence_id
     AND execution.automation_id = p_automation_id
   FOR UPDATE;
  IF NOT FOUND OR v_execution.guild_id IS DISTINCT FROM p_guild_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'automation_claim_execution: durable execution conflict';
  END IF;
  IF v_inserted THEN
    RETURN QUERY SELECT v_execution.id, 'claimed'::TEXT, v_execution.status,
      v_execution.claim_token, v_execution.automation_snapshot,
      v_execution.context_snapshot;
    RETURN;
  END IF;
  IF v_execution.status IN ('succeeded', 'failed', 'uncertain') THEN
    RETURN QUERY SELECT v_execution.id, 'terminal'::TEXT, v_execution.status,
      NULL::UUID, v_execution.automation_snapshot, v_execution.context_snapshot;
    RETURN;
  END IF;
  IF v_execution.claimed_at > pg_catalog.clock_timestamp() - INTERVAL '5 minutes' THEN
    RETURN QUERY SELECT v_execution.id, 'busy'::TEXT, v_execution.status,
      NULL::UUID, v_execution.automation_snapshot, v_execution.context_snapshot;
    RETURN;
  END IF;

  v_token := extensions.gen_random_uuid();
  UPDATE public.automation_durable_executions
     SET claim_token = v_token,
         claimed_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_execution.id
   RETURNING * INTO v_execution;
  RETURN QUERY SELECT v_execution.id, 'resumed'::TEXT, v_execution.status,
    v_execution.claim_token, v_execution.automation_snapshot,
    v_execution.context_snapshot;
END;
$$;

CREATE OR REPLACE FUNCTION public.automation_claim_action(
  p_execution_id UUID,
  p_execution_claim_token UUID,
  p_action_index INTEGER,
  p_action_type TEXT,
  p_action_config JSONB,
  p_crash_policy TEXT,
  p_delay_seconds INTEGER DEFAULT 0
)
RETURNS TABLE (
  action_execution_id UUID,
  disposition TEXT,
  action_status TEXT,
  claim_token UUID,
  action_type TEXT,
  action_config JSONB,
  not_before TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_execution public.automation_durable_executions%ROWTYPE;
  v_action public.automation_action_executions%ROWTYPE;
  v_inserted BOOLEAN := false;
  v_token UUID;
BEGIN
  IF p_execution_id IS NULL OR p_execution_claim_token IS NULL
     OR p_action_index NOT BETWEEN 0 AND 9
     OR NOT COALESCE(p_action_type IN (
       'send_message', 'send_dm', 'reply_to_message', 'give_role',
       'remove_role', 'add_reaction', 'delete_message', 'create_thread',
       'wait_delay', 'grant_entitlement', 'log_to_channel', 'create_ticket',
       'ban_member', 'kick_member', 'mute_member'
     ), false)
     OR pg_catalog.jsonb_typeof(p_action_config) IS DISTINCT FROM 'object'
     OR NOT COALESCE(p_crash_policy IN ('retry', 'hold'), false)
     OR p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 0 AND 3600 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'automation_claim_action: malformed action contract';
  END IF;
  SELECT execution.* INTO v_execution
    FROM public.automation_durable_executions AS execution
   WHERE execution.id = p_execution_id
   FOR UPDATE;
  IF NOT FOUND OR v_execution.status IS DISTINCT FROM 'processing'
     OR v_execution.claim_token IS DISTINCT FROM p_execution_claim_token THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'automation_claim_action: stale execution claim';
  END IF;

  INSERT INTO public.automation_action_executions (
    execution_id, action_index, action_type, action_config, crash_policy,
    status, not_before
  ) VALUES (
    p_execution_id, p_action_index, p_action_type, p_action_config,
    p_crash_policy, 'pending',
    CASE WHEN p_delay_seconds > 0
      THEN pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_delay_seconds)
      ELSE NULL END
  ) ON CONFLICT (execution_id, action_index) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT action.* INTO v_action
    FROM public.automation_action_executions AS action
   WHERE action.execution_id = p_execution_id
     AND action.action_index = p_action_index
   FOR UPDATE;
  IF NOT FOUND OR v_action.action_type IS DISTINCT FROM p_action_type THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'automation_claim_action: frozen action identity conflict';
  END IF;
  IF v_action.status = 'succeeded' THEN
    RETURN QUERY SELECT v_action.id, 'completed'::TEXT, v_action.status,
      NULL::UUID, v_action.action_type, v_action.action_config, v_action.not_before;
    RETURN;
  END IF;
  IF v_action.status IN ('failed', 'uncertain') THEN
    RETURN QUERY SELECT v_action.id, 'terminal'::TEXT, v_action.status,
      NULL::UUID, v_action.action_type, v_action.action_config, v_action.not_before;
    RETURN;
  END IF;
  IF v_action.status = 'pending' AND v_action.not_before > pg_catalog.clock_timestamp() THEN
    RETURN QUERY SELECT v_action.id, 'deferred'::TEXT, v_action.status,
      NULL::UUID, v_action.action_type, v_action.action_config, v_action.not_before;
    RETURN;
  END IF;
  IF v_action.status = 'processing'
     AND v_action.claimed_at > pg_catalog.clock_timestamp() - INTERVAL '5 minutes' THEN
    RETURN QUERY SELECT v_action.id, 'busy'::TEXT, v_action.status,
      NULL::UUID, v_action.action_type, v_action.action_config, v_action.not_before;
    RETURN;
  END IF;
  IF v_action.status = 'processing' AND v_action.crash_policy = 'hold' THEN
    UPDATE public.automation_action_executions
       SET status = 'uncertain',
           claim_token = NULL,
           error_message = 'Stale non-retry-safe action requires operator reconciliation',
           completed_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
     WHERE id = v_action.id
     RETURNING * INTO v_action;
    RETURN QUERY SELECT v_action.id, 'terminal'::TEXT, v_action.status,
      NULL::UUID, v_action.action_type, v_action.action_config, v_action.not_before;
    RETURN;
  END IF;

  v_token := extensions.gen_random_uuid();
  UPDATE public.automation_action_executions
     SET status = 'processing', claim_token = v_token,
         claimed_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_action.id
   RETURNING * INTO v_action;
  RETURN QUERY SELECT v_action.id,
    CASE WHEN v_inserted THEN 'claimed' ELSE 'resumed' END,
    v_action.status, v_action.claim_token, v_action.action_type,
    v_action.action_config, v_action.not_before;
END;
$$;

CREATE OR REPLACE FUNCTION public.automation_finish_action(
  p_execution_id UUID,
  p_execution_claim_token UUID,
  p_action_execution_id UUID,
  p_action_claim_token UUID,
  p_success BOOLEAN,
  p_result JSONB DEFAULT NULL,
  p_error TEXT DEFAULT NULL,
  p_uncertain BOOLEAN DEFAULT false
)
RETURNS TABLE (applied BOOLEAN, action_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action public.automation_action_executions%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.automation_durable_executions AS execution
     WHERE execution.id = p_execution_id
       AND execution.status = 'processing'
       AND execution.claim_token = p_execution_claim_token
  ) THEN
    RETURN QUERY SELECT false, 'stale_execution'::TEXT;
    RETURN;
  END IF;
  SELECT action.* INTO v_action
    FROM public.automation_action_executions AS action
   WHERE action.id = p_action_execution_id
     AND action.execution_id = p_execution_id
   FOR UPDATE;
  IF NOT FOUND OR v_action.status IS DISTINCT FROM 'processing'
     OR v_action.claim_token IS DISTINCT FROM p_action_claim_token THEN
    RETURN QUERY SELECT false, 'stale_action'::TEXT;
    RETURN;
  END IF;
  UPDATE public.automation_action_executions
     SET status = CASE
           WHEN p_uncertain THEN 'uncertain'
           WHEN p_success THEN 'succeeded'
           ELSE 'failed'
         END,
         claim_token = NULL,
         result = p_result,
         error_message = p_error,
         completed_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_action.id
   RETURNING * INTO v_action;
  RETURN QUERY SELECT true, v_action.status;
END;
$$;

CREATE OR REPLACE FUNCTION public.automation_finish_execution(
  p_execution_id UUID,
  p_claim_token UUID,
  p_status TEXT,
  p_conditions_passed BOOLEAN,
  p_actions_executed INTEGER,
  p_actions_failed INTEGER,
  p_errors JSONB
)
RETURNS TABLE (applied BOOLEAN, execution_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_execution public.automation_durable_executions%ROWTYPE;
BEGIN
  IF NOT COALESCE(p_status IN ('succeeded', 'failed', 'uncertain'), false)
     OR p_actions_executed IS NULL OR p_actions_executed < 0
     OR p_actions_failed IS NULL OR p_actions_failed < 0
     OR pg_catalog.jsonb_typeof(p_errors) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'automation_finish_execution: malformed result contract';
  END IF;
  UPDATE public.automation_durable_executions
     SET status = p_status,
         claim_token = NULL,
         conditions_passed = p_conditions_passed,
         actions_executed = p_actions_executed,
         actions_failed = p_actions_failed,
         errors = p_errors,
         completed_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = p_execution_id
     AND status = 'processing'
     AND claim_token = p_claim_token
   RETURNING * INTO v_execution;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'stale_execution'::TEXT;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, v_execution.status;
END;
$$;

REVOKE ALL ON FUNCTION public.automation_contract_is_valid(TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_observe_transition(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_resolve_occurrence(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, INTEGER, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_claim_execution(UUID, UUID, TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_claim_action(UUID, UUID, INTEGER, TEXT, JSONB, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_finish_action(UUID, UUID, UUID, UUID, BOOLEAN, JSONB, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_finish_execution(UUID, UUID, TEXT, BOOLEAN, INTEGER, INTEGER, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_contract_is_valid(TEXT, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.automation_observe_transition(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.automation_resolve_occurrence(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, INTEGER, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.automation_claim_execution(UUID, UUID, TEXT, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.automation_claim_action(UUID, UUID, INTEGER, TEXT, JSONB, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.automation_finish_action(UUID, UUID, UUID, UUID, BOOLEAN, JSONB, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.automation_finish_execution(UUID, UUID, TEXT, BOOLEAN, INTEGER, INTEGER, JSONB) TO service_role;

