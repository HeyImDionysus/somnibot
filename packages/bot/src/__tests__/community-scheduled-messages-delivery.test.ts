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
  options: { counterError?: { message: string } } = {},
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
    c.maybeSingle = async () => ({ data: null, error: null });
    c.single = async () => {
      if (table === 'discord_operation_occurrences' && c._insertRow) {
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
  const rpc = vi.fn(async () => {
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
