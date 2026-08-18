BEGIN;

ALTER TABLE public.scheduled_messages
  ADD COLUMN IF NOT EXISTS next_occurrence_at TIMESTAMPTZ;

ALTER TABLE public.scheduled_messages
  DROP CONSTRAINT IF EXISTS scheduled_messages_next_occurrence_minute;
ALTER TABLE public.scheduled_messages
  ADD CONSTRAINT scheduled_messages_next_occurrence_minute
  CHECK (
    next_occurrence_at IS NULL
    OR next_occurrence_at = pg_catalog.date_trunc('minute', next_occurrence_at)
  );

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_next_occurrence
  ON public.scheduled_messages(next_occurrence_at)
  WHERE active = TRUE AND status = 'active' AND next_occurrence_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.scheduled_cron_field_matches(
  p_field TEXT,
  p_value INTEGER,
  p_minimum INTEGER,
  p_maximum INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
DECLARE
  item TEXT;
  range_text TEXT;
  range_start INTEGER;
  range_end INTEGER;
  step_value INTEGER;
BEGIN
  IF p_value < p_minimum OR p_value > p_maximum THEN
    RETURN FALSE;
  END IF;

  FOREACH item IN ARRAY pg_catalog.string_to_array(p_field, ',') LOOP
    IF item = '*' THEN
      RETURN TRUE;
    ELSIF item ~ '^\*/[1-9][0-9]*$' THEN
      step_value := pg_catalog.split_part(item, '/', 2)::INTEGER;
      IF p_value % step_value = 0 THEN
        RETURN TRUE;
      END IF;
    ELSIF item ~ '^[0-9]+-[0-9]+/[1-9][0-9]*$' THEN
      range_text := pg_catalog.split_part(item, '/', 1);
      range_start := pg_catalog.split_part(range_text, '-', 1)::INTEGER;
      range_end := pg_catalog.split_part(range_text, '-', 2)::INTEGER;
      step_value := pg_catalog.split_part(item, '/', 2)::INTEGER;
      IF p_value BETWEEN range_start AND range_end
         AND (p_value - range_start) % step_value = 0 THEN
        RETURN TRUE;
      END IF;
    ELSIF item ~ '^[0-9]+-[0-9]+$' THEN
      range_start := pg_catalog.split_part(item, '-', 1)::INTEGER;
      range_end := pg_catalog.split_part(item, '-', 2)::INTEGER;
      IF p_value BETWEEN range_start AND range_end THEN
        RETURN TRUE;
      END IF;
    ELSIF item ~ '^[0-9]+$' AND item::INTEGER = p_value THEN
      RETURN TRUE;
    END IF;
  END LOOP;

  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.scheduled_message_next_occurrence(
  p_cron_expression TEXT,
  p_timezone TEXT,
  p_after TIMESTAMPTZ,
  p_start_date TIMESTAMPTZ DEFAULT NULL,
  p_end_date TIMESTAMPTZ DEFAULT NULL
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  fields TEXT[];
  timezone_name TEXT;
  local_day DATE;
  local_candidate TIMESTAMP;
  candidate TIMESTAMPTZ;
  day_offset INTEGER;
  hour_value INTEGER;
  minute_value INTEGER;
  value_exists BOOLEAN;
BEGIN
  IF p_cron_expression IS NULL OR p_after IS NULL THEN
    RETURN NULL;
  END IF;

  fields := pg_catalog.regexp_split_to_array(pg_catalog.btrim(p_cron_expression), '\s+');
  IF pg_catalog.array_length(fields, 1) IS DISTINCT FROM 5 THEN
    RETURN NULL;
  END IF;

  SELECT timezone.name
    INTO timezone_name
    FROM pg_catalog.pg_timezone_names AS timezone
   WHERE timezone.name = COALESCE(NULLIF(pg_catalog.btrim(p_timezone), ''), 'UTC');
  timezone_name := COALESCE(timezone_name, 'UTC');

  value_exists := FALSE;
  FOR minute_value IN 0..59 LOOP
    IF public.scheduled_cron_field_matches(fields[1], minute_value, 0, 59) THEN
      value_exists := TRUE;
      EXIT;
    END IF;
  END LOOP;
  IF NOT value_exists THEN RETURN NULL; END IF;

  value_exists := FALSE;
  FOR hour_value IN 0..23 LOOP
    IF public.scheduled_cron_field_matches(fields[2], hour_value, 0, 23) THEN
      value_exists := TRUE;
      EXIT;
    END IF;
  END LOOP;
  IF NOT value_exists THEN RETURN NULL; END IF;

  value_exists := FALSE;
  FOR day_offset IN 1..31 LOOP
    IF public.scheduled_cron_field_matches(fields[3], day_offset, 1, 31) THEN
      value_exists := TRUE;
      EXIT;
    END IF;
  END LOOP;
  IF NOT value_exists THEN RETURN NULL; END IF;

  value_exists := FALSE;
  FOR day_offset IN 1..12 LOOP
    IF public.scheduled_cron_field_matches(fields[4], day_offset, 1, 12) THEN
      value_exists := TRUE;
      EXIT;
    END IF;
  END LOOP;
  IF NOT value_exists THEN RETURN NULL; END IF;

  value_exists := FALSE;
  FOR day_offset IN 0..6 LOOP
    IF public.scheduled_cron_field_matches(fields[5], day_offset, 0, 7) THEN
      value_exists := TRUE;
      EXIT;
    END IF;
  END LOOP;
  IF NOT value_exists THEN RETURN NULL; END IF;

  local_day := (p_after AT TIME ZONE timezone_name)::DATE;
  FOR day_offset IN 0..2928 LOOP
    IF public.scheduled_cron_field_matches(fields[3], EXTRACT(DAY FROM local_day)::INTEGER, 1, 31)
       AND public.scheduled_cron_field_matches(fields[4], EXTRACT(MONTH FROM local_day)::INTEGER, 1, 12)
       AND public.scheduled_cron_field_matches(fields[5], EXTRACT(DOW FROM local_day)::INTEGER, 0, 7) THEN
      FOR hour_value IN 0..23 LOOP
        IF public.scheduled_cron_field_matches(fields[2], hour_value, 0, 23) THEN
          FOR minute_value IN 0..59 LOOP
            IF public.scheduled_cron_field_matches(fields[1], minute_value, 0, 59) THEN
              local_candidate := local_day
                + pg_catalog.make_interval(hours => hour_value, mins => minute_value);
              candidate := local_candidate AT TIME ZONE timezone_name;
              IF candidate AT TIME ZONE timezone_name = local_candidate
                 AND candidate > p_after
                 AND (p_start_date IS NULL OR candidate >= p_start_date)
                 AND (p_end_date IS NULL OR candidate <= p_end_date) THEN
                RETURN candidate;
              END IF;
            END IF;
          END LOOP;
        END IF;
      END LOOP;
    END IF;
    local_day := local_day + 1;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_scheduled_message_next_occurrence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  calculation_floor TIMESTAMPTZ;
BEGIN
  IF NEW.active IS DISTINCT FROM TRUE
     OR NEW.status IS DISTINCT FROM 'active'
     OR (NEW.max_sends IS NOT NULL AND NEW.current_sends >= NEW.max_sends)
     OR (NEW.end_date IS NOT NULL AND NEW.end_date < pg_catalog.now()) THEN
    NEW.next_occurrence_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.start_date IS NOT NULL AND NEW.start_date > pg_catalog.now() THEN
    calculation_floor := NEW.start_date - pg_catalog.make_interval(mins => 1);
  ELSE
    calculation_floor := pg_catalog.date_trunc('minute', pg_catalog.now());
  END IF;

  NEW.next_occurrence_at := public.scheduled_message_next_occurrence(
    NEW.cron_expression,
    NEW.timezone,
    calculation_floor,
    NEW.start_date,
    NEW.end_date
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_scheduled_message_next_occurrence ON public.scheduled_messages;
CREATE TRIGGER set_scheduled_message_next_occurrence
BEFORE INSERT OR UPDATE OF cron_expression, timezone, start_date, end_date, max_sends, active, status
ON public.scheduled_messages
FOR EACH ROW
EXECUTE FUNCTION public.set_scheduled_message_next_occurrence();

UPDATE public.scheduled_messages AS schedule
   SET next_occurrence_at = CASE
     WHEN schedule.active = TRUE
      AND schedule.status = 'active'
      AND (schedule.max_sends IS NULL OR schedule.current_sends < schedule.max_sends)
      AND (schedule.end_date IS NULL OR schedule.end_date >= pg_catalog.now())
     THEN public.scheduled_message_next_occurrence(
       schedule.cron_expression,
       schedule.timezone,
       COALESCE(
         schedule.last_sent_at,
         CASE
           WHEN schedule.start_date IS NOT NULL
             THEN schedule.start_date - pg_catalog.make_interval(mins => 1)
           ELSE pg_catalog.date_trunc('minute', pg_catalog.now())
         END
       ),
       schedule.start_date,
       schedule.end_date
     )
     ELSE NULL
   END;

DO $$
DECLARE
  unresolved_count INTEGER;
BEGIN
  SELECT pg_catalog.count(*)::INTEGER
    INTO unresolved_count
    FROM public.scheduled_messages AS schedule
   WHERE schedule.active = TRUE
     AND schedule.status = 'active'
     AND (schedule.max_sends IS NULL OR schedule.current_sends < schedule.max_sends)
     AND (schedule.end_date IS NULL OR schedule.end_date >= pg_catalog.now())
     AND schedule.next_occurrence_at IS NULL;
  IF unresolved_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = pg_catalog.format(
        'scheduled next-occurrence backfill left %s active schedules unresolved',
        unresolved_count
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_scheduled_message_send(
  p_schedule_id UUID,
  p_guild_id TEXT,
  p_occurrence_at TIMESTAMPTZ,
  p_occurrence_id UUID DEFAULT NULL,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  claimed_count INTEGER;
  schedule_updated_at TIMESTAMPTZ;
  occ_result JSONB;
  occ_status TEXT;
  occ_updated_at TIMESTAMPTZ;
BEGIN
  IF p_occurrence_id IS NOT NULL THEN
    SELECT occurrence.result, occurrence.status, occurrence.updated_at
      INTO occ_result, occ_status, occ_updated_at
      FROM public.discord_operation_occurrences AS occurrence
     WHERE occurrence.id = p_occurrence_id
       FOR UPDATE;
    IF p_expected_updated_at IS NOT NULL
       AND (NOT FOUND
            OR occ_status IS DISTINCT FROM 'claimed'
            OR occ_updated_at IS DISTINCT FROM p_expected_updated_at) THEN
      RETURN -1;
    END IF;
    IF FOUND AND COALESCE(occ_result->>'counterReserved', 'false') = 'true' THEN
      SELECT schedule.current_sends INTO claimed_count
        FROM public.scheduled_messages AS schedule
       WHERE schedule.id = p_schedule_id
         AND schedule.guild_id = p_guild_id;
      RETURN claimed_count;
    END IF;
  END IF;

  UPDATE public.scheduled_messages AS schedule
     SET current_sends = schedule.current_sends + 1,
         last_sent_at = GREATEST(
           COALESCE(schedule.last_sent_at, '-infinity'::TIMESTAMPTZ),
           p_occurrence_at
         ),
         next_occurrence_at = CASE
           WHEN schedule.missed_run_policy = 'send-latest'
             AND schedule.next_occurrence_at < p_occurrence_at
             THEN p_occurrence_at
           ELSE schedule.next_occurrence_at
         END
   WHERE schedule.id = p_schedule_id
     AND schedule.guild_id = p_guild_id
     AND schedule.active = TRUE
     AND schedule.status = 'active'
     AND (
       schedule.next_occurrence_at IS NOT DISTINCT FROM p_occurrence_at
       OR (
         schedule.missed_run_policy = 'send-latest'
         AND schedule.next_occurrence_at < p_occurrence_at
         AND p_occurrence_at <= pg_catalog.date_trunc('minute', pg_catalog.now())
       )
     )
     AND (schedule.max_sends IS NULL OR schedule.current_sends < schedule.max_sends)
  RETURNING schedule.current_sends, schedule.updated_at
       INTO claimed_count, schedule_updated_at;

  IF claimed_count IS NOT NULL AND p_occurrence_id IS NOT NULL THEN
    UPDATE public.discord_operation_occurrences
       SET result = COALESCE(result, '{}'::JSONB)
                    || pg_catalog.jsonb_build_object(
                      'counterReserved', TRUE,
                      'scheduleUpdatedAt', schedule_updated_at
                    )
     WHERE id = p_occurrence_id;
  END IF;

  RETURN claimed_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_scheduled_message_send(
  p_schedule_id UUID,
  p_guild_id TEXT,
  p_occurrence_id UUID,
  p_occurrence_at TIMESTAMPTZ,
  p_resource_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  schedule_row public.scheduled_messages%ROWTYPE;
  occurrence_result JSONB;
  occurrence_status TEXT;
  next_at TIMESTAMPTZ;
BEGIN
  SELECT occurrence.status, occurrence.result
    INTO occurrence_status, occurrence_result
    FROM public.discord_operation_occurrences AS occurrence
   WHERE occurrence.id = p_occurrence_id
     AND occurrence.guild_id = p_guild_id
     AND occurrence.operation_kind = 'scheduled_message'
   FOR UPDATE;

  IF NOT FOUND
     OR occurrence_status IS DISTINCT FROM 'claimed'
     OR COALESCE(occurrence_result->>'counterReserved', 'false') <> 'true' THEN
    RETURN FALSE;
  END IF;

  SELECT schedule.*
    INTO schedule_row
    FROM public.scheduled_messages AS schedule
   WHERE schedule.id = p_schedule_id
     AND schedule.guild_id = p_guild_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF schedule_row.next_occurrence_at IS NOT NULL
     AND schedule_row.next_occurrence_at <= p_occurrence_at THEN
    IF schedule_row.active IS DISTINCT FROM TRUE
       OR schedule_row.status IS DISTINCT FROM 'active'
       OR (schedule_row.max_sends IS NOT NULL AND schedule_row.current_sends >= schedule_row.max_sends)
       OR (schedule_row.end_date IS NOT NULL AND schedule_row.end_date <= p_occurrence_at) THEN
      next_at := NULL;
    ELSE
      next_at := public.scheduled_message_next_occurrence(
        schedule_row.cron_expression,
        schedule_row.timezone,
        p_occurrence_at,
        schedule_row.start_date,
        schedule_row.end_date
      );
    END IF;

    UPDATE public.scheduled_messages
       SET next_occurrence_at = next_at
     WHERE id = p_schedule_id;
  END IF;

  UPDATE public.discord_operation_occurrences
     SET status = 'completed',
         resource_id = p_resource_id,
         result = COALESCE(result, '{}'::JSONB)
                  || pg_catalog.jsonb_build_object(
                    'channelId', schedule_row.channel_id,
                    'dueAt', p_occurrence_at
                  ),
         last_error = NULL,
         completed_at = pg_catalog.now()
   WHERE id = p_occurrence_id
     AND status = 'claimed';

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.skip_scheduled_message_occurrences(
  p_schedule_id UUID,
  p_guild_id TEXT,
  p_expected_next_occurrence_at TIMESTAMPTZ,
  p_last_occurrence_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  schedule_row public.scheduled_messages%ROWTYPE;
  next_at TIMESTAMPTZ;
BEGIN
  SELECT schedule.*
    INTO schedule_row
    FROM public.scheduled_messages AS schedule
   WHERE schedule.id = p_schedule_id
     AND schedule.guild_id = p_guild_id
   FOR UPDATE;
  IF NOT FOUND
     OR schedule_row.next_occurrence_at IS DISTINCT FROM p_expected_next_occurrence_at THEN
    RETURN FALSE;
  END IF;

  next_at := public.scheduled_message_next_occurrence(
    schedule_row.cron_expression,
    schedule_row.timezone,
    p_last_occurrence_at,
    schedule_row.start_date,
    schedule_row.end_date
  );
  UPDATE public.scheduled_messages
     SET last_sent_at = GREATEST(
           COALESCE(last_sent_at, '-infinity'::TIMESTAMPTZ),
           p_last_occurrence_at
         ),
         next_occurrence_at = next_at
   WHERE id = p_schedule_id;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.scheduled_cron_field_matches(TEXT, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scheduled_message_next_occurrence(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_scheduled_message_next_occurrence()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_scheduled_message_send(UUID, TEXT, TIMESTAMPTZ, UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_scheduled_message_send(UUID, TEXT, UUID, TIMESTAMPTZ, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skip_scheduled_message_occurrences(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.scheduled_message_next_occurrence(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_scheduled_message_send(UUID, TEXT, TIMESTAMPTZ, UUID, TIMESTAMPTZ)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_scheduled_message_send(UUID, TEXT, UUID, TIMESTAMPTZ, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.skip_scheduled_message_occurrences(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ)
  TO service_role;

COMMIT;
