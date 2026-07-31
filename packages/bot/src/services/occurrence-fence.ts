import type { SupabaseClient } from '@supabase/supabase-js';

export type DiscordOperationKind = 'scheduled_message' | 'temp_channel' | 'ticket';

export interface DiscordOperationOccurrence {
  id: string;
  guild_id: string;
  operation_kind: DiscordOperationKind;
  occurrence_key: string;
  status: 'claimed' | 'completed' | 'failed';
  resource_id: string | null;
  result: Record<string, unknown>;
  last_error: string | null;
  claimed_at: string;
  updated_at: string;
}

export type OccurrenceClaim =
  | { won: true; occurrence: DiscordOperationOccurrence }
  | { won: false; occurrence: DiscordOperationOccurrence };

/**
 * Insert is the fence: Postgres' unique(kind, key) constraint elects exactly
 * one worker. A duplicate delivery receives the existing durable outcome.
 */
export async function claimDiscordOccurrence(
  supabase: SupabaseClient,
  guildId: string,
  operationKind: DiscordOperationKind,
  occurrenceKey: string,
  initialResult: Record<string, unknown> = {},
): Promise<OccurrenceClaim> {
  const { data, error } = await supabase
    .from('discord_operation_occurrences')
    .insert({
      guild_id: guildId,
      operation_kind: operationKind,
      occurrence_key: occurrenceKey,
      result: initialResult,
    })
    .select('*')
    .single();

  if (!error && data) {
    return { won: true, occurrence: data as DiscordOperationOccurrence };
  }
  if (error?.code !== '23505') {
    throw new Error(`Unable to claim ${operationKind} occurrence: ${error?.message ?? 'unknown database error'}`);
  }

  const { data: existing, error: readError } = await supabase
    .from('discord_operation_occurrences')
    .select('*')
    .eq('operation_kind', operationKind)
    .eq('occurrence_key', occurrenceKey)
    .maybeSingle();
  if (readError || !existing) {
    throw new Error(`Unable to read claimed ${operationKind} occurrence: ${readError?.message ?? 'missing row'}`);
  }
  return { won: false, occurrence: existing as DiscordOperationOccurrence };
}

/**
 * Atomically renew a stale claim after the caller has reconciled the external
 * system and proved that no resource matching the claim's recovery metadata
 * survived. The database CAS elects one recovery worker and refuses claims
 * already referenced by a durable resource row.
 */
export async function reclaimStaleDiscordOccurrence(
  supabase: SupabaseClient,
  occurrence: DiscordOperationOccurrence,
  staleBefore: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('reclaim_stale_discord_occurrence', {
    p_occurrence_id: occurrence.id,
    p_guild_id: occurrence.guild_id,
    p_operation_kind: occurrence.operation_kind,
    p_expected_updated_at: occurrence.updated_at,
    p_stale_before: staleBefore,
  });
  if (error) throw new Error(`Unable to reclaim stale Discord occurrence: ${error.message}`);
  return data === true;
}

/**
 * Preserve an occurrence as a durable cleanup job. It intentionally remains
 * claimed so retention cannot erase the only pointer to an orphaned Discord
 * resource before a reconciler has confirmed deletion.
 */
export async function markDiscordOccurrenceCleanupPending(
  supabase: SupabaseClient,
  occurrenceId: string,
  resourceId: string,
  error: string,
  result: Record<string, unknown>,
): Promise<void> {
  const { data: updated, error: updateError } = await supabase
    .from('discord_operation_occurrences')
    .update({
      resource_id: resourceId,
      result: { ...result, channelCleanupPending: true },
      last_error: error,
    })
    .eq('id', occurrenceId)
    .eq('status', 'claimed')
    .select('id')
    .maybeSingle();
  if (updateError) {
    throw new Error(`Unable to preserve Discord occurrence cleanup job: ${updateError.message}`);
  }
  if (!updated) {
    throw new Error(
      `Unable to preserve Discord occurrence cleanup job: occurrence ${occurrenceId} is no longer claimed`,
    );
  }
}

export async function completeDiscordOccurrence(
  supabase: SupabaseClient,
  occurrenceId: string,
  resourceId: string | null,
  result: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase
    .from('discord_operation_occurrences')
    .update({
      status: 'completed',
      resource_id: resourceId,
      result,
      completed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', occurrenceId)
    .eq('status', 'claimed');
  if (error) throw new Error(`Unable to complete Discord occurrence: ${error.message}`);
}

export async function failDiscordOccurrence(
  supabase: SupabaseClient,
  occurrenceId: string,
  error: string,
  resourceId: string | null = null,
  result: Record<string, unknown> = {},
): Promise<void> {
  const { error: updateError } = await supabase
    .from('discord_operation_occurrences')
    .update({
      status: 'failed',
      resource_id: resourceId,
      result,
      last_error: error,
      completed_at: new Date().toISOString(),
    })
    .eq('id', occurrenceId)
    .eq('status', 'claimed');
  if (updateError) throw new Error(`Unable to fail Discord occurrence: ${updateError.message}`);
}

/**
 * Release a claim only when its caller has proved that no Discord resource
 * survived. This permits a later legitimate gateway occurrence to retry while
 * preserving fail-closed behavior across ambiguous external commit windows.
 */
export async function releaseDiscordOccurrence(
  supabase: SupabaseClient,
  occurrenceId: string,
): Promise<void> {
  const { error } = await supabase
    .from('discord_operation_occurrences')
    .delete()
    .eq('id', occurrenceId)
    .eq('status', 'claimed');
  if (error) throw new Error(`Unable to release Discord occurrence: ${error.message}`);
}
