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

export interface CreateInfractionInput {
  guildId: string;
  memberId: string;
  moderatorId: string;   // 'system' for auto-mod
  type: InfractionType;
  reason: string;
  automodRuleId?: string;
  durationMinutes?: number;  // For mutes
  expiresAt?: string;        // ISO string — when the infraction expires (falls off)
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

/**
 * Create a new infraction record.
 */
export async function createInfraction(
  supabase: SupabaseClient,
  input: CreateInfractionInput,
): Promise<InfractionRecord | null> {
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
    })
    .select()
    .single();

  if (error) {
    console.error('[Moderation] Failed to create infraction:', error.message);
    return null;
  }

  return data as InfractionRecord;
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
    console.error('[Moderation] Failed to count warnings:', error.message);
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
    console.error('[Moderation] Failed to count infractions:', error.message);
    return 0;
  }

  return count ?? 0;
}

/**
 * Get recent infractions for a member (for history display).
 */
export async function getMemberInfractions(
  supabase: SupabaseClient,
  guildId: string,
  memberId: string,
  limit = 25,
): Promise<InfractionRecord[]> {
  const { data, error } = await supabase
    .from('infractions')
    .select('*')
    .eq('guild_id', guildId)
    .eq('member_id', memberId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[Moderation] Failed to get member infractions:', error.message);
    return [];
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
    console.error('[Moderation] Failed to pardon infraction:', error.message);
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
    .select('id');

  if (error) {
    console.error('[Moderation] Failed to expire infractions:', error.message);
    return 0;
  }

  const count = data?.length ?? 0;
  if (count > 0) {
    console.log(`[Moderation] Expired ${count} infraction(s)`);
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
