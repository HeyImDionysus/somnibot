import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';
import {
  claimDiscordOccurrence,
  completeDiscordOccurrence,
  releaseDiscordOccurrence,
  type DiscordOperationKind,
} from '../../services/occurrence-fence.js';

let supa!: SupabaseClient;
const guildId = `test-occurrence-fences-${Date.now()}`;

beforeAll(async () => {
  supa = await requireSupabase();
  const seeded = await supa.from('guild').insert({
    id: guildId,
    name: 'Discord occurrence fence integration test',
    owner_discord_id: '12345678901234567',
  });
  if (seeded.error) throw new Error(`Guild seed failed: ${seeded.error.message}`);
});

afterAll(async () => {
  if (supa) await supa.from('guild').delete().eq('id', guildId);
});

describe('durable Discord occurrence fences', () => {
  for (const kind of ['scheduled_message', 'temp_channel', 'ticket'] as DiscordOperationKind[]) {
    it(`elects exactly one winner for concurrent ${kind} delivery`, async () => {
      const key = `${guildId}:${kind}:same-event`;
      const claims = await Promise.all(
        Array.from({ length: 8 }, () => claimDiscordOccurrence(supa, guildId, kind, key)),
      );

      expect(claims.filter((claim) => claim.won)).toHaveLength(1);
      expect(new Set(claims.map((claim) => claim.occurrence.id))).toHaveLength(1);

      const winner = claims.find((claim) => claim.won)!;
      await completeDiscordOccurrence(supa, winner.occurrence.id, 'discord-resource-1', {
        proof: 'completed',
      });

      const replay = await claimDiscordOccurrence(supa, guildId, kind, key);
      expect(replay.won).toBe(false);
      expect(replay.occurrence.status).toBe('completed');
      expect(replay.occurrence.resource_id).toBe('discord-resource-1');
      expect(replay.occurrence.result).toEqual({ proof: 'completed' });
    });
  }

  it('enforces the unique fence in Postgres, not only in process memory', async () => {
    const key = `${guildId}:database-constraint`;
    const first = await supa.from('discord_operation_occurrences').insert({
      guild_id: guildId,
      operation_kind: 'ticket',
      occurrence_key: key,
    });
    expect(first.error).toBeNull();

    const duplicate = await supa.from('discord_operation_occurrences').insert({
      guild_id: guildId,
      operation_kind: 'ticket',
      occurrence_key: key,
    });
    expect(duplicate.error?.code).toBe('23505');
  });

  it('permits retry only after a no-resource claim is explicitly released', async () => {
    const key = `${guildId}:temp-channel:retriable-create-failure`;
    const first = await claimDiscordOccurrence(supa, guildId, 'temp_channel', key);
    expect(first.won).toBe(true);

    await releaseDiscordOccurrence(supa, first.occurrence.id);
    const retry = await claimDiscordOccurrence(supa, guildId, 'temp_channel', key);
    expect(retry.won).toBe(true);
    expect(retry.occurrence.id).not.toBe(first.occurrence.id);
  });
});
