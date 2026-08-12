/**
 * Audit Logger — Records all deployment and configuration actions to Supabase.
 *
 * Every action the bot takes against the Discord API gets a corresponding
 * audit log entry. This creates a complete history for debugging and review.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';
import { randomUUID } from 'node:crypto';

const log = createLogger('AuditSvc');

export interface AuditEntry {
  guildId: string;
  /**
   * Superset of the event-rail (AuditService) union — 'discord' marks a
   * member-initiated action observed via Discord (e.g. a denied slash
   * command), 'dashboard' a dashboard-origin write executed by the bot.
   */
  actorType: 'bot' | 'dashboard' | 'system' | 'discord' | 'user' | 'webhook' | 'automation';
  actorId: string;
  action: string;
  /** Dashboard filter bucket (e.g. 'members', 'profiles'). Defaults to 'system'. */
  category?: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  /** Groups related entries (mirrors the event rail's correlation_id). */
  correlationId?: string;
  /**
   * Stable identity of this occurrence (`<action>:<stable id>`). When set,
   * the write goes through ON CONFLICT (guild_id, occurrence_key) DO NOTHING
   * (uq_audit_logs_guild_occurrence), so a retried caller cannot write a
   * second row. Leave unset for events with no once-only identity — a wrong
   * dedupe is worse than a duplicate row.
   */
  occurrenceKey?: string;
  success?: boolean;
  errorMessage?: string;
}

/**
 * Durable, immediate audit context for proof-critical game/economy actions.
 *
 * The normal platform event rail is intentionally buffered for throughput. A
 * command that changes a wallet, pet, catch, or crop must not depend on that
 * eventual flush to leave its forensic row behind, so economy managers use
 * this helper before emitting their normal event. The occurrence key makes a
 * direct write and the later event-rail write converge on one immutable row.
 */
export interface EconomyAuditOptions {
  guildId: string;
  actorId: string;
  action: string;
  operationId?: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  success?: boolean;
  errorMessage?: string;
  actorType?: AuditEntry['actorType'];
}

export async function writeEconomyAudit(
  supabase: SupabaseClient,
  options: EconomyAuditOptions,
): Promise<{ correlationId: string; occurrenceKey: string }> {
  const correlationId = options.operationId?.trim() || randomUUID();
  const occurrenceKey = `${options.action}:${correlationId}`;
  await writeAuditLog(supabase, {
    guildId: options.guildId,
    actorType: options.actorType ?? 'user',
    actorId: options.actorId,
    action: options.action,
    category: 'economy',
    targetType: options.targetType ?? 'member',
    targetId: options.targetId ?? options.actorId,
    details: options.details,
    correlationId,
    occurrenceKey,
    success: options.success,
    errorMessage: options.errorMessage,
  });
  return { correlationId, occurrenceKey };
}

/**
 * Write an audit log entry to Supabase.
 */
export async function writeAuditLog(
  supabase: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  try {
    const row = {
      guild_id: entry.guildId,
      actor_type: entry.actorType,
      actor_id: entry.actorId,
      action: entry.action,
      category: entry.category ?? 'system',
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
      before_state: entry.beforeState ?? null,
      after_state: entry.afterState ?? null,
      correlation_id: entry.correlationId ?? null,
      occurrence_key: entry.occurrenceKey ?? null,
      success: entry.success ?? true,
      error_message: entry.errorMessage ?? null,
    };

    // Occurrence-keyed entries dedupe against uq_audit_logs_guild_occurrence;
    // keyless entries keep plain insert semantics (NULL keys never conflict,
    // and an upsert clause would be misleading there).
    const { error } = entry.occurrenceKey
      ? await supabase
          .from('audit_logs')
          .upsert([row], { onConflict: 'guild_id,occurrence_key', ignoreDuplicates: true })
      : await supabase.from('audit_logs').insert(row);

    if (error) {
      log.error('Failed to write audit log:', error.message);
    }
  } catch (err) {
    // Never let audit logging failures crash the bot
    log.error('Exception writing audit log:', { error: String(err) });
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
      category: 'sync',
      action: `deploy.${a.action}.${a.entityType}`,
      target_type: a.entityType,
      target_id: a.discordId ?? null,
      details: { deployId, entityName: a.entityName },
      success: a.success,
      error_message: a.error ?? null,
    }));

    const { error } = await supabase.from('audit_logs').insert(rows);
    if (error) {
      log.error('Failed to write audit batch:', error.message);
    }
  } catch (err) {
    log.error('Exception writing audit batch:', { error: String(err) });
  }
}
