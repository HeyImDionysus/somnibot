/**
 * message-log/index — SET-B controls, resilient send (retry/backoff), and
 * per-event dedupe. Guards the fleet findings:
 *  - log-edits-enabled / log-deletes-enabled / ignored-channel-ids
 *  - transient Discord fault no longer drops the forensic record
 *  - a re-delivered messageUpdate/messageDelete does not double-post
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: vi.fn().mockImplementation(function () {
    return {
      setColor: vi.fn().mockReturnThis(),
      setAuthor: vi.fn().mockReturnThis(),
      setTitle: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      setFooter: vi.fn().mockReturnThis(),
      setTimestamp: vi.fn().mockReturnThis(),
      addFields: vi.fn().mockReturnThis(),
    };
  }),
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { logMessageEdit, logMessageDelete, invalidateMessageLogCache } from '../features/message-log/index.js';

function chainBuilder(resolveValue: any) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'maybeSingle']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeClient(config: any) {
  return {
    supabase: { from: vi.fn().mockReturnValue(chainBuilder({ data: config, error: null })) },
  };
}

function makeMessage(sendMock: any, overrides: any = {}) {
  return {
    id: overrides.id ?? 'msg1',
    author: { id: 'u1', tag: 'User#0001', bot: false, displayAvatarURL: () => 'https://cdn/av.png' },
    guild: {
      id: 'g1',
      channels: { cache: new Map([['log-ch', { send: sendMock }]]) },
    },
    channel: { id: overrides.channelId ?? 'ch1' },
    content: overrides.content ?? 'hello',
    url: 'https://discord.com/msg',
    editedTimestamp: overrides.editedTimestamp,
    attachments: new Map(),
    ...overrides,
  };
}

const FULL = {
  message_log_enabled: true,
  message_log_channel_id: 'log-ch',
  message_log_edits_enabled: true,
  message_log_deletes_enabled: true,
  message_log_ignored_channel_ids: [] as string[],
};

describe('message-log SET-B controls', () => {
  beforeEach(() => { vi.clearAllMocks(); invalidateMessageLogCache(); });

  it('suppresses the edit embed when edits are disabled, but still logs a delete', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ ...FULL, message_log_edits_enabled: false });
    const oldMsg = makeMessage(send, { id: 'e1', content: 'old' });
    const newMsg = makeMessage(send, { id: 'e1', content: 'new' });
    await logMessageEdit(client as any, oldMsg as any, newMsg as any);
    expect(send).not.toHaveBeenCalled();

    // deletes still enabled → delete posts
    const del = makeMessage(send, { id: 'e1b' });
    await logMessageDelete(client as any, del as any);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('suppresses the delete embed when deletes are disabled', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ ...FULL, message_log_deletes_enabled: false });
    const del = makeMessage(send, { id: 'd1' });
    await logMessageDelete(client as any, del as any);
    expect(send).not.toHaveBeenCalled();
  });

  it('produces nothing for edits or deletes in an ignored channel', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ ...FULL, message_log_ignored_channel_ids: ['ch1'] });
    const oldMsg = makeMessage(send, { id: 'i1', content: 'old', channelId: 'ch1' });
    const newMsg = makeMessage(send, { id: 'i1', content: 'new', channelId: 'ch1' });
    await logMessageEdit(client as any, oldMsg as any, newMsg as any);
    const del = makeMessage(send, { id: 'i2', channelId: 'ch1' });
    await logMessageDelete(client as any, del as any);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('message-log resilient send', () => {
  beforeEach(() => { vi.clearAllMocks(); invalidateMessageLogCache(); });

  it('retries a transient failure and posts exactly one embed', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('server error'), { status: 500 }))
      .mockResolvedValueOnce(undefined);
    const client = makeClient(FULL);
    const del = makeMessage(send, { id: 'r1' });
    await logMessageDelete(client as any, del as any);
    expect(send).toHaveBeenCalledTimes(2); // one retry, then success
  });

  it('gives up immediately on a permanent 4xx (missing permissions)', async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const client = makeClient(FULL);
    const del = makeMessage(send, { id: 'r2' });
    await logMessageDelete(client as any, del as any);
    expect(send).toHaveBeenCalledTimes(1); // no retry on 4xx
  });
});

describe('message-log per-event dedupe', () => {
  beforeEach(() => { vi.clearAllMocks(); invalidateMessageLogCache(); });

  it('posts a re-delivered delete only once', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const client = makeClient(FULL);
    const del = makeMessage(send, { id: 'dupdel' });
    await logMessageDelete(client as any, del as any);
    await logMessageDelete(client as any, del as any); // gateway RESUME replay
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('posts a re-delivered edit only once (same edit timestamp)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const client = makeClient(FULL);
    const oldMsg = makeMessage(send, { id: 'dupedit', content: 'old', editedTimestamp: 123 });
    const newMsg = makeMessage(send, { id: 'dupedit', content: 'new', editedTimestamp: 456 });
    await logMessageEdit(client as any, oldMsg as any, newMsg as any);
    await logMessageEdit(client as any, oldMsg as any, newMsg as any);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
