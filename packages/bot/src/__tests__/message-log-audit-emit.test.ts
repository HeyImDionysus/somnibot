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
  const guildConfigChain: any = {
    select: vi.fn(() => guildConfigChain),
    eq: vi.fn(() => guildConfigChain),
    maybeSingle: vi.fn(async () => ({ data: state.config, error: state.error })),
  };
  const emit = vi.fn();
  const client = {
    supabase: { from: vi.fn((t: string) => (t === 'alerts' ? { insert: alertsInsert } : guildConfigChain)) },
    eventBus: { emit },
  } as any;
  return { client, state, emit, alertsInsert };
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
    expect(alertsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ guild_id: 'g1', alert_type: 'message_log_degraded' }),
    );
    // ...and logging falls back to safe (disabled) defaults.
    expect(cfg.message_log_enabled).toBe(false);
  });
});
