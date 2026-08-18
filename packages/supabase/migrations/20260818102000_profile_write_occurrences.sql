CREATE TABLE IF NOT EXISTS public.profile_write_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('title', 'bio')),
  outcome TEXT NOT NULL DEFAULT 'claimed' CHECK (outcome IN ('claimed', 'applied', 'denied')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_profile_write_occurrences_guild_created
  ON public.profile_write_occurrences (guild_id, created_at DESC);

ALTER TABLE public.profile_write_occurrences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.profile_write_occurrences FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.profile_write_occurrences TO service_role;

INSERT INTO public.profile_write_occurrences (
  guild_id,
  interaction_id,
  actor_id,
  target_id,
  field,
  outcome,
  created_at,
  settled_at
)
SELECT
  audit.guild_id,
  audit.details->>'interactionId',
  audit.actor_id,
  audit.target_id,
  CASE audit.action
    WHEN 'profiles.title_updated' THEN 'title'
    ELSE 'bio'
  END,
  'applied',
  COALESCE(audit.timestamp, now()),
  COALESCE(audit.timestamp, now())
FROM public.audit_logs AS audit
JOIN public.guild AS existing_guild ON existing_guild.id = audit.guild_id
WHERE audit.action IN ('profiles.title_updated', 'profiles.bio_updated')
  AND COALESCE(audit.success, true)
  AND audit.target_id IS NOT NULL
  AND audit.details->>'interactionId' IS NOT NULL
  AND audit.details->>'interactionId' <> ''
ON CONFLICT (interaction_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.apply_profile_write_atomic(
  p_guild_id TEXT,
  p_interaction_id TEXT,
  p_actor_id TEXT,
  p_target_id TEXT,
  p_field TEXT,
  p_value TEXT,
  p_truncated BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_occurrence public.profile_write_occurrences%ROWTYPE;
  v_action TEXT;
  v_updated_at TIMESTAMPTZ;
BEGIN
  IF p_guild_id IS NULL OR p_guild_id = ''
    OR p_interaction_id IS NULL OR p_interaction_id = ''
    OR p_actor_id IS NULL OR p_actor_id = ''
    OR p_target_id IS NULL OR p_target_id = ''
    OR p_value IS NULL THEN
    RAISE EXCEPTION 'profile write identifiers and value are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_field NOT IN ('title', 'bio') THEN
    RAISE EXCEPTION 'unsupported profile field: %', p_field
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.profile_write_occurrences (
    guild_id,
    interaction_id,
    actor_id,
    target_id,
    field
  ) VALUES (
    p_guild_id,
    p_interaction_id,
    p_actor_id,
    p_target_id,
    p_field
  )
  ON CONFLICT (interaction_id) DO NOTHING
  RETURNING * INTO v_occurrence;

  IF NOT FOUND THEN
    SELECT occurrence.*
      INTO v_occurrence
      FROM public.profile_write_occurrences AS occurrence
     WHERE occurrence.interaction_id = p_interaction_id;

    IF v_occurrence.guild_id IS DISTINCT FROM p_guild_id
      OR v_occurrence.actor_id IS DISTINCT FROM p_actor_id
      OR v_occurrence.target_id IS DISTINCT FROM p_target_id
      OR v_occurrence.field IS DISTINCT FROM p_field THEN
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
        v_occurrence.guild_id,
        'discord',
        p_actor_id,
        'profiles.write_denied',
        'profiles',
        'member',
        p_target_id,
        jsonb_build_object(
          'actorId', p_actor_id,
          'targetId', p_target_id,
          'reason', 'interaction_identity_mismatch',
          'field', p_field,
          'interactionId', p_interaction_id,
          'originalGuildId', v_occurrence.guild_id,
          'originalActorId', v_occurrence.actor_id,
          'originalTargetId', v_occurrence.target_id,
          'originalField', v_occurrence.field
        ),
        'profile:' || v_occurrence.guild_id || ':' || v_occurrence.target_id,
        'profiles.write_denied:' || p_interaction_id || ':identity_mismatch',
        false,
        'interaction_identity_mismatch'
      ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;

      RETURN jsonb_build_object(
        'outcome', 'denied',
        'reason', 'interaction_identity_mismatch'
      );
    END IF;

    RETURN jsonb_build_object(
      'outcome', 'replayed',
      'originalOutcome', v_occurrence.outcome
    );
  END IF;

  IF p_actor_id <> p_target_id THEN
    UPDATE public.profile_write_occurrences
       SET outcome = 'denied',
           settled_at = now()
     WHERE id = v_occurrence.id;

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
      p_guild_id,
      'discord',
      p_actor_id,
      'profiles.write_denied',
      'profiles',
      'member',
      p_target_id,
      jsonb_build_object(
        'actorId', p_actor_id,
        'targetId', p_target_id,
        'reason', 'actor_target_mismatch',
        'field', p_field,
        'interactionId', p_interaction_id
      ),
      'profile:' || p_guild_id || ':' || p_target_id,
      'profiles.write_denied:' || p_interaction_id,
      false,
      'actor_target_mismatch'
    ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;

    RETURN jsonb_build_object(
      'outcome', 'denied',
      'reason', 'actor_target_mismatch'
    );
  END IF;

  IF p_field = 'title' THEN
    INSERT INTO public.economy_profiles (guild_id, user_id, title, updated_at)
    VALUES (p_guild_id, p_target_id, p_value, now())
    ON CONFLICT (guild_id, user_id) DO UPDATE
      SET title = EXCLUDED.title,
          updated_at = EXCLUDED.updated_at
    RETURNING updated_at INTO v_updated_at;
    v_action := 'profiles.title_updated';
  ELSE
    INSERT INTO public.economy_profiles (guild_id, user_id, bio, updated_at)
    VALUES (p_guild_id, p_target_id, p_value, now())
    ON CONFLICT (guild_id, user_id) DO UPDATE
      SET bio = EXCLUDED.bio,
          updated_at = EXCLUDED.updated_at
    RETURNING updated_at INTO v_updated_at;
    v_action := 'profiles.bio_updated';
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
    'discord',
    p_actor_id,
    v_action,
    'profiles',
    'member',
    p_target_id,
    jsonb_build_object(
      'value', p_value,
      'truncated', p_truncated,
      'interactionId', p_interaction_id
    ),
    'profile:' || p_guild_id || ':' || p_target_id,
    v_action || ':' || p_interaction_id,
    true
  ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;

  UPDATE public.profile_write_occurrences
     SET outcome = 'applied',
         settled_at = v_updated_at
   WHERE id = v_occurrence.id;

  RETURN jsonb_build_object('outcome', 'applied');
END;
$$;

REVOKE ALL ON FUNCTION public.apply_profile_write_atomic(
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_profile_write_atomic(
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  BOOLEAN
) TO service_role;
