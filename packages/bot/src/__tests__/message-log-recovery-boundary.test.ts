import { beforeEach, describe, expect, it, vi } from 'vitest';

const { raiseOwnerAlert, resolveOwnerAlert, resolveOwnerAlertWithStatus } = vi.hoisted(() => ({
  raiseOwnerAlert: vi.fn().mockResolvedValue({ inserted: true, delivered: false }),
  resolveOwnerAlert: vi.fn(),
  resolveOwnerAlertWithStatus: vi.fn(),
}));

vi.mock('../services/alert-service.js', () => ({
  raiseOwnerAlert,
  resolveOwnerAlert,
  resolveOwnerAlertWithStatus,
}));
vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    setColor() { return this; }
    setAuthor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
    setFooter() { return this; }
    setTimestamp() { return this; }
    addFields() { return this; }
  },
}));

import { invalidateMessageLogCache, logMessageDelete } from '../features/message-log/index.js';

function chain(value: unknown) {
  const result: any = {};
  for (const method of ['select', 'eq', 'maybeSingle']) result[method] = vi.fn(() => result);
  result.then = (resolve: (input: unknown) => unknown) => resolve(value);
  return result;
}

function message(send: ReturnType<typeof vi.fn>, id: string) {
  return {
    id,
    author: { id: 'u1', tag: 'User#0001', bot: false, displayAvatarURL: () => '' },
    guild: {
      id: 'g1',
      channels: { cache: new Map([['log-ch', { id: 'log-ch', send }]]) },
    },
    channel: { id: 'source' },
    content: 'deleted',
    attachments: new Map(),
  } as any;
}

describe('message-log recovery boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    raiseOwnerAlert.mockReset().mockResolvedValue({ inserted: true, delivered: false });
    resolveOwnerAlert.mockReset().mockResolvedValue(undefined);
    resolveOwnerAlertWithStatus.mockReset().mockResolvedValue({
      resolvedCount: 1,
      succeeded: true,
    });
    invalidateMessageLogCache();
  });

  it('does not resend an accepted Discord log when alert recovery fails', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }))
      .mockResolvedValue(undefined);
    resolveOwnerAlertWithStatus
      .mockResolvedValueOnce({ resolvedCount: 0, succeeded: false })
      .mockResolvedValueOnce({ resolvedCount: 1, succeeded: true });
    const client = {
      supabase: {
        from: vi.fn(() => chain({
          data: {
            message_log_enabled: true,
            message_log_channel_id: 'log-ch',
            message_log_edits_enabled: true,
            message_log_deletes_enabled: true,
            message_log_ignored_channel_ids: [],
          },
          error: null,
        })),
      },
      eventBus: { emit: vi.fn() },
      guilds: { cache: new Map() },
    };

    await logMessageDelete(client as any, message(send, 'failed'));
    await logMessageDelete(client as any, message(send, 'recovered'));
    await logMessageDelete(client as any, message(send, 'recovery-retry'));

    expect(send).toHaveBeenCalledTimes(3);
    expect(resolveOwnerAlertWithStatus.mock.calls.filter(
      (call) => call[2] === 'message_log_delivery_failed',
    )).toHaveLength(2);
  });

  it('retries owner notification on a backoff while emitting the degraded transition once', async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    raiseOwnerAlert
      .mockResolvedValueOnce({ inserted: false, delivered: false })
      .mockResolvedValueOnce({ inserted: true, delivered: false });
    const client = {
      supabase: {
        from: vi.fn(() => chain({
          data: {
            message_log_enabled: true,
            message_log_channel_id: 'log-ch',
            message_log_edits_enabled: true,
            message_log_deletes_enabled: true,
            message_log_ignored_channel_ids: [],
          },
          error: null,
        })),
      },
      eventBus: { emit: vi.fn() },
      guilds: { cache: new Map() },
    };

    vi.useFakeTimers();
    try {
      await logMessageDelete(client as any, message(send, 'failed-1'));
      // Inside the one-minute backoff: no duplicate DB attempt per failure.
      await logMessageDelete(client as any, message(send, 'failed-1b'));
      expect(raiseOwnerAlert).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(61_000);
      await logMessageDelete(client as any, message(send, 'failed-2'));
    } finally {
      vi.useRealTimers();
    }

    expect(raiseOwnerAlert).toHaveBeenCalledTimes(2);
    expect(client.eventBus.emit.mock.calls.filter(
      (call) => call[0] === 'message_log.delivery_failed',
    )).toHaveLength(1);
  });

  it('keeps retrying the owner ping after the durable row exists, latching only on delivery (round 12)', async () => {
    // Latching on the ROW alone meant a ping that failed (alert channel
    // briefly unavailable) was never retried: repairing the channel produced
    // no notice until message-log itself recovered.
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    raiseOwnerAlert
      .mockResolvedValueOnce({ inserted: true, delivered: false })
      .mockResolvedValueOnce({ inserted: false, insertErrorCode: '23505', delivered: false })
      .mockResolvedValueOnce({ inserted: false, insertErrorCode: '23505', delivered: true });
    const client = {
      supabase: {
        from: vi.fn(() => chain({
          data: {
            message_log_enabled: true,
            message_log_channel_id: 'log-ch',
            message_log_edits_enabled: true,
            message_log_deletes_enabled: true,
            message_log_ignored_channel_ids: [],
          },
          error: null,
        })),
      },
      eventBus: { emit: vi.fn() },
      guilds: { cache: new Map() },
    };

    vi.useFakeTimers();
    try {
      await logMessageDelete(client as any, message(send, 'ping-1'));
      vi.advanceTimersByTime(61_000);
      await logMessageDelete(client as any, message(send, 'ping-2'));
      vi.advanceTimersByTime(61_000);
      await logMessageDelete(client as any, message(send, 'ping-3'));
      expect(raiseOwnerAlert).toHaveBeenCalledTimes(3);
      // Delivered on the third attempt → latched: no further attempts.
      vi.advanceTimersByTime(61_000);
      await logMessageDelete(client as any, message(send, 'ping-4'));
    } finally {
      vi.useRealTimers();
    }

    expect(raiseOwnerAlert).toHaveBeenCalledTimes(3);
  });
});
