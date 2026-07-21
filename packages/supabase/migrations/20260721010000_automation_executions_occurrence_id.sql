-- Durable automation occurrence idempotency.
--
-- automation-engine mints occurrenceId: randomUUID() fresh per event DELIVERY,
-- so a gateway RESUME/reconnect redelivery of the same event gets a NEW
-- occurrence id → the grant_entitlement action (whose idempotency requestId is
-- derived from occurrenceId) re-grants, and send_message/give_role actions
-- re-fire. There is no durable claim, so the same occurrence is processed twice.
--
-- Add a durable occurrence id + a per-(guild, automation) unique claim so a
-- redelivered occurrence is recognized and skipped. The engine now derives a
-- STABLE occurrence id from the event's durable Discord-native identity (message
-- id, order number, ticket number, level, …) when one exists; events with no
-- durable key keep a random id and are simply never deduped (unchanged behavior).

ALTER TABLE public.automation_executions
  ADD COLUMN IF NOT EXISTS occurrence_id text;

-- One execution row per (guild, automation, occurrence). Partial so the many
-- keyless (random-id) executions are unaffected and legacy NULL rows don't clash.
CREATE UNIQUE INDEX IF NOT EXISTS automation_executions_occurrence_uidx
  ON public.automation_executions (guild_id, automation_id, occurrence_id)
  WHERE occurrence_id IS NOT NULL;
