/**
 * Infraction Service — CRUD for moderation infractions.
 *
 * Creates, queries, pardons, and expires infractions.
 * Used by auto-mod, escalation chain, and dashboard manual actions.
 *
 * Architecture doc §18.3
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { InfractionType } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';

const log = createLogger('InfractionService');

export interface CreateInfractionInput {
  guildId: string;
  memberId: string;
  moderatorId: string;   // 'system' for auto-mod
  type: InfractionType;
  reason: string;
  automodRuleId?: string;
  durationMinutes?: number;  // For mutes
  expiresAt?: string;        // ISO string — when the infraction expires (falls off)
  correlationId?: string;    // Idempotency key (e.g. interaction id) — dedups replays
}

export interface InfractionRecord {
  id: string;
  guild_id: string;
  member_id: string;
  moderator_id: string;
  type: InfractionType;
  reason: string;
  automod_rule_id: string | null;
  duration_minutes: number | null;
  active: boolean;
  pardoned: boolean;
  pardoned_by: string | null;
  pardoned_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface CreateInfractionResult {
  infraction: InfractionRecord;
  /**
   * True when this call was deduped by the correlation key (23505 on
   * ux_infractions_guild_correlation): the returned row is the ORIGINAL
   * infraction from the first delivery. Callers MUST skip their side-effect
   * block (DM, mod log, event emits, escalation) on a replay — re-running it
   * was the M3 residual bug (a replayed /warn re-DMed, re-modlogged, and
   * RE-RAN ESCALATION, issuing a second timeout/kick/ban).
   */
  replayed: boolean;
}

/**
 * Create a new infraction record.
 *
 * Returns `{ infraction, replayed }`, or null when the write failed outright.
 */
export async function createInfraction(
  supabase: SupabaseClient,
  input: CreateInfractionInput,
): Promise<CreateInfractionResult | null> {
  const { data, error } = await supabase
    .from('infractions')
    .insert({
      guild_id: input.guildId,
      member_id: input.memberId,
      moderator_id: input.moderatorId,
      type: input.type,
      reason: input.reason,
      automod_rule_id: input.automodRuleId ?? null,
      duration_minutes: input.durationMinutes ?? null,
      active: true,
      pardoned: false,
      expires_at: input.expiresAt ?? null,
      correlation_id: input.correlationId ?? null,
    })
    .select()
    .single();

  if (error) {
    // Idempotency: a replayed write (same guild_id + correlation_id) is rejected
    // by ux_infractions_guild_correlation (23505). Treat it as a no-op and read
    // back the original row instead of creating a duplicate / re-firing escalation
    // — flagged replayed:true so the caller also skips its side effects.
    // NOTE: this check assumes ux_infractions_guild_correlation is the ONLY
    // unique constraint on infractions besides the PK. If another unique
    // constraint is ever added, its 23505s would land here too and masquerade
    // as correlation replays — disambiguate by constraint name (error.details/
    // constraint) before treating a bare 23505 as a replay.
    if (error.code === '23505' && input.correlationId) {
      const { data: existing } = await supabase
        .from('infractions')
        .select('*')
        .eq('guild_id', input.guildId)
        .eq('correlation_id', input.correlationId)
        .maybeSingle();
      if (existing) return { infraction: existing as InfractionRecord, replayed: true };
    }
    log.error('Failed to create infraction:', error.message);
    return null;
  }

  return { infraction: data as InfractionRecord, replayed: false };
}

/**
 * Get the count of active warnings for a member.
 * Used by the escalation chain to determine next action.
 */
export async function getActiveWarningCount(
  supabase: SupabaseClient,
  guildId: string,
  memberId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('infractions')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildId)
    .eq('member_id', memberId)
    .eq('type', 'warn')
    .eq('active', true)
    .eq('pardoned', false);

  if (error) {
    log.error('Failed to count warnings:', error.message);
    return 0;
  }

  return count ?? 0;
}

/**
 * Get total active infractions of all types for a member.
 */
export async function getActiveInfractionCount(
  supabase: SupabaseClient,
  guildId: string,
  memberId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('infractions')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildId)
    .eq('member_id', memberId)
    .eq('active', true)
    .eq('pardoned', false);

  if (error) {
    log.error('Failed to count infractions:', error.message);
    return 0;
  }

  return count ?? 0;
}

/**
 * Get recent infractions for a member (for history display).
 *
 * Returns `null` (NOT an empty array) when the read itself fails: a failed READ
 * is unknown state, and coercing it to [] made /infractions report a clean
 * record during a database outage — a data-shaped lie about state the bot could
 * not read (the #356 handleLeaderboardCommand bug class). Callers must
 * distinguish "no infractions" ([]) from "could not read" (null).
 */
export async function getMemberInfractions(
  supabase: SupabaseClient,
  guildId: string,
  memberId: string,
  limit = 25,
): Promise<InfractionRecord[] | null> {
  const { data, error } = await supabase
    .from('infractions')
    .select('*')
    .eq('guild_id', guildId)
    .eq('member_id', memberId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    log.error('Failed to get member infractions:', error.message);
    return null;
  }

  return (data ?? []) as InfractionRecord[];
}

/**
 * Pardon an infraction (deactivate it).
 * V51: added guildId scope to prevent IDOR.
 */
export async function pardonInfraction(
  supabase: SupabaseClient,
  infractionId: string,
  pardonedBy: string,
  guildId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('infractions')
    .update({
      active: false,
      pardoned: true,
      pardoned_by: pardonedBy,
      pardoned_at: new Date().toISOString(),
    })
    .eq('id', infractionId)
    .eq('guild_id', guildId);

  if (error) {
    log.error('Failed to pardon infraction:', error.message);
    return false;
  }

  return true;
}

/**
 * Expire old infractions.
 * Called periodically — deactivates infractions past their expires_at date.
 */
export async function expireInfractions(
  supabase: SupabaseClient,
  guildId: string,
): Promise<number> {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('infractions')
    .update({ active: false })
    .eq('guild_id', guildId)
    .eq('active', true)
    .eq('pardoned', false)
    .not('expires_at', 'is', null)
    .lte('expires_at', now)
    .select('id')
    .limit(1000);

  if (error) {
    log.error('Failed to expire infractions:', error.message);
    return 0;
  }

  const count = data?.length ?? 0;
  if (count > 0) {
    log.info(`Expired ${count} infraction(s)`);
  }
  return count;
}

/**
 * Calculate infraction expiry date from guild config.
 */
export function calculateExpiryDate(expiryDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + expiryDays);
  return date.toISOString();
}
