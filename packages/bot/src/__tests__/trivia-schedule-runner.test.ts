/**
 * TriviaScheduleRunner — hosted/scheduled trivia cadence.
 *
 * Covers the tick logic: gating on the two independent toggles, seeding the
 * baseline without posting, the interval pre-filter, the atomic claim → post
 * path, category/difficulty pass-through, losing the claim, and the one-shot
 * channel-missing owner alert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { TriviaScheduleRunner } from '../features/trivia/schedule-runner.js';

// ── Helpers ───────────────────────────────────────────────

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}
function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString();
}

interface SupaCalls {
  updates: Array<{ table: string; payload: Record<string, unknown> }>;
  inserts: Array<{ table: string; payload: Record<string, unknown> }>;
  isNullUsed: boolean;
  lteUsed: boolean;
}

function makeSupabase(opts: { configRow?: Record<string, unknown> | null; claimRows?: unknown[] } = {}) {
  const configRow = opts.configRow ?? null;
  const claimRows = opts.claimRows ?? [{ guild_id: 'g1' }];
  const calls: SupaCalls = { updates: [], inserts: [], isNullUsed: false, lteUsed: false };

  function makeChain(table: string) {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.update = vi.fn((payload: Record<string, unknown>) => { calls.updates.push({ table, payload }); return chain; });
    chain.insert = vi.fn((payload: Record<string, unknown>) => { calls.inserts.push({ table, payload }); return chain; });
    chain.is = vi.fn(() => { calls.isNullUsed = true; return chain; });
    chain.lte = vi.fn(() => { calls.lteUsed = true; return chain; });
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: configRow, error: null }));
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: claimRows, error: null });
    return chain;
  }

  return {
    from: vi.fn((table: string) => makeChain(table)),
    _calls: calls,
  };
}

function makeChannel(id = 'sch1') {
  return { id, name: 'trivia-time', isTextBased: () => true };
}

function makeGuild(channel?: { id: string }) {
  return {
    id: 'g1',
    channels: { cache: new Map(channel ? [[channel.id, channel]] : []) },
  };
}

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return {
    economy_trivia_enabled: true,
    economy_trivia_schedule_enabled: true,
    economy_trivia_schedule_interval_minutes: 60,
    economy_trivia_schedule_channel_id: 'sch1',
    economy_trivia_schedule_category: null,
    economy_trivia_schedule_difficulty: null,
    economy_trivia_schedule_last_run_at: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('TriviaScheduleRunner', () => {
  let trivia: { startScheduledRound: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    trivia = { startScheduledRound: vi.fn().mockResolvedValue({ started: true }) };
  });

  it('exposes start/stop lifecycle methods', () => {
    const runner = new TriviaScheduleRunner(makeGuild() as any, makeSupabase() as any, trivia as any);
    expect(typeof runner.start).toBe('function');
    expect(typeof runner.stop).toBe('function');
    runner.start();
    runner.stop();
  });

  it('does nothing when the hosted schedule is disabled', async () => {
    const supabase = makeSupabase({ configRow: enabledConfig({ economy_trivia_schedule_enabled: false }) });
    const runner = new TriviaScheduleRunner(makeGuild(makeChannel()) as any, supabase as any, trivia as any);
    await runner.tick();
    expect(trivia.startScheduledRound).not.toHaveBeenCalled();
    expect(supabase._calls.updates).toHaveLength(0);
  });

  it('does nothing when the trivia master switch is off (schedule cannot override it)', async () => {
    const supabase = makeSupabase({
      configRow: enabledConfig({ economy_trivia_enabled: false, economy_trivia_schedule_last_run_at: hoursAgo(2) }),
    });
    const runner = new TriviaScheduleRunner(makeGuild(makeChannel()) as any, supabase as any, trivia as any);
    await runner.tick();
    expect(trivia.startScheduledRound).not.toHaveBeenCalled();
  });

  it('does nothing when no schedule channel is configured', async () => {
    const supabase = makeSupabase({
      configRow: enabledConfig({ economy_trivia_schedule_channel_id: null, economy_trivia_schedule_last_run_at: hoursAgo(2) }),
    });
    const runner = new TriviaScheduleRunner(makeGuild() as any, supabase as any, trivia as any);
    await runner.tick();
    expect(trivia.startScheduledRound).not.toHaveBeenCalled();
    expect(supabase._calls.updates).toHaveLength(0);
  });

  it('seeds the baseline without posting on the first observation (null last_run)', async () => {
    const channel = makeChannel();
    const supabase = makeSupabase({ configRow: enabledConfig({ economy_trivia_schedule_last_run_at: null }) });
    const runner = new TriviaScheduleRunner(makeGuild(channel) as any, supabase as any, trivia as any);
    await runner.tick();
    expect(trivia.startScheduledRound).not.toHaveBeenCalled();
    expect(supabase._calls.updates).toHaveLength(1);
    expect(supabase._calls.isNullUsed).toBe(true);
  });

  it('does not post before the interval has elapsed', async () => {
    const channel = makeChannel();
    const supabase = makeSupabase({ configRow: enabledConfig({ economy_trivia_schedule_last_run_at: minutesAgo(5) }) });
    const runner = new TriviaScheduleRunner(makeGuild(channel) as any, supabase as any, trivia as any);
    await runner.tick();
    expect(trivia.startScheduledRound).not.toHaveBeenCalled();
    expect(supabase._calls.updates).toHaveLength(0);
  });

  it('claims and posts a hosted round once the interval has elapsed', async () => {
    const channel = makeChannel('sch1');
    const supabase = makeSupabase({
      configRow: enabledConfig({ economy_trivia_schedule_last_run_at: hoursAgo(2) }),
      claimRows: [{ guild_id: 'g1' }],
    });
    const runner = new TriviaScheduleRunner(makeGuild(channel) as any, supabase as any, trivia as any);
    await runner.tick();
    expect(supabase._calls.updates).toHaveLength(1);
    expect(supabase._calls.lteUsed).toBe(true);
    expect(trivia.startScheduledRound).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'g1' }),
      channel,
      undefined,
      undefined,
    );
  });

  it('passes the pinned category and difficulty through to the round', async () => {
    const channel = makeChannel('sch1');
    const supabase = makeSupabase({
      configRow: enabledConfig({
        economy_trivia_schedule_last_run_at: hoursAgo(2),
        economy_trivia_schedule_category: 'science',
        economy_trivia_schedule_difficulty: 'hard',
      }),
    });
    const runner = new TriviaScheduleRunner(makeGuild(channel) as any, supabase as any, trivia as any);
    await runner.tick();
    expect(trivia.startScheduledRound).toHaveBeenCalledWith(expect.anything(), channel, 'science', 'hard');
  });

  it('ignores an invalid pinned difficulty (falls back to undefined)', async () => {
    const channel = makeChannel('sch1');
    const supabase = makeSupabase({
      configRow: enabledConfig({
        economy_trivia_schedule_last_run_at: hoursAgo(2),
        economy_trivia_schedule_difficulty: 'impossible',
      }),
    });
    const runner = new TriviaScheduleRunner(makeGuild(channel) as any, supabase as any, trivia as any);
    await runner.tick();
    expect(trivia.startScheduledRound).toHaveBeenCalledWith(expect.anything(), channel, undefined, undefined);
  });

  it('does not post when the atomic claim is lost to another instance', async () => {
    const channel = makeChannel('sch1');
    const supabase = makeSupabase({
      configRow: enabledConfig({ economy_trivia_schedule_last_run_at: hoursAgo(2) }),
      claimRows: [], // claim matched zero rows → lost
    });
    const runner = new TriviaScheduleRunner(makeGuild(channel) as any, supabase as any, trivia as any);
    await runner.tick();
    expect(trivia.startScheduledRound).not.toHaveBeenCalled();
  });

  it('raises exactly one owner alert when the configured channel is missing', async () => {
    const supabase = makeSupabase({
      configRow: enabledConfig({ economy_trivia_schedule_last_run_at: hoursAgo(2) }),
      claimRows: [{ guild_id: 'g1' }],
    });
    const runner = new TriviaScheduleRunner(makeGuild(/* no channel in cache */) as any, supabase as any, trivia as any);
    await runner.tick();
    await runner.tick(); // second due tick must NOT re-alert (in-memory dedupe)
    expect(trivia.startScheduledRound).not.toHaveBeenCalled();
    const alertInserts = supabase._calls.inserts.filter((i) => i.table === 'alerts');
    expect(alertInserts).toHaveLength(1);
    expect(alertInserts[0]!.payload.alert_type).toBe('trivia_schedule_channel_missing');
  });
});
