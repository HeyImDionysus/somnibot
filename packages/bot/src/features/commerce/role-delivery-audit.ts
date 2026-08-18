import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';
import { writeAuditLog } from '../../services/audit.js';

const log = createLogger('RoleDeliveryAudit');

export type RoleDeliveryAuditOutcome = {
  readonly guildId: string;
  readonly intentId: string;
  readonly outcome: 'retry' | 'live';
  readonly disposition: string;
};

export async function recordRoleDeliveryOutcome(
  supabase: SupabaseClient,
  outcome: RoleDeliveryAuditOutcome,
): Promise<void> {
  const correlationId = outcome.intentId;
  if (outcome.outcome === 'retry') {
    await writeAuditLog(supabase, {
      guildId: outcome.guildId,
      actorType: 'system',
      actorId: 'commerce',
      action: 'commerce.role_delivery.unresolved',
      category: 'commerce',
      targetType: 'role_delivery_intent',
      targetId: outcome.intentId,
      details: { disposition: outcome.disposition },
      correlationId,
      occurrenceKey: `commerce.role_delivery.unresolved:${outcome.intentId}`,
      success: false,
    });
    return;
  }

  try {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('id')
      .eq('guild_id', outcome.guildId)
      .eq(
        'occurrence_key',
        `commerce.role_delivery.unresolved:${outcome.intentId}`,
      )
      .maybeSingle();
    if (error || !data) return;

    await writeAuditLog(supabase, {
      guildId: outcome.guildId,
      actorType: 'system',
      actorId: 'commerce',
      action: 'commerce.role_delivery.reconciled',
      category: 'commerce',
      targetType: 'role_delivery_intent',
      targetId: outcome.intentId,
      details: { disposition: outcome.disposition },
      correlationId,
      occurrenceKey: `commerce.role_delivery.reconciled:${outcome.intentId}`,
    });
  } catch {
    log.warn('Role delivery reconciliation audit lookup failed');
  }
}
