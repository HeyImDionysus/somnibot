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
import { headers } from 'next/headers';
import { createAdminSupabase } from '@/lib/supabase/admin';

export interface RbacAuditEntry {
  guildId: string | null;
  actorId: string;
  action: string;
  targetType?: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
  readonly category?: string;
  readonly correlationId?: string;
  readonly occurrenceKey?: string;
  /** false for denied/blocked attempts. */
  success?: boolean;
}

export interface DashboardRequestMetadata {
  readonly route: string;
  readonly method: string;
  readonly occurrenceId: string;
}

export interface DashboardAuthorizationDenial {
  // Unauthenticated denials have no authoritative guild; never substitute a caller-controlled selector.
  readonly guildId: string | null;
  readonly actorId: string;
  readonly permission: string;
  readonly reason: string;
  readonly status: 401 | 403;
  readonly rbacIdentity?: string;
}

function boundedHeader(value: string | null, fallback: string): string {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 && normalized.length <= 256 ? normalized : fallback;
}

export async function readDashboardRequestMetadata(): Promise<DashboardRequestMetadata> {
  const requestHeaders = await headers();
  return {
    route: boundedHeader(requestHeaders.get('x-somnibot-request-route'), 'unknown'),
    method: boundedHeader(requestHeaders.get('x-somnibot-request-method'), 'UNKNOWN'),
    occurrenceId: boundedHeader(
      requestHeaders.get('x-somnibot-request-occurrence-id'),
      'unknown',
    ),
  };
}

export async function writeRbacAudit(
  admin: SupabaseClient,
  entry: RbacAuditEntry,
): Promise<void> {
  try {
    const row = {
      guild_id: entry.guildId,
      actor_type: 'dashboard',
      actor_id: entry.actorId,
      action: entry.action,
      category: entry.category ?? 'rbac',
      target_type: entry.targetType ?? 'dashboard_role',
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
      ...(entry.correlationId ? { correlation_id: entry.correlationId } : {}),
      ...(entry.occurrenceKey ? { occurrence_key: entry.occurrenceKey } : {}),
      ...(entry.guildId === null && entry.occurrenceKey
        ? { unscoped_occurrence_key: entry.occurrenceKey }
        : {}),
      success: entry.success ?? true,
    };

    if (entry.occurrenceKey) {
      if (entry.guildId === null) {
        await admin.from('audit_logs').upsert(row, {
          onConflict: 'unscoped_occurrence_key',
          ignoreDuplicates: true,
        });
        return;
      }
      await admin.from('audit_logs').upsert(row, {
        onConflict: 'guild_id,occurrence_key',
        ignoreDuplicates: true,
      });
      return;
    }

    await admin.from('audit_logs').insert(row);
  } catch {
    // Audit logging must never break the RBAC flow.
  }
}

export async function auditDashboardAuthorizationDenial(
  denial: DashboardAuthorizationDenial,
): Promise<void> {
  try {
    const request = await readDashboardRequestMetadata();
    await writeRbacAudit(createAdminSupabase(), {
      guildId: denial.guildId,
      actorId: denial.actorId,
      action: 'dashboard.authorization_denied',
      category: 'security',
      targetType: 'dashboard_route',
      targetId: request.route,
      details: {
        route: request.route,
        method: request.method,
        required_permission: denial.permission,
        reason: denial.reason,
        status: denial.status,
        ...(denial.rbacIdentity ? { rbac_identity: denial.rbacIdentity } : {}),
      },
      correlationId: `dashboard.authorization_denied:${request.occurrenceId}`,
      occurrenceKey: `dashboard.authorization_denied:${request.occurrenceId}`,
      success: false,
    });
  } catch {
    // Audit construction must not change the authorization response.
  }
}

export async function auditDashboardAuthorizationAllowed(authorization: {
  readonly guildId: string;
  readonly actorId: string;
  readonly permission: string;
  readonly rbacIdentity: string;
}): Promise<void> {
  try {
    const request = await readDashboardRequestMetadata();
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    await writeRbacAudit(createAdminSupabase(), {
      guildId: authorization.guildId,
      actorId: authorization.actorId,
      action: 'dashboard.authorization_allowed',
      category: 'security',
      targetType: 'dashboard_route',
      targetId: request.route,
      details: {
        route: request.route,
        method: request.method,
        required_permission: authorization.permission,
        rbac_identity: authorization.rbacIdentity,
        authorization_only: true,
      },
      occurrenceKey: `dashboard.authorization_allowed:${authorization.rbacIdentity}:${authorization.permission}:${hourBucket}`,
      success: true,
    });
  } catch (error) {
    console.warn('[rbac] Authorization observation unavailable', {
      failure: error instanceof Error ? 'observation_failed' : 'unknown_failure',
    });
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
