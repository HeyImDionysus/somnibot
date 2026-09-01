-- Accepting a team invitation must grant the dashboard role in the same
-- transaction as the pending -> accepted transition. Locking the invitation
-- row also fences a concurrent revoke: exactly one terminal transition wins.
CREATE OR REPLACE FUNCTION public.accept_team_invitation_atomic(
  p_invitation_id uuid,
  p_discord_id text
)
RETURNS TABLE (
  outcome text,
  invitation_id uuid,
  guild_id text,
  role_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_invitation public.team_invitations%ROWTYPE;
BEGIN
  SELECT invitation.*
  INTO v_invitation
  FROM public.team_invitations AS invitation
  WHERE invitation.id = p_invitation_id
    AND invitation.discord_id = p_discord_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  IF v_invitation.status = 'accepted' THEN
    INSERT INTO public.dashboard_user_roles (
      guild_id,
      discord_id,
      role_id,
      assigned_by
    ) VALUES (
      v_invitation.guild_id,
      v_invitation.discord_id,
      v_invitation.role_id,
      COALESCE(v_invitation.invited_by, v_invitation.discord_id)
    )
    ON CONFLICT ON CONSTRAINT dashboard_user_roles_guild_discord_role_key DO NOTHING;

    RETURN QUERY SELECT
      'already_accepted'::text,
      v_invitation.id,
      v_invitation.guild_id,
      v_invitation.role_id;
    RETURN;
  END IF;

  IF v_invitation.status <> 'pending' THEN
    RETURN QUERY SELECT
      v_invitation.status,
      v_invitation.id,
      v_invitation.guild_id,
      v_invitation.role_id;
    RETURN;
  END IF;

  IF v_invitation.expires_at <= clock_timestamp() THEN
    RETURN QUERY SELECT
      'expired'::text,
      v_invitation.id,
      v_invitation.guild_id,
      v_invitation.role_id;
    RETURN;
  END IF;

  INSERT INTO public.dashboard_user_roles (
    guild_id,
    discord_id,
    role_id,
    assigned_by
  ) VALUES (
    v_invitation.guild_id,
    v_invitation.discord_id,
    v_invitation.role_id,
    COALESCE(v_invitation.invited_by, v_invitation.discord_id)
  )
  ON CONFLICT ON CONSTRAINT dashboard_user_roles_guild_discord_role_key DO NOTHING;

  UPDATE public.team_invitations AS invitation
  SET status = 'accepted',
      accepted_at = clock_timestamp(),
      responded_at = clock_timestamp(),
      accept_notified = false
  WHERE invitation.id = v_invitation.id
    AND invitation.status = 'pending';

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
    v_invitation.guild_id,
    'dashboard',
    p_discord_id,
    'team.invite_accepted',
    'rbac',
    'team_invitation',
    p_discord_id,
    jsonb_build_object(
      'invitation_id', v_invitation.id,
      'role_id', v_invitation.role_id,
      'invited_by', v_invitation.invited_by
    ),
    'team-invitation:' || v_invitation.id::text,
    'team.invite_accepted:' || v_invitation.id::text,
    true
  )
  ON CONFLICT (guild_id, occurrence_key) DO NOTHING;

  RETURN QUERY SELECT
    'accepted'::text,
    v_invitation.id,
    v_invitation.guild_id,
    v_invitation.role_id;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_team_invitation_atomic(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_team_invitation_atomic(uuid, text) TO service_role;
