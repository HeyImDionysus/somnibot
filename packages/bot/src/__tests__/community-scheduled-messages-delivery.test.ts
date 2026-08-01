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
    /** When set, the scheduled_messages LIST load fails (non-authoritative). */
    schedulesLoadError?: { message: string };
    /** When set, claim_scheduled_message_send returns null (max_sends reached). */
    counterExhausted?: boolean;
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
      if (table === 'discord_operation_occurrences' && !c._insertRow) {
        // The per-tick stale-claim scan; code re-verifies status + staleness.
        return resolve({
          data: options.existingOccurrence ? [options.existingOccurrence] : [],
          error: null,
        });
      }
      if (table === 'scheduled_messages' && options.schedulesLoadError) {
        return resolve({ data: null, error: options.schedulesLoadError });
      }
      return resolve({ data: table === 'scheduled_messages' ? schedules : [], error: null });
    };
    return c;
  }
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === 'settle_discord_occurrence') {
      // Settlement moved to a merge RPC (round 28): record it like the old
      // occurrence table update so completion/failure assertions stay
      // anchored to the same collector.
      updates.push({
        payload: {
          status: args?.p_status,
          resource_id: args?.p_resource_id ?? null,
          result: args?.p_result ?? {},
          last_error: args?.p_last_error ?? null,
        },
      });
      return { data: true, error: null };
    }
    if (name === 'reclaim_stale_discord_occurrence') {
      const r = options.reclaimResult;
      if (r && typeof r === 'object' && 'error' in r) return { data: null, error: r.error };
      return { data: r === true, error: null };
    }
    if (options.counterError) return { data: null, error: options.counterError };
    if (options.counterExhausted) return { data: null, error: null };
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

  it('skip-missed advances last_sent_at to the last MISSED occurrence, not the recovery time (round 16)', async () => {
    // Stamping "now" made the next legitimate tick look like a duplicate to
    // the ordinary send guard: a minutely schedule recovered at :30 lost the
    // following :00.
    const Runner = await loadRunner();
    const sched = { ...BASE_SCHEDULE, missed_run_policy: 'skip-missed' };
    const { supabase, updates } = schedSupa([sched]);
    const { guild: g } = guild();
    const runner = new Runner(g, supabase);
    const baseline = new Date('2026-07-27T11:00:00.000Z');
    const lastOcc = new Date('2026-07-27T11:59:00.000Z');
    const now = new Date('2026-07-27T11:59:30.000Z');

    await (runner as any).noticeMissed(sched, baseline, lastOcc, now);

    const stamped = updates.find((u) => u.payload?.last_sent_at);
    expect(stamped?.payload.last_sent_at).toBe(lastOcc.toISOString());
  });

  it('rolls the baseline back when the missed-run notice cannot be made durable (round 22)', async () => {
    // raiseOwnerAlert reports failure instead of throwing; consuming the
    // missed occurrence anyway meant a transient alert outage silenced the
    // owner forever. The advance is rolled back so the next restart retries.
    const Runner = await loadRunner();
    const sched = { ...BASE_SCHEDULE, missed_run_policy: 'skip-missed' };
    const { supabase, updates } = schedSupa([sched]);
    const alertModule = await import('../services/alert-service.js');
    const raiseSpy = vi.spyOn(alertModule, 'raiseOwnerAlert').mockResolvedValue({
      inserted: false,
      delivered: false,
    } as never);
    try {
      const { guild: g } = guild();
      const runner = new Runner(g, supabase);
      const baseline = new Date('2026-07-27T11:00:00.000Z');
      const lastOcc = new Date('2026-07-27T11:59:00.000Z');
      const now = new Date('2026-07-27T11:59:30.000Z');

      await (runner as any).noticeMissed(sched, baseline, lastOcc, now);

      const stamps = updates
        .map((u) => u.payload?.last_sent_at)
        .filter((v): v is string => typeof v === 'string');
      // Advance won the single-winner race, then rolled back to the baseline.
      expect(stamps).toEqual([lastOcc.toISOString(), baseline.toISOString()]);
    } finally {
      raiseSpy.mockRestore();
    }
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
        existingOccurrence: { ...staleOccurrence(crashedMinute), occurrence_key: `sched1:${crashedMinute}` },
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
          occurrence_key: `sched1:${crashedMinute}`, status: 'claimed',
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
          occurrence_key: `sched1:${crashedMinute}`, status: 'claimed',
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

describe('ScheduledMessageRunner — recovery outruns the date bounds', () => {
  it('delivers a crashed final send even after the schedule end date has passed', async () => {
    // The crash window near an end date: the holder reserved the FINAL minute
    // inside the window, advanced the counter, and died. The claim only turns
    // reclaimable five minutes later — by which time end_date has passed, and
    // the date guard used to `continue` before recovery could run. The final
    // message stayed undelivered and its claim stranded, forever.
    const Runner = await loadRunner();
    const crashedMinute = new Date(Math.floor((Date.now() - 10 * 60_000) / 60_000) * 60_000)
      .toISOString();
    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const { supabase, updates } = schedSupa(
      [{
        ...BASE_SCHEDULE,
        end_date: new Date(Date.now() - 2 * 60_000).toISOString(), // window closed
        max_sends: 5,
        current_sends: 5, // the crashed reservation consumed the final slot
        last_sent_at: crashedMinute,
      }],
      {
        existingOccurrence: {
          id: 'occ-final', guild_id: 'g1', operation_kind: 'scheduled_message',
          occurrence_key: `sched1:${crashedMinute}`, status: 'claimed',
          claimed_at: staleAt, updated_at: staleAt,
          resource_id: null, result: {}, last_error: null,
        },
        reclaimResult: true,
        priorCounterRow: { current_sends: 5, last_sent_at: crashedMinute },
      },
    );
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    // The already-counted minute is delivered despite the closed window…
    expect(send).toHaveBeenCalledTimes(1);
    expect(updates.some((u) => u.payload.status === 'completed')).toBe(true);
    // …and no NEW counter slot is claimed for it.
    const rpcNames = (supabase.rpc as any).mock.calls.map((c: any[]) => c[0]);
    expect(rpcNames).not.toContain('claim_scheduled_message_send');
  });

  it('never uses recovery to sneak a NEW send past a closed window', async () => {
    // Same closed window, but the last counted minute completed cleanly.
    // Recovery must do nothing, and the date guard must keep blocking new
    // sends exactly as before.
    const Runner = await loadRunner();
    const doneMinute = new Date(Math.floor((Date.now() - 10 * 60_000) / 60_000) * 60_000)
      .toISOString();
    const { supabase } = schedSupa(
      [{
        ...BASE_SCHEDULE,
        end_date: new Date(Date.now() - 2 * 60_000).toISOString(),
        max_sends: 5,
        current_sends: 3,
        last_sent_at: doneMinute,
      }],
      {
        existingOccurrence: {
          id: 'occ-done', guild_id: 'g1', operation_kind: 'scheduled_message',
          occurrence_key: 'k-done', status: 'completed',
          claimed_at: doneMinute, updated_at: doneMinute,
          resource_id: 'msg-1', result: {}, last_error: null,
        },
        reclaimResult: true,
      },
    );
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    expect(send).not.toHaveBeenCalled();
    const rpcNames = (supabase.rpc as any).mock.calls.map((c: any[]) => c[0]);
    expect(rpcNames).not.toContain('reclaim_stale_discord_occurrence');
    expect(rpcNames).not.toContain('claim_scheduled_message_send');
  });
});

describe('ScheduledMessageRunner — a crashed minute cannot hide behind a later delivery', () => {
  it('recovers minute T even after T+1 delivered and advanced last_sent_at', async () => {
    // The failure the occurrence-table scan exists for: worker A counts minute
    // T and dies; worker B delivers T+1 before T turns stale. last_sent_at now
    // names T+1, so any recovery keyed from the schedule row can only ever see
    // the (completed) T+1 occurrence — T stayed claimed, undelivered, and
    // still consuming a send count, forever.
    const Runner = await loadRunner();
    const minuteT = new Date(Math.floor((Date.now() - 20 * 60_000) / 60_000) * 60_000)
      .toISOString();
    const minuteT1 = new Date(Date.parse(minuteT) + 60_000).toISOString();
    const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const { supabase, updates } = schedSupa(
      [{
        ...BASE_SCHEDULE,
        cron_expression: '0 0 1 1 *', // current minute is never due
        max_sends: 10,
        current_sends: 5,
        last_sent_at: minuteT1, // T+1 delivered — T is invisible to the schedule row
      }],
      {
        existingOccurrence: {
          id: 'occ-t', guild_id: 'g1', operation_kind: 'scheduled_message',
          occurrence_key: `sched1:${minuteT}`, status: 'claimed',
          claimed_at: staleAt, updated_at: staleAt,
          // The crashed holder committed its counter before dying — the
          // durable reservation flag is what authorizes slot-free delivery.
          resource_id: null, result: { counterReserved: true }, last_error: null,
        },
        reclaimResult: true,
        priorCounterRow: { current_sends: 5, last_sent_at: minuteT1 },
      },
    );
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    expect(send).toHaveBeenCalledTimes(1);
    expect(updates.some((u) => u.payload.status === 'completed')).toBe(true);
    const rpcNames = (supabase.rpc as any).mock.calls.map((c: any[]) => c[0]);
    expect(rpcNames).toContain('reclaim_stale_discord_occurrence');
    expect(rpcNames).not.toContain('claim_scheduled_message_send');
  });
});

describe('ScheduledMessageRunner — dead-schedule claims cannot pin the scan', () => {
  const STALE_AT = new Date(Date.now() - 20 * 60_000).toISOString();
  const CRASHED_MINUTE = new Date(Math.floor((Date.now() - 20 * 60_000) / 60_000) * 60_000)
    .toISOString();

  function deadScheduleClaim() {
    return {
      id: 'occ-dead', guild_id: 'g1', operation_kind: 'scheduled_message',
      // A schedule id that is NOT in the active list.
      occurrence_key: `deleted-sched:${CRASHED_MINUTE}`, status: 'claimed',
      claimed_at: STALE_AT, updated_at: STALE_AT,
      resource_id: null, result: {}, last_error: null,
    };
  }

  it('terminalizes a stale claim whose schedule is deleted or disabled', async () => {
    // Enough of these at the front of the 25-oldest batch and newer stale
    // claims for ACTIVE schedules were never reached until the blockers aged
    // past the 7-day window — days of undelivered counted sends.
    const Runner = await loadRunner();
    const { supabase, updates } = schedSupa([{ ...BASE_SCHEDULE, cron_expression: '0 0 1 1 *' }], {
      existingOccurrence: deadScheduleClaim(),
    });
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    expect(send).not.toHaveBeenCalled();
    const terminal = updates.find((u) => u.payload.status === 'failed');
    expect(terminal, 'the dead-schedule claim must be terminalized').toBeTruthy();
  });

  it('NEVER terminalizes on a failed schedule load — empty is not authoritative', async () => {
    // A transient load failure leaves `schedules` empty, indistinguishable
    // from "everything was deleted". Executing claims on that ambiguity would
    // destroy valid recovery work during any database blip.
    const Runner = await loadRunner();
    const { supabase, updates } = schedSupa([], {
      existingOccurrence: deadScheduleClaim(),
      schedulesLoadError: { message: 'db unavailable' },
    });
    const { guild: g } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    expect(updates.some((u) => u.payload.status === 'failed')).toBe(false);
  });
});

describe('ScheduledMessageRunner — recovery never bypasses max_sends on a guess', () => {
  it('claims a real slot for an UNRESERVED reclaimed minute, and skips when exhausted', async () => {
    // Review 3691625823: last_sent_at > dueMinute does NOT prove this minute
    // paid a slot — the holder can die before its counter call while later
    // minutes advance the counter. Without the durable counterReserved flag,
    // recovery must claim a fresh slot; on an exhausted schedule that claim
    // returns null and the occurrence completes as SKIPPED — the cap holds.
    const Runner = await loadRunner();
    const minuteT = new Date(Math.floor((Date.now() - 20 * 60_000) / 60_000) * 60_000)
      .toISOString();
    const minuteT1 = new Date(Date.parse(minuteT) + 60_000).toISOString();
    const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const { supabase, updates } = schedSupa(
      [{
        ...BASE_SCHEDULE,
        cron_expression: '0 0 1 1 *',
        max_sends: 2,
        current_sends: 2, // two LATER minutes consumed the cap
        last_sent_at: minuteT1,
      }],
      {
        existingOccurrence: {
          id: 'occ-unreserved', guild_id: 'g1', operation_kind: 'scheduled_message',
          occurrence_key: `sched1:${minuteT}`, status: 'claimed',
          claimed_at: staleAt, updated_at: staleAt,
          resource_id: null, result: {}, last_error: null, // NO reservation flag
        },
        reclaimResult: true,
        priorCounterRow: { current_sends: 2, last_sent_at: minuteT1 },
        counterExhausted: true,
      },
    );
    const { guild: g, send } = guild();
    const runner = new Runner(g, supabase);

    await (runner as any).tick();

    expect(send).not.toHaveBeenCalled();
    const rpcNames = (supabase.rpc as any).mock.calls.map((c: any[]) => c[0]);
    // The slot WAS honestly attempted…
    expect(rpcNames).toContain('claim_scheduled_message_send');
    // …and the exhausted answer terminalized the occurrence as skipped.
    expect(updates.some((u) => u.payload.status === 'completed')).toBe(true);
  });
});
