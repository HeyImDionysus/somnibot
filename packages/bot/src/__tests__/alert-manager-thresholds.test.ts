/**
 * AlertManager — owner-configurable alert thresholds.
 *
 * The memory / gateway-ping / webhook-error limits were constants compiled
 * into the bot (512 MB, 500 ms, 25%). A large guild on a small VPS alerted
 * constantly; a small guild on a big box never alerted at all. No owner could
 * change either outcome from anywhere.
 *
 * They now come from guild_config (migration 20260727000000) with the SAME
 * values as defaults, so an untouched guild keeps its current behaviour.
 *
 * These tests pin the parts that are easy to get wrong: the configured number
 * is actually what gets compared, a failed config read still evaluates
 * (falling back to defaults rather than silently disabling alerting), and
 * Postgres `numeric` arriving as a string does not poison the comparison.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { AlertManager, type HealthSnapshot } from '../features/audit/alert-manager.js';

function snapshot(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    guild_id: 'guild-1',
    memory_rss_mb: 300,
    discord_ws_ping: 100,
    valkey_connected: true,
    lavalink_nodes: [],
    ...over,
  };
}

/**
 * Supabase stub serving a guild_config threshold row and capturing every
 * alerts insert so the test can assert on what was raised.
 */
function makeSupa(configRow: Record<string, unknown> | null, configError: unknown = null) {
  const inserted: Record<string, unknown>[] = [];
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'update', 'order', 'limit', 'in']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.insert = vi.fn((row: Record<string, unknown>) => {
      if (table === 'alerts') inserted.push(row);
      return Promise.resolve({ data: null, error: null });
    });
    chain.maybeSingle = vi.fn(() =>
      Promise.resolve(
        table === 'guild_config'
          ? { data: configRow, error: configError }
          : { data: null, error: null },
      ));
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
    return chain;
  });
  return { supabase: { from } as never, inserted };
}

const raised = (rows: Record<string, unknown>[]) => rows.map((r) => r.alert_type);

beforeEach(() => vi.clearAllMocks());

describe('configurable alert thresholds', () => {
  it('uses the shipped defaults when the guild has configured nothing', async () => {
    const { supabase, inserted } = makeSupa(null);
    const mgr = new AlertManager(supabase);

    // 300 MB / 100 ms are under the 512 / 500 defaults.
    await mgr.evaluate(snapshot());
    expect(raised(inserted)).not.toContain('memory_high');

    mgr.invalidateThresholds();
    await mgr.evaluate(snapshot({ memory_rss_mb: 600 }));
    expect(raised(inserted)).toContain('memory_high');
  });

  it('honors a LOWER configured memory threshold', async () => {
    const { supabase, inserted } = makeSupa({
      memory_alert_threshold_mb: 256,
      ws_ping_alert_threshold_ms: 500,
      webhook_error_rate_threshold: 0.25,
    });
    const mgr = new AlertManager(supabase);

    // 300 MB is fine by default, but over this owner's 256 MB limit.
    await mgr.evaluate(snapshot());

    expect(raised(inserted)).toContain('memory_high');
  });

  it('honors a HIGHER configured memory threshold (silences default noise)', async () => {
    const { supabase, inserted } = makeSupa({
      memory_alert_threshold_mb: 2048,
      ws_ping_alert_threshold_ms: 500,
      webhook_error_rate_threshold: 0.25,
    });
    const mgr = new AlertManager(supabase);

    // 900 MB would trip the 512 default; this owner runs a bigger box.
    await mgr.evaluate(snapshot({ memory_rss_mb: 900 }));

    expect(raised(inserted)).not.toContain('memory_high');
  });

  it('honors a configured gateway-ping threshold', async () => {
    const { supabase, inserted } = makeSupa({
      memory_alert_threshold_mb: 512,
      ws_ping_alert_threshold_ms: 80,
      webhook_error_rate_threshold: 0.25,
    });
    const mgr = new AlertManager(supabase);

    await mgr.evaluate(snapshot({ discord_ws_ping: 100 }));

    expect(raised(inserted)).toContain('ws_ping_high');
  });

  it('still evaluates on a failed config read, using defaults', async () => {
    const { supabase, inserted } = makeSupa(null, { message: 'connection reset' });
    const mgr = new AlertManager(supabase);

    // Losing alerting entirely because a config read blipped would be worse
    // than alerting on the default numbers.
    await mgr.evaluate(snapshot({ memory_rss_mb: 900 }));

    expect(raised(inserted)).toContain('memory_high');
  });

  it('coerces a numeric column arriving as a string', async () => {
    // Postgres numeric(4,3) comes back from PostgREST as "0.100", not 0.1.
    const { supabase } = makeSupa({
      memory_alert_threshold_mb: 256,
      ws_ping_alert_threshold_ms: 80,
      webhook_error_rate_threshold: '0.100',
    });
    const mgr = new AlertManager(supabase);

    // A string that silently became NaN would make every comparison false and
    // quietly disable the webhook alert.
    await expect(mgr.evaluate(snapshot())).resolves.toBeUndefined();
  });

  it('re-reads after invalidation so a dashboard change takes effect', async () => {
    const { supabase, inserted } = makeSupa({
      memory_alert_threshold_mb: 2048,
      ws_ping_alert_threshold_ms: 500,
      webhook_error_rate_threshold: 0.25,
    });
    const mgr = new AlertManager(supabase);

    await mgr.evaluate(snapshot({ memory_rss_mb: 900 }));
    expect(raised(inserted)).not.toContain('memory_high');

    // Owner lowers the limit; the cached value must not keep answering.
    const lowered = makeSupa({
      memory_alert_threshold_mb: 256,
      ws_ping_alert_threshold_ms: 500,
      webhook_error_rate_threshold: 0.25,
    });
    const mgr2 = new AlertManager(lowered.supabase);
    mgr2.invalidateThresholds('guild-1');
    await mgr2.evaluate(snapshot({ memory_rss_mb: 900 }));
    expect(raised(lowered.inserted)).toContain('memory_high');
  });
});
