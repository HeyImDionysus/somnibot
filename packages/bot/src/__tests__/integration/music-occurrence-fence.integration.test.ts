import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireSupabase, resolveTestSupabaseKey } from './helpers.js';
import { PlatformEventBus } from '../../services/event-bus.js';
import { MusicInteractionOccurrenceFence } from '../../features/music/music-occurrence-fence.js';

const guildId = `test-music-occurrence-${Date.now()}`;
const occurrenceKey = `${guildId}:interaction-1`;
let cleanupClient: SupabaseClient;

function makeIndependentClient(): SupabaseClient {
  return createClient(
    process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
    resolveTestSupabaseKey(),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

beforeAll(async () => {
  cleanupClient = await requireSupabase();
  const seeded = await cleanupClient.from('guild').insert({
    id: guildId,
    name: 'Music occurrence fence integration test',
    owner_discord_id: '12345678901234567',
  });
  if (seeded.error) throw new Error(`Guild seed failed: ${seeded.error.message}`);
});

afterAll(async () => {
  await cleanupClient.from('guild').delete().eq('id', guildId);
});

describe('music interaction occurrence fence', () => {
  it('elects one mutation starter across independent bot clients', async () => {
    // Given two independent clients receive the same Discord interaction.
    const clients = [makeIndependentClient(), makeIndependentClient()];
    const fences = clients.map((client) => new MusicInteractionOccurrenceFence(
      client,
      new PlatformEventBus(),
      guildId,
    ));
    let queueMutations = 0;
    let queueAudits = 0;

    // When both try to claim and begin the durable music mutation.
    const outcomes = await Promise.all(fences.map((fence) => fence.execute({
      interactionId: occurrenceKey,
      userId: 'member-1',
      action: 'play',
      mutate: async () => {
        queueMutations += 1;
        queueAudits += 1;
        return { queued: true };
      },
    })));

    // Then Postgres elects one durable claim and one mutation starter.
    expect(outcomes.filter((outcome) => outcome.kind === 'applied')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'replayed')).toHaveLength(1);
    expect(queueMutations).toBe(1);
    expect(queueAudits).toBe(1);
    const stored = await cleanupClient
      .from('discord_operation_occurrences')
      .select('status,resource_id,result')
      .eq('operation_kind', 'music_interaction')
      .eq('occurrence_key', occurrenceKey)
      .single();
    expect(stored).toMatchObject({
      error: null,
      data: {
        status: 'completed',
        resource_id: occurrenceKey,
        result: { state: 'applied', action: 'play', userId: 'member-1' },
      },
    });
  });
});
