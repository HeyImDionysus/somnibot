import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimDiscordOccurrence, reclaimStaleDiscordOccurrence } from '../../services/occurrence-fence.js';
import {
  cleanupScheduledNextFixture,
  initializeScheduledNextFixture,
  insertScheduledNextFixture,
  requireScheduledNextClient,
  scheduledNextGuildId,
} from './scheduled-next-occurrence.fixtures.js';

beforeAll(initializeScheduledNextFixture);
afterAll(cleanupScheduledNextFixture);

describe('scheduled message next occurrence persistence', () => {
  it('calculates deterministic UTC, DST-gap, and DST-fold occurrences', async () => {
    const client = requireScheduledNextClient();

    // Given canonical cron/timezone inputs around both 2026 DST transitions.
    const [utc, gap, fold] = await Promise.all([
      client.rpc('scheduled_message_next_occurrence', {
        p_cron_expression: '0 9 * * *',
        p_timezone: 'UTC',
        p_after: '2026-08-18T08:30:00.000Z',
        p_start_date: null,
        p_end_date: null,
      }),
      client.rpc('scheduled_message_next_occurrence', {
        p_cron_expression: '30 2 * * *',
        p_timezone: 'America/New_York',
        p_after: '2026-03-08T06:59:00.000Z',
        p_start_date: null,
        p_end_date: null,
      }),
      client.rpc('scheduled_message_next_occurrence', {
        p_cron_expression: '30 1 * * *',
        p_timezone: 'America/New_York',
        p_after: '2026-11-01T04:00:00.000Z',
        p_start_date: null,
        p_end_date: null,
      }),
    ]);

    // When Postgres resolves each next occurrence, then the DST gap is skipped
    // and the fold chooses one stable instant rather than duplicating a slot.
    expect(utc).toMatchObject({ data: '2026-08-18T09:00:00+00:00', error: null });
    expect(gap).toMatchObject({ data: '2026-03-09T06:30:00+00:00', error: null });
    expect(fold).toMatchObject({ data: '2026-11-01T06:30:00+00:00', error: null });
  });

  it('initializes on create and recomputes on schedule generation changes', async () => {
    // Given an active future schedule, the insert trigger initializes its pointer.
    const schedule = await insertScheduledNextFixture({
      cron_expression: '0 12 * * *',
      start_date: '2099-09-01T00:00:00.000Z',
    });
    expect(schedule?.next_occurrence_at).toBe('2099-09-01T12:00:00+00:00');

    // When its cron generation changes, then the pointer is recomputed.
    const changed = await requireScheduledNextClient()
      .from('scheduled_messages')
      .update({ cron_expression: '30 12 * * *' })
      .eq('id', schedule?.id)
      .select('next_occurrence_at')
      .single();
    expect(changed).toMatchObject({
      data: { next_occurrence_at: '2099-09-01T12:30:00+00:00' },
      error: null,
    });

    // When disabled, then no future occurrence remains runnable.
    const disabled = await requireScheduledNextClient()
      .from('scheduled_messages')
      .update({ active: false })
      .eq('id', schedule?.id)
      .select('next_occurrence_at')
      .single();
    expect(disabled).toMatchObject({ data: { next_occurrence_at: null }, error: null });
  });

  it('atomically skips missed slots without consuming a send counter', async () => {
    // Given an every-minute schedule whose persisted pointer is behind recovery time.
    const schedule = await insertScheduledNextFixture();
    const dueAt = schedule?.next_occurrence_at;
    if (typeof dueAt !== 'string' || typeof schedule?.id !== 'string') return;
    const lastMissedAt = new Date(Date.parse(dueAt) + 2 * 60_000).toISOString();

    // When skip-missed settles the backlog, then the pointer and baseline move
    // together while the delivery counter remains untouched.
    const skipped = await requireScheduledNextClient().rpc('skip_scheduled_message_occurrences', {
      p_schedule_id: schedule.id,
      p_guild_id: scheduledNextGuildId,
      p_expected_next_occurrence_at: dueAt,
      p_last_occurrence_at: lastMissedAt,
    });
    expect(skipped).toMatchObject({ data: true, error: null });
    const persisted = await requireScheduledNextClient()
      .from('scheduled_messages')
      .select('next_occurrence_at,current_sends,last_sent_at')
      .eq('id', schedule.id)
      .single();
    expect(persisted).toMatchObject({
      data: {
        next_occurrence_at: new Date(Date.parse(lastMissedAt) + 60_000)
          .toISOString()
          .replace('.000Z', '+00:00'),
        current_sends: 0,
        last_sent_at: lastMissedAt.replace('.000Z', '+00:00'),
      },
      error: null,
    });
  });

  it('advances pointer, occurrence, counter, and last-sent state in one settlement', async () => {
    // Given a persisted due slot claimed by one of two restart-equivalent workers.
    const schedule = await insertScheduledNextFixture();
    const dueAt = schedule?.next_occurrence_at;
    expect(typeof dueAt).toBe('string');
    if (typeof dueAt !== 'string' || typeof schedule?.id !== 'string') return;

    const claims = await Promise.all([
      claimDiscordOccurrence(requireScheduledNextClient(), scheduledNextGuildId, 'scheduled_message', `${schedule.id}:${dueAt}`),
      claimDiscordOccurrence(requireScheduledNextClient(), scheduledNextGuildId, 'scheduled_message', `${schedule.id}:${dueAt}`),
    ]);
    const winner = claims.find((claim) => claim.won);
    expect(winner).toBeDefined();
    expect(claims.filter((claim) => claim.won)).toHaveLength(1);
    if (!winner) return;

    // When the due occurrence reserves its counter, the pointer stays pinned
    // until external delivery is confirmed.
    const reserved = await requireScheduledNextClient().rpc('claim_scheduled_message_send', {
      p_schedule_id: schedule.id,
      p_guild_id: scheduledNextGuildId,
      p_occurrence_at: dueAt,
      p_occurrence_id: winner.occurrence.id,
      p_expected_updated_at: winner.occurrence.updated_at,
    });
    expect(reserved).toMatchObject({ data: 1, error: null });
    const beforeSettlement = await requireScheduledNextClient()
      .from('scheduled_messages')
      .select('next_occurrence_at,current_sends,last_sent_at')
      .eq('id', schedule.id)
      .single();
    expect(beforeSettlement).toMatchObject({
      data: { next_occurrence_at: dueAt, current_sends: 1, last_sent_at: dueAt },
      error: null,
    });

    const settled = await requireScheduledNextClient().rpc('complete_scheduled_message_send', {
      p_schedule_id: schedule.id,
      p_guild_id: scheduledNextGuildId,
      p_occurrence_id: winner.occurrence.id,
      p_occurrence_at: dueAt,
      p_resource_id: 'discord-message-1',
    });
    expect(settled).toMatchObject({ data: true, error: null });

    // Then all durable state agrees and the next minute is selected once.
    const [persistedSchedule, persistedOccurrence] = await Promise.all([
      requireScheduledNextClient()
        .from('scheduled_messages')
        .select('next_occurrence_at,current_sends,last_sent_at')
        .eq('id', schedule.id)
        .single(),
      requireScheduledNextClient()
        .from('discord_operation_occurrences')
        .select('status,resource_id,result')
        .eq('id', winner.occurrence.id)
        .single(),
    ]);
    expect(persistedSchedule).toMatchObject({
      data: {
        next_occurrence_at: new Date(Date.parse(dueAt) + 60_000).toISOString().replace('.000Z', '+00:00'),
        current_sends: 1,
        last_sent_at: dueAt,
      },
      error: null,
    });
    expect(persistedOccurrence).toMatchObject({
      data: { status: 'completed', resource_id: 'discord-message-1' },
      error: null,
    });
    expect(persistedOccurrence.data?.result).toMatchObject({ counterReserved: true });
  });

  it('preserves a failed-holder pointer through stale reclaim and clears it only after final delivery', async () => {
    // Given the only allowed send slot was reserved before the worker crashed.
    const schedule = await insertScheduledNextFixture({ max_sends: 1 });
    const dueAt = schedule?.next_occurrence_at;
    if (typeof dueAt !== 'string' || typeof schedule?.id !== 'string') return;
    const claim = await claimDiscordOccurrence(
      requireScheduledNextClient(),
      scheduledNextGuildId,
      'scheduled_message',
      `${schedule.id}:${dueAt}`,
    );
    expect(claim.won).toBe(true);
    const reserved = await requireScheduledNextClient().rpc('claim_scheduled_message_send', {
      p_schedule_id: schedule.id,
      p_guild_id: scheduledNextGuildId,
      p_occurrence_at: dueAt,
      p_occurrence_id: claim.occurrence.id,
      p_expected_updated_at: claim.occurrence.updated_at,
    });
    expect(reserved).toMatchObject({ data: 1, error: null });
    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const aged = await requireScheduledNextClient()
      .from('discord_operation_occurrences')
      .update({ claimed_at: staleAt })
      .eq('id', claim.occurrence.id)
      .select('*')
      .single();
    expect(aged.error).toBeNull();
    if (!aged.data) return;

    // When a replacement worker reclaims the stale occurrence, then the due
    // pointer is still the same slot and the counter is not consumed twice.
    await expect(
      reclaimStaleDiscordOccurrence(
        requireScheduledNextClient(),
        aged.data,
        new Date(Date.now() - 5 * 60_000).toISOString(),
      ),
    ).resolves.toBe(true);
    const afterReclaim = await requireScheduledNextClient()
      .from('scheduled_messages')
      .select('next_occurrence_at,current_sends,last_sent_at')
      .eq('id', schedule.id)
      .single();
    expect(afterReclaim).toMatchObject({
      data: { next_occurrence_at: dueAt, current_sends: 1, last_sent_at: dueAt },
      error: null,
    });

    const freshOccurrence = await requireScheduledNextClient()
      .from('discord_operation_occurrences')
      .select('updated_at')
      .eq('id', claim.occurrence.id)
      .single();
    expect(typeof freshOccurrence.data?.updated_at).toBe('string');
    const repeatedReservation = await requireScheduledNextClient().rpc('claim_scheduled_message_send', {
      p_schedule_id: schedule.id,
      p_guild_id: scheduledNextGuildId,
      p_occurrence_at: dueAt,
      p_occurrence_id: claim.occurrence.id,
      p_expected_updated_at: freshOccurrence.data?.updated_at,
    });
    expect(repeatedReservation).toMatchObject({ data: 1, error: null });

    const settled = await requireScheduledNextClient().rpc('complete_scheduled_message_send', {
      p_schedule_id: schedule.id,
      p_guild_id: scheduledNextGuildId,
      p_occurrence_id: claim.occurrence.id,
      p_occurrence_at: dueAt,
      p_resource_id: 'discord-message-final',
    });
    expect(settled).toMatchObject({ data: true, error: null });
    const exhausted = await requireScheduledNextClient()
      .from('scheduled_messages')
      .select('next_occurrence_at,current_sends,last_sent_at')
      .eq('id', schedule.id)
      .single();
    expect(exhausted).toMatchObject({
      data: { next_occurrence_at: null, current_sends: 1, last_sent_at: dueAt },
      error: null,
    });
  });
});
