import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { claimDiscordOccurrence } from '../../services/occurrence-fence.js';
import { requireSupabase } from './helpers.js';

const guildId = `test-scheduled-recovery-${Date.now()}`;
let supabase: SupabaseClient | null = null;

class ScheduledRecoveryTestError extends Error {}

function requireClient(): SupabaseClient {
  if (supabase === null) throw new ScheduledRecoveryTestError('recovery client is not initialized');
  return supabase;
}

beforeAll(async () => {
  supabase = await requireSupabase();
  const seeded = await supabase.from('guild').insert({
    id: guildId,
    name: 'Scheduled next-occurrence recovery integration test',
    owner_discord_id: '12345678901234567',
  });
  if (seeded.error) throw new ScheduledRecoveryTestError(seeded.error.message);
});

afterAll(async () => {
  if (supabase !== null) await supabase.from('guild').delete().eq('id', guildId);
});

describe('scheduled message missed-run recovery', () => {
  it('settles only the latest missed occurrence under send-latest policy', async () => {
    // Given a persisted pointer three minutes behind the latest due slot.
    const currentMinute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const firstMissedAt = new Date(currentMinute.getTime() - 3 * 60_000).toISOString();
    const latestMissedAt = new Date(currentMinute.getTime() - 60_000).toISOString();
    const schedule = await requireClient().from('scheduled_messages').insert({
      guild_id: guildId,
      name: 'Send latest recovery',
      channel_id: '12345678901234567',
      message: 'recovery proof',
      cron_expression: '* * * * *',
      timezone: 'UTC',
      missed_run_policy: 'send-latest',
      active: true,
      status: 'active',
    }).select('id').single();
    expect(schedule.error).toBeNull();
    if (typeof schedule.data?.id !== 'string') return;
    const rewound = await requireClient().from('scheduled_messages')
      .update({ next_occurrence_at: firstMissedAt })
      .eq('id', schedule.data.id);
    expect(rewound.error).toBeNull();
    const claim = await claimDiscordOccurrence(
      requireClient(),
      guildId,
      'scheduled_message',
      `${schedule.data.id}:${latestMissedAt}`,
    );
    expect(claim.won).toBe(true);

    // When the latest slot reserves and settles, then older misses do not
    // consume counters and the pointer advances from the delivered slot.
    const reserved = await requireClient().rpc('claim_scheduled_message_send', {
      p_schedule_id: schedule.data.id,
      p_guild_id: guildId,
      p_occurrence_at: latestMissedAt,
      p_occurrence_id: claim.occurrence.id,
      p_expected_updated_at: claim.occurrence.updated_at,
    });
    expect(reserved).toMatchObject({ data: 1, error: null });
    const completed = await requireClient().rpc('complete_scheduled_message_send', {
      p_schedule_id: schedule.data.id,
      p_guild_id: guildId,
      p_occurrence_id: claim.occurrence.id,
      p_occurrence_at: latestMissedAt,
      p_resource_id: 'discord-send-latest',
    });
    expect(completed).toMatchObject({ data: true, error: null });
    const persisted = await requireClient().from('scheduled_messages')
      .select('current_sends,last_sent_at,next_occurrence_at')
      .eq('id', schedule.data.id)
      .single();
    expect(persisted.data?.current_sends).toBe(1);
    expect(Date.parse(String(persisted.data?.last_sent_at))).toBe(Date.parse(latestMissedAt));
    expect(Date.parse(String(persisted.data?.next_occurrence_at))).toBe(currentMinute.getTime());
  });
});
