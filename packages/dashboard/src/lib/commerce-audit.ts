/**
 * Commerce audit writer (service role).
 *
 * The customer portal and license routes live in the Next.js dashboard, which
 * has no access to the bot's in-process EventBus/AuditService. They therefore
 * write their append-only audit_logs rows directly via the service-role client
 * — the same self-contained pattern the bot's `/license activate` handler and
 * the other dashboard routes (deploy, sync, writeTeamAudit) already use.
 *
 * Closes the observability-gap findings:
 *   - [commerce-portal]  Portal login/download actions and refusals unaudited.
 *   - [commerce-licenses] License revocation and device-session lifecycle
 *                         (only activation was audited).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface CommerceAuditEntry {
  guildId: string;
  /** Defaults to 'dashboard' — the owner-facing surface. */
  actorType?: 'user' | 'system' | 'dashboard' | 'webhook';
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
  occurrenceKey?: string;
  /** false for denied/refused attempts so they are queryable. */
  success?: boolean;
}

/**
 * Write a commerce.* audit_logs row directly via the service-role client.
 * Never throws: a failed audit insert must not fail the underlying request.
 */
export async function writeCommerceAudit(
  admin: SupabaseClient,
  entry: CommerceAuditEntry,
): Promise<void> {
  try {
    await admin.from('audit_logs').insert({
      guild_id: entry.guildId,
      actor_type: entry.actorType ?? 'dashboard',
      actor_id: entry.actorId,
      action: entry.action,
      category: 'commerce',
      target_type: entry.targetType,
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
      occurrence_key: entry.occurrenceKey ?? null,
      success: entry.success ?? true,
    });
  } catch {
    // Audit logging must never break the commerce flow.
  }
}
