/**
 * Audit Logger — Records all deployment and configuration actions to Supabase.
 *
 * Every action the bot takes against the Discord API gets a corresponding
 * audit log entry. This creates a complete history for debugging and review.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuditEntry {
  guildId: string;
  actorType: 'bot' | 'dashboard' | 'system' | 'discord';
  actorId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  success?: boolean;
  errorMessage?: string;
}

/**
 * Write an audit log entry to Supabase.
 */
export async function writeAuditLog(
  supabase: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  try {
    const { error } = await supabase.from('audit_logs').insert({
      guild_id: entry.guildId,
      actor_type: entry.actorType,
      actor_id: entry.actorId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
      before_state: entry.beforeState ?? null,
      after_state: entry.afterState ?? null,
      success: entry.success ?? true,
      error_message: entry.errorMessage ?? null,
    });

    if (error) {
      console.error('[Audit] Failed to write audit log:', error.message);
    }
  } catch (err) {
    // Never let audit logging failures crash the bot
    console.error('[Audit] Exception writing audit log:', err);
  }
}

/**
 * Write a batch of audit entries (for deployment actions).
 */
export async function writeAuditBatch(
  supabase: SupabaseClient,
  guildId: string,
  deployId: string,
  actions: Array<{
    action: string;
    entityType: string;
    entityName: string;
    discordId?: string;
    success: boolean;
    error?: string;
  }>,
): Promise<void> {
  try {
    const rows = actions.map((a) => ({
      guild_id: guildId,
      actor_type: 'bot' as const,
      actor_id: 'deployer',
      action: `deploy.${a.action}.${a.entityType}`,
      target_type: a.entityType,
      target_id: a.discordId ?? null,
      details: { deployId, entityName: a.entityName },
      success: a.success,
      error_message: a.error ?? null,
    }));

    const { error } = await supabase.from('audit_logs').insert(rows);
    if (error) {
      console.error('[Audit] Failed to write audit batch:', error.message);
    }
  } catch (err) {
    console.error('[Audit] Exception writing audit batch:', err);
  }
}
