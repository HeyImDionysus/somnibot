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

/**
 * Durably record the Discord channel ids a claimed creation produced, BEFORE
 * any later step can fail. Without this, a failure cascade (active-row insert
 * fails, one deletion fails, all cleanup-pending writes fail) left a claimed
 * occurrence whose metadata named NO surviving channel — stale recovery then
 * found nothing to adopt or delete, reclaimed the occurrence, and created a
 * fresh room while the survivor stayed orphaned forever.
 *
 * Conditional on the row still being `claimed` and proven by read-back, like
 * markDiscordOccurrenceCleanupPending. Merges into the existing result so the
 * claim's recovery metadata is preserved.
 */
/**
 * Records the created channel ids on the claimed occurrence and returns the
 * occurrence's FRESH updated_at. The update fires the updated_at trigger, so
 * any claim-identity snapshot captured at claim time is stale from this point
 * on — ownership inserts must verify against the returned value.
 */
export async function recordDiscordOccurrenceChannels(
  supabase: SupabaseClient,
  occurrenceId: string,
  channelIds: string[],
  expectedUpdatedAt: string | null = null,
): Promise<{ updatedAt: string | null }> {
  const readQuery = supabase
    .from('discord_operation_occurrences')
    .select('result')
    .eq('id', occurrenceId)
    .eq('status', 'claimed');
  const { data: current, error: readError } = await (
    expectedUpdatedAt ? readQuery.eq('updated_at', expectedUpdatedAt) : readQuery
  ).maybeSingle();
  if (readError) {
    throw new Error(`Unable to read occurrence for channel-id record: ${readError.message}`);
  }
  if (!current) {
    const landed = await verifyOwnChannelRecordLanded(supabase, occurrenceId, channelIds);
    if (landed) return landed;
    throw new Error(
      `Unable to record channel ids: occurrence ${occurrenceId} is no longer claimed or owned by this worker`,
    );
  }
  const result =
    current.result && typeof current.result === 'object' && !Array.isArray(current.result)
      ? { ...(current.result as Record<string, unknown>) }
      : {};
  result.createdChannelIds = channelIds;
  // CAS on the caller's claim generation: a creator that stalled past the
  // stale threshold no longer owns this row — recovery reclaimed it (bumping
  // updated_at) — and recording anyway would overwrite recovery's result AND
  // hand the stalled worker a fresh generation that blesses its ownership
  // insert, committing competing channels.
  const updateQuery = supabase
    .from('discord_operation_occurrences')
    .update({ result })
    .eq('id', occurrenceId)
    .eq('status', 'claimed');
  const { data: updated, error: updateError } = await (
    expectedUpdatedAt ? updateQuery.eq('updated_at', expectedUpdatedAt) : updateQuery
  )
    .select('id, updated_at')
    .maybeSingle();
  if (updateError) {
    throw new Error(`Unable to record occurrence channel ids: ${updateError.message}`);
  }
  if (!updated) {
    const landed = await verifyOwnChannelRecordLanded(supabase, occurrenceId, channelIds);
    if (landed) return landed;
    throw new Error(
      `Unable to record channel ids: occurrence ${occurrenceId} is no longer claimed or owned by this worker`,
    );
  }
  return {
    updatedAt: typeof updated.updated_at === 'string' ? updated.updated_at : null,
  };
}

/**
 * Retry disambiguation for the CAS above: an earlier attempt's UPDATE can
 * land while its response is lost, so the retry's expected generation is
 * stale even though the row now carries EXACTLY our channel ids. That is our
 * own committed write — adopt the row's current generation instead of
 * self-destructing channels this worker still owns.
 */
async function verifyOwnChannelRecordLanded(
  supabase: SupabaseClient,
  occurrenceId: string,
  channelIds: string[],
): Promise<{ updatedAt: string | null } | null> {
  const { data: row, error } = await supabase
    .from('discord_operation_occurrences')
    .select('status, result, updated_at')
    .eq('id', occurrenceId)
    .maybeSingle();
  if (error || !row || row.status !== 'claimed') return null;
  const recorded = (row.result as Record<string, unknown> | null)?.createdChannelIds;
  if (!Array.isArray(recorded) || JSON.stringify(recorded) !== JSON.stringify(channelIds)) {
    return null;
  }
  return { updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null };
}

export async function completeDiscordOccurrence(
  supabase: SupabaseClient,
  occurrenceId: string,
  resourceId: string | null,
  result: Record<string, unknown> = {},
): Promise<void> {
  // Settlement MERGES into result (Definer-rights RPC): replacing the object
  // dropped the counterReserved marker, so recovery completing a reclaimed
  // occurrence let the stalled original sender pay a SECOND slot for the
  // same due minute.
  const { error } = await supabase.rpc('settle_discord_occurrence', {
    p_occurrence_id: occurrenceId,
    p_status: 'completed',
    p_resource_id: resourceId,
    p_result: result,
    p_last_error: null,
  });
  if (error) throw new Error(`Unable to complete Discord occurrence: ${error.message}`);
}

export async function failDiscordOccurrence(
  supabase: SupabaseClient,
  occurrenceId: string,
  error: string,
  resourceId: string | null = null,
  result: Record<string, unknown> = {},
): Promise<void> {
  // Same merge discipline as completion: a failed send that already paid its
  // counter slot must keep the marker, or the retry pays twice.
  const { error: updateError } = await supabase.rpc('settle_discord_occurrence', {
    p_occurrence_id: occurrenceId,
    p_status: 'failed',
    p_resource_id: resourceId,
    p_result: result,
    p_last_error: error,
  });
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
