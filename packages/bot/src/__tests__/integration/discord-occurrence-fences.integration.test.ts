import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';
import {
  claimDiscordOccurrence,
  completeDiscordOccurrence,
  reclaimStaleDiscordOccurrence,
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

  it('atomically renews only the exact stale unreferenced claim', async () => {
    const key = `${guildId}:temp-channel:stale-recovery`;
    const first = await claimDiscordOccurrence(
      supa,
      guildId,
      'temp_channel',
      key,
      { recoveryKind: 'temp_channel_create', channelName: 'Recovery room' },
    );
    expect(first.won).toBe(true);
    expect(first.occurrence.result).toMatchObject({ channelName: 'Recovery room' });

    const oldTimestamp = new Date(Date.now() - 10 * 60_000).toISOString();
    const aged = await supa
      .from('discord_operation_occurrences')
      .update({ claimed_at: oldTimestamp })
      .eq('id', first.occurrence.id)
      .select('*')
      .single();
    expect(aged.error).toBeNull();

    const stale = aged.data as typeof first.occurrence;
    await expect(
      reclaimStaleDiscordOccurrence(
        supa,
        stale,
        new Date(Date.now() - 2 * 60_000).toISOString(),
      ),
    ).resolves.toBe(true);
    await expect(
      reclaimStaleDiscordOccurrence(
        supa,
        stale,
        new Date(Date.now() - 2 * 60_000).toISOString(),
      ),
    ).resolves.toBe(false);
  });

  it('atomically transfers a temp-room owner before retiring its creation fence', async () => {
    const hub = await supa.from('temp_channel_hubs').insert({
      guild_id: guildId,
      hub_channel_id: `${guildId}:hub`,
      category_id: `${guildId}:category`,
    }).select('id').single();
    expect(hub.error).toBeNull();

    const occurrence = await supa.from('discord_operation_occurrences').insert({
      guild_id: guildId,
      operation_kind: 'temp_channel',
      occurrence_key: `${guildId}:temp-channel:ownership-transfer`,
      status: 'completed',
      resource_id: `${guildId}:room`,
    }).select('id').single();
    expect(occurrence.error).toBeNull();

    const active = await supa.from('active_temp_channels').insert({
      channel_id: `${guildId}:room`,
      guild_id: guildId,
      hub_id: hub.data!.id,
      owner_id: 'old-owner',
      creation_occurrence_id: occurrence.data!.id,
    });
    expect(active.error).toBeNull();

    const staleAttempt = await supa.rpc('transfer_temp_channel_ownership', {
      p_guild_id: guildId,
      p_channel_id: `${guildId}:room`,
      p_new_owner_id: 'wrong-owner',
      p_expected_owner_id: 'wrong-old-owner',
      p_expected_occurrence_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(staleAttempt).toMatchObject({ data: false, error: null });

    const transferred = await supa.rpc('transfer_temp_channel_ownership', {
      p_guild_id: guildId,
      p_channel_id: `${guildId}:room`,
      p_new_owner_id: 'new-owner',
      p_expected_owner_id: 'old-owner',
      p_expected_occurrence_id: occurrence.data!.id,
    });
    expect(transferred).toMatchObject({ data: true, error: null });

    const [persisted, retired] = await Promise.all([
      supa
        .from('active_temp_channels')
        .select('owner_id,creation_occurrence_id')
        .eq('channel_id', `${guildId}:room`)
        .single(),
      supa
        .from('discord_operation_occurrences')
        .select('id')
        .eq('id', occurrence.data!.id)
        .maybeSingle(),
    ]);
    expect(persisted.data).toEqual({
      owner_id: 'new-owner',
      creation_occurrence_id: null,
    });
    expect(retired).toMatchObject({ data: null, error: null });

    const concurrentReplay = await supa.rpc('transfer_temp_channel_ownership', {
      p_guild_id: guildId,
      p_channel_id: `${guildId}:room`,
      p_new_owner_id: 'second-new-owner',
      p_expected_owner_id: 'old-owner',
      p_expected_occurrence_id: null,
    });
    expect(concurrentReplay).toMatchObject({ data: false, error: null });

    const staleRetirement = await supa.rpc('retire_temp_channel', {
      p_guild_id: guildId,
      p_channel_id: `${guildId}:room`,
      p_expected_occurrence_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(staleRetirement).toMatchObject({ data: false, error: null });

    const retirement = await supa.rpc('retire_temp_channel', {
      p_guild_id: guildId,
      p_channel_id: `${guildId}:room`,
      p_expected_occurrence_id: null,
    });
    expect(retirement).toMatchObject({ data: true, error: null });
    const retiredActive = await supa
      .from('active_temp_channels')
      .select('channel_id')
      .eq('channel_id', `${guildId}:room`)
      .maybeSingle();
    expect(retiredActive).toMatchObject({ data: null, error: null });
  });

  it('atomically grants only one final scheduled-message send slot across occurrences', async () => {
    const schedule = await supa.from('scheduled_messages').insert({
      guild_id: guildId,
      name: 'Atomic final-slot proof',
      channel_id: '12345678901234567',
      message: 'proof',
      cron_expression: '* * * * *',
      timezone: 'UTC',
      max_sends: 1,
      current_sends: 0,
      active: true,
      status: 'active',
    }).select('id').single();
    expect(schedule.error).toBeNull();

    const claims = await Promise.all([
      supa.rpc('claim_scheduled_message_send', {
        p_schedule_id: schedule.data!.id,
        p_guild_id: guildId,
        p_occurrence_at: '2026-07-30T12:00:00.000Z',
      }),
      supa.rpc('claim_scheduled_message_send', {
        p_schedule_id: schedule.data!.id,
        p_guild_id: guildId,
        p_occurrence_at: '2026-07-30T12:01:00.000Z',
      }),
    ]);
    expect(claims.every((claim) => claim.error === null)).toBe(true);
    expect(claims.filter((claim) => claim.data === 1)).toHaveLength(1);
    expect(claims.filter((claim) => claim.data === null)).toHaveLength(1);

    const persisted = await supa
      .from('scheduled_messages')
      .select('current_sends,last_sent_at')
      .eq('id', schedule.data!.id)
      .single();
    expect(persisted.data?.current_sends).toBe(1);
    expect([
      '2026-07-30T12:00:00+00:00',
      '2026-07-30T12:01:00+00:00',
    ]).toContain(persisted.data?.last_sent_at);
  });

  it('prunes only unreferenced terminal fences outside the retention window', async () => {
    const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();
    const recentTimestamp = new Date().toISOString();
    const rows = [
      {
        guild_id: guildId,
        operation_kind: 'scheduled_message',
        occurrence_key: `${guildId}:retention:old-completed`,
        status: 'completed',
        updated_at: oldTimestamp,
      },
      {
        guild_id: guildId,
        operation_kind: 'scheduled_message',
        occurrence_key: `${guildId}:retention:old-failed`,
        status: 'failed',
        updated_at: oldTimestamp,
      },
      {
        guild_id: guildId,
        operation_kind: 'scheduled_message',
        occurrence_key: `${guildId}:retention:old-claimed`,
        status: 'claimed',
        updated_at: oldTimestamp,
      },
      {
        guild_id: guildId,
        operation_kind: 'scheduled_message',
        occurrence_key: `${guildId}:retention:recent-completed`,
        status: 'completed',
        updated_at: recentTimestamp,
      },
    ];
    const seeded = await supa.from('discord_operation_occurrences').insert(rows);
    expect(seeded.error).toBeNull();

    const pruned = await supa.rpc('prune_discord_operation_occurrences');
    expect(pruned.error).toBeNull();
    expect(pruned.data).toBe(2);

    const remaining = await supa
      .from('discord_operation_occurrences')
      .select('occurrence_key')
      .like('occurrence_key', `${guildId}:retention:%`);
    expect(remaining.error).toBeNull();
    expect((remaining.data ?? []).map((row) => row.occurrence_key).sort()).toEqual([
      `${guildId}:retention:old-claimed`,
      `${guildId}:retention:recent-completed`,
    ]);
  });
});
