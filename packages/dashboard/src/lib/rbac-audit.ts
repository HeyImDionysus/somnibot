/**
 * RBAC audit helpers — service-role writers for the dashboard RBAC surfaces.
 *
 * The catalog (administration-rbac / administration-team-management) contracts
 * an append-only audit trail for every role/permission mutation AND an owner
 * notification when a privilege-escalation attempt is blocked. These helpers
 * centralise both writes using the same self-contained pattern the other
 * dashboard routes use (e.g. deploy, members/bulk, team-invitations): a direct
 * service-role insert that NEVER throws, so an observability write can never
 * fail the underlying request.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface RbacAuditEntry {
  guildId: string;
  actorId: string;
  action: string;
  targetType?: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
  /** false for denied/blocked attempts. */
  success?: boolean;
}

/**
 * Write an rbac.* audit_logs row via the service-role client. Best-effort.
 */
export async function writeRbacAudit(
  admin: SupabaseClient,
  entry: RbacAuditEntry,
): Promise<void> {
  try {
    await admin.from('audit_logs').insert({
      guild_id: entry.guildId,
      actor_type: 'dashboard',
      actor_id: entry.actorId,
      action: entry.action,
      category: 'rbac',
      target_type: entry.targetType ?? 'dashboard_role',
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
      success: entry.success ?? true,
    });
  } catch {
    // Audit logging must never break the RBAC flow.
  }
}

/**
 * Raise an owner-facing alert when a privilege-escalation attempt is blocked.
 * Mirrors the alerts-table pattern used across the dashboard so the owner
 * operations surface (and any DM sweeper reading `alerts`) sees the attempt.
 * Best-effort — a failed alert insert must not fail the request.
 */
export async function raiseEscalationBlockedAlert(
  admin: SupabaseClient,
  args: {
    guildId: string;
    actorId: string;
    attemptedAction: string;
    targetRoleId: string;
    reason: string;
  },
): Promise<void> {
  try {
    await admin.from('alerts').insert({
      guild_id: args.guildId,
      alert_type: 'escalation_blocked',
      severity: 'warning',
      title: 'Blocked privilege-escalation attempt',
      message: `${args.actorId} attempted ${args.attemptedAction} but was blocked: ${args.reason}`,
      metadata: {
        actor_id: args.actorId,
        attempted_action: args.attemptedAction,
        target_role_id: args.targetRoleId,
        reason: args.reason,
      },
    });
  } catch {
    // Owner-alert mirror is best-effort.
  }
}
