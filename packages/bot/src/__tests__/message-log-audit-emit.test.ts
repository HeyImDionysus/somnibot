/**
 * observability-gap [moderation-message-logging]:
 *  - Message-log config changes wrote no audit_logs row.
 *  - A DB config-fetch failure silently disabled logging with no owner alert/audit.
 *
 * These tests spy the eventBus + alerts insert and assert loadConfig emits
 * 'message_log.config_updated' when the persisted config drifts, and emits
 * 'message_log.degraded' + persists an owner alert when the config read fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({ EmbedBuilder: vi.fn() }));
vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { loadConfig, invalidateMessageLogCache } from '../features/message-log/index.js';

const FULL_A = {
  message_log_enabled: true,
  message_log_channel_id: 'ch-a',
  message_log_edits_enabled: true,
  message_log_deletes_enabled: true,
  message_log_ignored_channel_ids: [],
};

function makeClient(initial: { config?: any; error?: any } = {}) {
  const state = { config: initial.config ?? null, error: initial.error ?? null };
  const alertsInsert = vi.fn(async () => ({ error: null }));
  const alertsUpdate = vi.fn();
  const alertsChain: any = {
    insert: alertsInsert,
    update: vi.fn((patch: any) => {
      alertsUpdate(patch);
      return alertsChain;
    }),
    eq: vi.fn(() => alertsChain),
    contains: vi.fn(() => alertsChain),
    select: vi.fn(async () => ({ data: [{ id: 'a1' }], error: null })),
  };
  const guildConfigChain: any = {
    select: vi.fn(() => guildConfigChain),
    eq: vi.fn(() => guildConfigChain),
    maybeSingle: vi.fn(async () => ({ data: state.config, error: state.error })),
  };
  const emit = vi.fn();
  const client = {
    supabase: { from: vi.fn((t: string) => (t === 'alerts' ? alertsChain : guildConfigChain)) },
    eventBus: { emit },
    guilds: { cache: new Map() },
  } as any;
  return { client, state, emit, alertsInsert, alertsUpdate };
}

/** Flush the fire-and-forget resolveOwnerAlert chain queued by loadConfig. */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('message-log audit observability', () => {
  beforeEach(() => {
    invalidateMessageLogCache(); // full reset — clears baseline + degraded throttle
  });

  it('emits message_log.config_updated when the persisted config drifts', async () => {
    const { client, state, emit } = makeClient({ config: { ...FULL_A } });

    // First load seeds the baseline (no emit).
    await loadConfig(client, 'g1');
    expect(emit).not.toHaveBeenCalled();

    // Owner changes the log channel; the TTL cache is invalidated on reload.
    invalidateMessageLogCache('g1');
    state.config = { ...FULL_A, message_log_channel_id: 'ch-b' };
    await loadConfig(client, 'g1');

    expect(emit).toHaveBeenCalledWith(
      'message_log.config_updated',
      'g1',
      expect.objectContaining({
        changedBy: 'dashboard',
        changes: expect.objectContaining({ message_log_channel_id: 'ch-b' }),
      }),
    );
  });

  it('emits message_log.degraded and persists an owner alert on config-fetch failure', async () => {
    const { client, emit, alertsInsert } = makeClient({ config: null, error: { message: 'db unreachable' } });

    const cfg = await loadConfig(client, 'g1');

    // Degradation is surfaced...
    expect(emit).toHaveBeenCalledWith(
      'message_log.degraded',
      'g1',
      expect.objectContaining({ reason: 'config_fetch_failed' }),
    );
    // The alerts ROW keeps the raw DB error for the dashboard.
    expect(alertsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        guild_id: 'g1',
        alert_type: 'message_log_degraded',
        message: expect.stringContaining('db unreachable'),
      }),
    );
    // ...and logging falls back to safe (disabled) defaults.
    expect(cfg.message_log_enabled).toBe(false);
  });

  it('first successful load after a restart resolves a degraded alert left open across the boot', async () => {
    // Boot 1: config read fails → alert raised, in-memory flag set.
    const degraded = makeClient({ config: null, error: { message: 'db unreachable' } });
    await loadConfig(degraded.client, 'g1');
    expect(degraded.alertsInsert).toHaveBeenCalled();

    // Restart: every in-memory flag (incl. _degradedNotified) is wiped.
    invalidateMessageLogCache();

    // Boot 2: the DB has recovered — the FIRST successful load must resolve
    // the still-open row even though this process never saw the raise.
    const recovered = makeClient({ config: { ...FULL_A } });
    await loadConfig(recovered.client, 'g1');
    await flushAsync();

    expect(recovered.alertsUpdate).toHaveBeenCalledTimes(1);
    expect(recovered.alertsUpdate.mock.calls[0][0]).toMatchObject({ resolved: true });
  });

  it('boot recovery runs once per guild per boot — later loads skip the resolve when never degraded', async () => {
    const { client, alertsUpdate } = makeClient({ config: { ...FULL_A } });

    await loadConfig(client, 'g1');
    await flushAsync();
    expect(alertsUpdate).toHaveBeenCalledTimes(1);

    // Second load in the SAME boot (TTL cache dropped, e.g. config change):
    // never degraded since, so no repeat resolve call on the hot path.
    invalidateMessageLogCache('g1');
    await loadConfig(client, 'g1');
    await flushAsync();
    expect(alertsUpdate).toHaveBeenCalledTimes(1);
  });
});
