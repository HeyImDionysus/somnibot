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
): Promise<OccurrenceClaim> {
  const { data, error } = await supabase
    .from('discord_operation_occurrences')
    .insert({
      guild_id: guildId,
      operation_kind: operationKind,
      occurrence_key: occurrenceKey,
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
): Promise<void> {
  const { error: updateError } = await supabase
    .from('discord_operation_occurrences')
    .update({
      status: 'failed',
      last_error: error,
      completed_at: new Date().toISOString(),
    })
    .eq('id', occurrenceId)
    .eq('status', 'claimed');
  if (updateError) throw new Error(`Unable to fail Discord occurrence: ${updateError.message}`);
}
