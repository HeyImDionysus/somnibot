/**
 * community-scheduled-messages FLEET_BACKLOG fixes.
 *
 *  - Silent delivery failure on missing channel → mark failed + one owner alert
 *  - Transient send error → bounded retry converges to one delivery
 *  - Missed-run policy → send-latest catch-up / skip-missed owner notice
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: any = {};
    setTitle() { return this; } setDescription() { return this; } setColor() { return this; }
    setImage() { return this; } setThumbnail() { return this; } setFooter() { return this; }
    setAuthor() { return this; } setTimestamp() { return this; } addFields() { return this; }
  },
}));

const BASE_SCHEDULE = {
  id: 'sched1', guild_id: 'g1', name: 'Daily',
  channel_id: 'ch1', message: 'hello world',
  embed_config_id: null, cron_expression: '* * * * *',
  timezone: 'UTC', start_date: null, end_date: null,
  max_sends: null, current_sends: 0, active: true,
  last_sent_at: null, status: 'active', last_error: null,
  failed_at: null, missed_run_policy: 'skip-missed',
};

function schedSupa(
  schedules: any[],
  options: {
    counterError?: { message: string };
    /** When set, the occurrence claim insert LOSES (23505) and reads return this row. */
    existingOccurrence?: any;
    /** Result of the reclaim_stale_discord_occurrence CAS. Default false (lost). */
    reclaimResult?: boolean | { error: { message: string } };
    /** Row served for the reclaimed-counter reconcile read on scheduled_messages. */
    priorCounterRow?: { current_sends: number; last_sent_at: string | null };
    /** When set, the reclaimed-counter reconcile read FAILS with this error. */
    priorCounterError?: { message: string };
  } = {},
) {
  const inserts: Record<string, any[]> = { alerts: [] };
  const updates: Array<{ payload: any }> = [];
  const deletes: string[] = [];
  function chainFor(table: string) {
    const c: any = { _isUpdate: false, _insertRow: null, _updatePayload: null };
    for (const m of ['select', 'eq', 'neq', 'or', 'is', 'lt', 'gt', 'gte', 'lte', 'in', 'not', 'order', 'limit', 'range', 'match', 'delete']) {
      c[m] = () => c;
    }
    c.update = (payload: any) => {
      c._isUpdate = true;
      c._updatePayload = payload;
      updates.push({ payload });
      return c;
    };
    c.delete = () => { deletes.push(table); return c; };
    c.insert = (row: any) => {
      c._insertRow = row;
      (inserts[table] ||= []).push(row);
      return c;
    };
    c.maybeSingle = async () => {
      // The claim-loss read-back of the existing occurrence row.
      if (table === 'discord_operation_occurrences' && !c._insertRow && options.existingOccurrence) {
        return { data: options.existingOccurrence, error: null };
      }
      // The reclaimed-counter reconcile read against the authoritative row.
      if (table === 'scheduled_messages' && options.priorCounterError) {
        return { data: null, error: options.priorCounterError };
      }
      if (table === 'scheduled_messages' && options.priorCounterRow) {
        return { data: options.priorCounterRow, error: null };
      }
      return { data: null, error: null };
    };
    c.single = async () => {
      if (table === 'discord_operation_occurrences' && c._insertRow) {
        if (options.existingOccurrence) {
          // Unique-key conflict: someone already claimed this due minute.
          return { data: null, error: { code: '23505', message: 'duplicate key value' } };
        }
        return {
          data: {
            id: `occ-${inserts.discord_operation_occurrences.length}`,
            ...c._insertRow,
            status: 'claimed',
            resource_id: null,
            result: {},
            last_error: null,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    };
    c.then = (resolve: (v: any) => void) => {
      if (
        c._isUpdate
        && table === 'scheduled_messages'
        && c._updatePayload?.last_sent_at
        && options.counterError
      ) {
        return resolve({ data: null, error: options.counterError });
      }
      if (c._isUpdate) return resolve({ data: [{ id: 'sched1' }], error: null });
      return resolve({ data: table === 'scheduled_messages' ? schedules : [], error: null });
    };
    return c;
  }
  const rpc = vi.fn(async (name: string) => {
    if (name === 'reclaim_stale_discord_occurrence') {
      const r = options.reclaimResult;
      if (r && typeof r === 'object' && 'error' in r) return { data: null, error: r.error };
      return { data: r === true, error: null };
    }
    if (options.counterError) return { data: null, error: options.counterError };
    return { data: (schedules[0]?.current_sends ?? 0) + 1, error: null };
  });
  return { supabase: { from: (t: string) => chainFor(t), rpc } as any, inserts, updates, deletes };
}

function guild(sendImpl?: () => Promise<any>) {
  const cache = new Map<string, any>();
  const send = vi.fn(sendImpl ?? (async () => ({ id: 'msg1' })));
  cache.set('ch1', { id: 'ch1', name: 'general', isTextBased: () => true, send });
  return {
    guild: { id: 'g1', name: 'Test Guild', memberCount: 10, channels: { cache } } as any,
    send,
  };
}

async function loadRunner() {
  const { ScheduledMessageRunner } = await import('../features/scheduled-messages/runner.js');
  return ScheduledMessageRunner;
}

describe('ScheduledMessageRunner — missing channel', () => {
  it('marks the schedule failed and raises one owner alert (no send)', async () => {
    const Runner = await loadRunner();
    const sched = { ...BASE_SCHEDULE, channel_id: 'gone' };
    const { supabase, inserts, updates } = schedSupa([sched]);
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);
    await (runner as any).tick();

    expect(send).not.toHaveBeenCalled();
    const failedUpdate = updates.find((u) => u.payload.status === 'failed');
    expect(failedUpdate).toBeTruthy();
    expect(inserts.alerts.length).toBe(1);
    expect(inserts.alerts[0].alert_type).toBe('scheduled_message_delivery_failed');
  });
});

describe('ScheduledMessageRunner — transient send retry', () => {
  it('retries a transient send failure and delivers exactly once', async () => {
    const Runner = await loadRunner();
    let attempts = 0;
    const { guild: g, send } = guild(async () => {
      attempts++;
      if (attempts === 1) throw new Error('503 rate limited');
      return { id: 'msg1' };
    });
    const { supabase, inserts, updates } = schedSupa([{ ...BASE_SCHEDULE }]);
    const runner = new Runner(g, supabase);
    await (runner as any).tick();

    expect(attempts).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    // No terminal failure: nothing marked failed, no delivery-failed alert.
    expect(updates.some((u) => u.payload.status === 'failed')).toBe(false);
    expect(inserts.alerts.length).toBe(0);
  });

  it('retains the occurrence when an atomic counter claim failure is ambiguous', async () => {
    const Runner = await loadRunner();
    const { supabase, deletes } = schedSupa(
      [{ ...BASE_SCHEDULE }],
      { counterError: { message: 'write unavailable' } },
    );
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    expect(send).not.toHaveBeenCalled();
    expect(deletes).not.toContain('discord_operation_occurrences');
  });
});

describe('ScheduledMessageRunner — missed-run policy', () => {
  it('send-latest fires exactly one catch-up post on recovery', async () => {
    const Runner = await loadRunner();
    const sched = {
      ...BASE_SCHEDULE,
      missed_run_policy: 'send-latest',
      last_sent_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    const { supabase, inserts } = schedSupa([sched]);
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);
    await (runner as any).loadSchedules();
    await (runner as any).handleMissedRuns();

    expect(send).toHaveBeenCalledTimes(1);
    expect(inserts.alerts.length).toBe(0);
  });

  it('skip-missed drops the occurrences with one owner notice (no send)', async () => {
    const Runner = await loadRunner();
    const sched = {
      ...BASE_SCHEDULE,
      missed_run_policy: 'skip-missed',
      last_sent_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    const { supabase, inserts } = schedSupa([sched]);
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);
    await (runner as any).loadSchedules();
    await (runner as any).handleMissedRuns();

    expect(send).not.toHaveBeenCalled();
    expect(inserts.alerts.length).toBe(1);
    expect(inserts.alerts[0].alert_type).toBe('scheduled_message_missed_occurrence');
  });

  it('a brand-new schedule (no baseline) never triggers a spurious catch-up', async () => {
    const Runner = await loadRunner();
    const sched = { ...BASE_SCHEDULE, missed_run_policy: 'send-latest', last_sent_at: null, start_date: null };
    const { supabase, inserts } = schedSupa([sched]);
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);
    await (runner as any).loadSchedules();
    await (runner as any).handleMissedRuns();

    expect(send).not.toHaveBeenCalled();
    expect(inserts.alerts.length).toBe(0);
  });
});

describe('ScheduledMessageRunner — stale crashed claims are reclaimed, not suppressed', () => {
  // A holder that died between the claim insert and the send leaves the
  // occurrence `claimed` forever; every retry used to see claim.won === false
  // and return silently — with max_sends: 1 the schedule could permanently
  // exhaust its only send having delivered nothing.
  const STALE = new Date(Date.now() - 10 * 60_000).toISOString();
  const FRESH = new Date().toISOString();

  function staleOccurrence(claimedAt: string) {
    return {
      id: 'occ-stale',
      guild_id: 'g1',
      operation_kind: 'scheduled_message',
      occurrence_key: 'sched1:whatever',
      status: 'claimed',
      claimed_at: claimedAt,
      updated_at: claimedAt,
      resource_id: null,
      result: {},
      last_error: null,
    };
  }

  it('reclaims a stale claim via CAS and delivers the message', async () => {
    const Runner = await loadRunner();
    const { supabase, updates } = schedSupa([{ ...BASE_SCHEDULE }], {
      existingOccurrence: staleOccurrence(STALE),
      reclaimResult: true,
      // The crashed holder died BEFORE committing its counter: the
      // authoritative row shows this minute not yet counted, so the normal
      // counter claim proceeds.
      priorCounterRow: { current_sends: 0, last_sent_at: null },
    });
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    expect(send).toHaveBeenCalledTimes(1);
    const rpcNames = (supabase.rpc as any).mock.calls.map((c: any[]) => c[0]);
    expect(rpcNames).toContain('reclaim_stale_discord_occurrence');
    // The reclaimed minute had no committed counter, so it is claimed normally.
    expect(rpcNames).toContain('claim_scheduled_message_send');
    // Completion (not failure) is written for the reclaimed occurrence.
    expect(updates.some((u) => u.payload.status === 'completed')).toBe(true);
  });

  it('leaves a FRESH claim alone — a live holder is never raced', async () => {
    const Runner = await loadRunner();
    const { supabase } = schedSupa([{ ...BASE_SCHEDULE }], {
      existingOccurrence: staleOccurrence(FRESH),
      reclaimResult: true,
    });
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    expect(send).not.toHaveBeenCalled();
    const rpcNames = (supabase.rpc as any).mock.calls.map((c: any[]) => c[0]);
    expect(rpcNames).not.toContain('reclaim_stale_discord_occurrence');
  });

  it('concedes without sending when the CAS reclaim loses', async () => {
    const Runner = await loadRunner();
    const { supabase } = schedSupa([{ ...BASE_SCHEDULE }], {
      existingOccurrence: staleOccurrence(STALE),
      reclaimResult: false,
    });
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    expect(send).not.toHaveBeenCalled();
  });

  it('recovers a schedule EXHAUSTED by a crashed holder without a second max_sends slot', async () => {
    // The worst case in the finding: the crashed holder committed its counter
    // (max_sends: 1 consumed) and died before the send. The tick loop's
    // max_sends guard used to skip the schedule before sendMessage could ever
    // reclaim it — permanently exhausted, nothing delivered.
    const Runner = await loadRunner();
    // The crashed due minute, stale enough to reclaim, recorded on the
    // schedule row exactly as claim_scheduled_message_send left it.
    const crashedMinute = new Date(Math.floor((Date.now() - 10 * 60_000) / 60_000) * 60_000)
      .toISOString();
    const { supabase } = schedSupa(
      [{ ...BASE_SCHEDULE, max_sends: 1, current_sends: 1, last_sent_at: crashedMinute }],
      {
        existingOccurrence: staleOccurrence(crashedMinute),
        reclaimResult: true,
        priorCounterRow: { current_sends: 1, last_sent_at: crashedMinute },
      },
    );
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    // Delivery happens — that is the whole point of the recovery…
    expect(send).toHaveBeenCalledTimes(1);
    // …but the already-committed counter is respected: no second claim.
    const rpcNames = (supabase.rpc as any).mock.calls.map((c: any[]) => c[0]);
    expect(rpcNames).toContain('reclaim_stale_discord_occurrence');
    expect(rpcNames).not.toContain('claim_scheduled_message_send');
  });

  it('leaves a cleanly exhausted schedule alone — no probe churn into sends', async () => {
    const Runner = await loadRunner();
    const doneMinute = new Date(Math.floor((Date.now() - 10 * 60_000) / 60_000) * 60_000)
      .toISOString();
    // The occurrence for the final send COMPLETED — recovery must not fire.
    const { supabase } = schedSupa(
      [{ ...BASE_SCHEDULE, max_sends: 1, current_sends: 1, last_sent_at: doneMinute }],
      {
        existingOccurrence: { ...staleOccurrence(doneMinute), status: 'completed' },
        reclaimResult: true,
      },
    );
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    expect(send).not.toHaveBeenCalled();
    const rpcNames = (supabase.rpc as any).mock.calls.map((c: any[]) => c[0]);
    expect(rpcNames).not.toContain('reclaim_stale_discord_occurrence');
  });
});

describe('ScheduledMessageRunner — recovery is not gated on exhaustion', () => {
  const STALE_AT = new Date(Date.now() - 10 * 60_000).toISOString();

  it('recovers a crashed counted minute on a schedule with REMAINING sends', async () => {
    // The crashed holder advanced last_sent_at/current_sends and died before
    // Discord got the message. The schedule has capacity left, and its cron
    // does not even match the current minute — the ONLY path to this delivery
    // is the per-schedule probe running independently of the max_sends guard.
    const Runner = await loadRunner();
    const crashedMinute = new Date(Math.floor((Date.now() - 10 * 60_000) / 60_000) * 60_000)
      .toISOString();
    const { supabase } = schedSupa(
      [{
        ...BASE_SCHEDULE,
        cron_expression: '0 0 1 1 *', // never due during this test
        max_sends: 10,
        current_sends: 3,
        last_sent_at: crashedMinute,
      }],
      {
        existingOccurrence: {
          id: 'occ-stale', guild_id: 'g1', operation_kind: 'scheduled_message',
          occurrence_key: 'k', status: 'claimed',
          claimed_at: STALE_AT, updated_at: STALE_AT,
          resource_id: null, result: {}, last_error: null,
        },
        reclaimResult: true,
        priorCounterRow: { current_sends: 3, last_sent_at: crashedMinute },
      },
    );
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    expect(send).toHaveBeenCalledTimes(1);
    const rpcNames = (supabase.rpc as any).mock.calls.map((c: any[]) => c[0]);
    expect(rpcNames).toContain('reclaim_stale_discord_occurrence');
    // The minute was already counted by the crashed holder — no second slot.
    expect(rpcNames).not.toContain('claim_scheduled_message_send');
  });

  it('halts recovery when the counter reconcile read is INCONCLUSIVE', async () => {
    // A transient read failure is indistinguishable from "never counted".
    // Guessing runs the counter RPC again: double-counting a minute with
    // capacity, or terminally completing an exhausted one as
    // max_sends_reached without delivering. The claim must be retained.
    const Runner = await loadRunner();
    const crashedMinute = new Date(Math.floor((Date.now() - 10 * 60_000) / 60_000) * 60_000)
      .toISOString();
    const { supabase, updates } = schedSupa(
      [{
        ...BASE_SCHEDULE,
        cron_expression: '0 0 1 1 *',
        max_sends: 10,
        current_sends: 3,
        last_sent_at: crashedMinute,
      }],
      {
        existingOccurrence: {
          id: 'occ-stale', guild_id: 'g1', operation_kind: 'scheduled_message',
          occurrence_key: 'k', status: 'claimed',
          claimed_at: STALE_AT, updated_at: STALE_AT,
          resource_id: null, result: {}, last_error: null,
        },
        reclaimResult: true,
        priorCounterError: { message: 'read replica unavailable' },
      },
    );
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    expect(send).not.toHaveBeenCalled();
    const rpcNames = (supabase.rpc as any).mock.calls.map((c: any[]) => c[0]);
    expect(rpcNames).not.toContain('claim_scheduled_message_send');
    // No terminal write: the reclaimed claim survives for a later retry.
    expect(updates.some((u) => u.payload.status === 'completed')).toBe(false);
    expect(updates.some((u) => u.payload.status === 'failed')).toBe(false);
  });
});
