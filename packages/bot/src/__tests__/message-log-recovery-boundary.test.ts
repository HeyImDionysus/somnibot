import { beforeEach, describe, expect, it, vi } from 'vitest';

const { raiseOwnerAlert, resolveOwnerAlert } = vi.hoisted(() => ({
  raiseOwnerAlert: vi.fn().mockResolvedValue({ inserted: true, delivered: false }),
  resolveOwnerAlert: vi.fn(),
}));

vi.mock('../services/alert-service.js', () => ({
  raiseOwnerAlert,
  resolveOwnerAlert,
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
    invalidateMessageLogCache();
  });

  it('does not resend an accepted Discord log when alert recovery fails', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }))
      .mockResolvedValue(undefined);
    resolveOwnerAlert.mockRejectedValue(new Error('alerts unavailable'));
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

    expect(send).toHaveBeenCalledTimes(2);
    expect(resolveOwnerAlert.mock.calls.filter(
      (call) => call[2] === 'message_log_delivery_failed',
    )).toHaveLength(1);
  });

  it('retries owner notification while emitting the degraded transition once', async () => {
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

    await logMessageDelete(client as any, message(send, 'failed-1'));
    await logMessageDelete(client as any, message(send, 'failed-2'));

    expect(raiseOwnerAlert).toHaveBeenCalledTimes(2);
    expect(client.eventBus.emit.mock.calls.filter(
      (call) => call[0] === 'message_log.delivery_failed',
    )).toHaveLength(1);
  });
});
