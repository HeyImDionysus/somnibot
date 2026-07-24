/**
 * Team-invitation helpers — consent-based dashboard-team invitations.
 *
 * The catalog (administration-team-management) contracts that a member is
 * invited to a specific dashboard role, notified by DM with a clear accept
 * path, and gains permissions only upon acceptance. These helpers back the
 * invitation routes (create in POST /api/rbac/users, list, accept, revoke) and
 * centralise:
 *   - the four catalog control defaults + guild_config loader,
 *   - the raw-session Discord identity (the invitee has no guild scope yet, so
 *     the guild-scoped getAuthContext() cannot be used to bind acceptance), and
 *   - a service-role audit writer for the team.* lifecycle events.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabase } from '@/lib/supabase/server';

// ── Catalog control defaults (administration.json:743-763) ──────────────────
export const TEAM_CONTROL_DEFAULTS = {
  directAssignmentEnabled: false,
  inviteDmEnabled: true,
  maxPendingInvitations: 25,
  invitationExpiryMs: 259_200_000, // 72h
} as const;

export const INVITATION_EXPIRY_MIN_MS = 3_600_000; // 1h
export const INVITATION_EXPIRY_MAX_MS = 2_592_000_000; // 30d
export const MAX_PENDING_FLOOR = 1;
export const MAX_PENDING_CEIL = 100;

export interface TeamConfig {
  directAssignmentEnabled: boolean;
  inviteDmEnabled: boolean;
  maxPendingInvitations: number;
  invitationExpiryMs: number;
}

interface TeamConfigRow {
  team_direct_assignment_enabled: boolean | null;
  team_invite_dm_enabled: boolean | null;
  team_max_pending_invitations: number | null;
  team_invitation_expiry_ms: number | null;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Load the four team-invitation controls for a guild, falling back to the
 * catalog defaults when the row (or a column) is missing. Values are clamped to
 * the advertised constraints so a stale/hand-edited row can never widen the
 * blast radius beyond the catalog envelope.
 */
export async function loadTeamConfig(
  admin: SupabaseClient,
  guildId: string,
): Promise<TeamConfig> {
  const { data } = await admin
    .from('guild_config')
    .select(
      'team_direct_assignment_enabled, team_invite_dm_enabled, team_max_pending_invitations, team_invitation_expiry_ms',
    )
    .eq('guild_id', guildId)
    .maybeSingle();

  const row = (data ?? null) as TeamConfigRow | null;

  return {
    directAssignmentEnabled:
      row?.team_direct_assignment_enabled ?? TEAM_CONTROL_DEFAULTS.directAssignmentEnabled,
    inviteDmEnabled: row?.team_invite_dm_enabled ?? TEAM_CONTROL_DEFAULTS.inviteDmEnabled,
    maxPendingInvitations: clamp(
      row?.team_max_pending_invitations ?? TEAM_CONTROL_DEFAULTS.maxPendingInvitations,
      MAX_PENDING_FLOOR,
      MAX_PENDING_CEIL,
    ),
    invitationExpiryMs: clamp(
      row?.team_invitation_expiry_ms ?? TEAM_CONTROL_DEFAULTS.invitationExpiryMs,
      INVITATION_EXPIRY_MIN_MS,
      INVITATION_EXPIRY_MAX_MS,
    ),
  };
}

// ── Raw-session Discord identity ────────────────────────────────────────────

export interface SessionIdentity {
  userId: string;
  discordId: string;
}

function extractDiscordId(user: { user_metadata?: Record<string, unknown> }): string | null {
  const meta = user.user_metadata;
  if (!meta) return null;
  return (meta.provider_id as string) || (meta.sub as string) || null;
}

/**
 * Resolve the signed-in user's raw Discord OAuth identity WITHOUT requiring a
 * guild scope. The invitee has no owned guild and no dashboard_user_roles
 * assignment yet, so getAuthContext() would reject them — but acceptance binds
 * purely on `session OAuth id == invitation.discord_id`, which only needs the
 * raw identity. Returns null when unauthenticated or the provider id is absent.
 */
export async function getSessionIdentity(): Promise<SessionIdentity | null> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const discordId = extractDiscordId(user);
  if (!discordId) return null;
  return { userId: user.id, discordId };
}

// ── Audit writer (service role) ─────────────────────────────────────────────

export interface TeamAuditEntry {
  guildId: string;
  actorId: string;
  action: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
  success?: boolean;
}

/**
 * Write a team.* audit_logs row directly via the service-role client — the same
 * self-contained pattern the other dashboard routes use (e.g. members/bulk,
 * deploy). Never throws: a failed audit insert must not fail the request.
 */
export async function writeTeamAudit(
  admin: SupabaseClient,
  entry: TeamAuditEntry,
): Promise<void> {
  try {
    await admin.from('audit_logs').insert({
      guild_id: entry.guildId,
      actor_type: 'dashboard',
      actor_id: entry.actorId,
      action: entry.action,
      target_type: 'team_invitation',
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
      success: entry.success ?? true,
    });
  } catch {
    // Audit logging must never break the invitation flow.
  }
}
