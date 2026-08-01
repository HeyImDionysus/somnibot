-- Durable mass-action guard for automations.
--
-- A bulk occurrence is persisted before any member-targeted action runs. The
-- dashboard may approve or reject it; the bot atomically claims approved work
-- and completes it once. The held audit row is created in the same transaction
-- as the hold, so retries and restarts cannot duplicate or lose that audit.
BEGIN;

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS automation_mass_action_threshold INTEGER NOT NULL DEFAULT 25;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'guild_config_automation_mass_action_threshold_check'
  ) THEN
    ALTER TABLE public.guild_config
      ADD CONSTRAINT guild_config_automation_mass_action_threshold_check
      CHECK (automation_mass_action_threshold BETWEEN 1 AND 500);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.automation_mass_action_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  automation_id UUID NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  execution_id UUID REFERENCES public.automation_executions(id) ON DELETE SET NULL,
  occurrence_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'held' CHECK (
    status IN ('held', 'approved', 'executing', 'completed', 'rejected', 'failed')
  ),
  member_ids TEXT[] NOT NULL,
  member_count INTEGER NOT NULL CHECK (member_count > 0),
  threshold INTEGER NOT NULL CHECK (threshold > 0),
  trigger_event TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  action_snapshot JSONB NOT NULL CHECK (jsonb_typeof(action_snapshot) = 'array'),
  context_snapshot JSONB NOT NULL CHECK (jsonb_typeof(context_snapshot) = 'object'),
  notification_message_id TEXT,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  rejected_by TEXT,
  rejected_at TIMESTAMPTZ,
  execution_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT automation_mass_action_member_count_check
    CHECK (member_count = cardinality(member_ids)),
  CONSTRAINT automation_mass_action_exceeds_threshold_check
    CHECK (member_count > threshold),
  UNIQUE (guild_id, automation_id, occurrence_id)
);

CREATE INDEX IF NOT EXISTS idx_automation_mass_action_holds_pending
  ON public.automation_mass_action_holds(guild_id, status, created_at)
  WHERE status IN ('held', 'approved', 'executing');

ALTER TABLE public.automation_mass_action_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.automation_mass_action_holds FROM anon, authenticated;
GRANT ALL ON TABLE public.automation_mass_action_holds TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'automation_mass_action_holds'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE public.automation_mass_action_holds;
  END IF;
END $$;

CREATE TRIGGER update_automation_mass_action_holds_updated_at
  BEFORE UPDATE ON public.automation_mass_action_holds
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.audit_automation_mass_action_hold()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.audit_logs (
    guild_id,
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    details,
    success,
    occurrence_key
  ) VALUES (
    NEW.guild_id,
    'automation',
    NEW.automation_id::TEXT,
    'automation.mass_action_held',
    'automation',
    NEW.automation_id::TEXT,
    pg_catalog.jsonb_build_object(
      'holdId', NEW.id,
      'occurrenceId', NEW.occurrence_id,
      'memberCount', NEW.member_count,
      'threshold', NEW.threshold,
      'trigger', NEW.trigger_event
    ),
    true,
    'automation.mass_action_held:' || NEW.id::TEXT
  )
  ON CONFLICT (guild_id, occurrence_key) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_automation_mass_action_hold_insert
  ON public.automation_mass_action_holds;
CREATE TRIGGER audit_automation_mass_action_hold_insert
  AFTER INSERT ON public.automation_mass_action_holds
  FOR EACH ROW EXECUTE FUNCTION public.audit_automation_mass_action_hold();

CREATE OR REPLACE FUNCTION public.claim_approved_automation_mass_action_hold(
  p_hold_id UUID,
  p_guild_id TEXT
)
RETURNS SETOF public.automation_mass_action_holds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.automation_mass_action_holds
     SET status = 'executing',
         execution_started_at = pg_catalog.now(),
         last_error = NULL
   WHERE id = p_hold_id
     AND guild_id = p_guild_id
     AND status = 'approved'
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_approved_automation_mass_action_hold(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_approved_automation_mass_action_hold(UUID, TEXT)
  TO service_role;

COMMIT;
