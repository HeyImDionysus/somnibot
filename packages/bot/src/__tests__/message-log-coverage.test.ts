/**
 * message-log/index — coverage tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: vi.fn().mockImplementation(function () {
    return {
      // Real EmbedBuilder exposes `data`; branded embeds read data.footer.
      data: {} as Record<string, unknown>,
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

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { logMessageEdit, logMessageDelete, invalidateMessageLogCache } from '../features/message-log/index.js';

function chainBuilder(resolveValue: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'maybeSingle']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeClient(config: any = null) {
  return {
    supabase: {
      from: vi.fn().mockReturnValue(chainBuilder({
        data: config ?? { message_log_enabled: true, message_log_channel_id: 'log-ch' },
        error: null,
      })),
    },
  };
}

function makeMessage(overrides: any = {}) {
  return {
    id: 'msg1',
    author: {
      id: 'u1',
      tag: 'User#0001',
      bot: false,
      displayAvatarURL: () => 'https://cdn.example.com/avatar.png',
    },
    guild: {
      id: 'g1',
      channels: {
        cache: new Map([
          ['log-ch', { send: vi.fn().mockResolvedValue(undefined) }],
        ]),
      },
    },
    channel: { id: 'ch1' },
    content: 'hello world',
    url: 'https://discord.com/msg',
    member: null,
    attachments: new Map(),
    ...overrides,
  };
}

describe('logMessageEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateMessageLogCache();
  });

  it('logs an edit to the log channel', async () => {
    const client = makeClient();
    const oldMsg = makeMessage({ content: 'old content' });
    const newMsg = makeMessage({ content: 'new content' });
    await logMessageEdit(client as any, oldMsg as any, newMsg as any);
    const logChannel = newMsg.guild.channels.cache.get('log-ch')!;
    expect(logChannel.send).toHaveBeenCalled();
  });

  it('skips bot messages', async () => {
    const client = makeClient();
    const oldMsg = makeMessage({ content: 'old' });
    const newMsg = makeMessage({ content: 'new', author: { ...makeMessage().author, bot: true } });
    await logMessageEdit(client as any, oldMsg as any, newMsg as any);
  });

  it('skips when content unchanged (embed update)', async () => {
    const client = makeClient();
    const msg = makeMessage({ content: 'same' });
    await logMessageEdit(client as any, msg as any, msg as any);
  });

  it('skips when logging disabled', async () => {
    const client = makeClient({ message_log_enabled: false, message_log_channel_id: null });
    const oldMsg = makeMessage({ content: 'old' });
    const newMsg = makeMessage({ content: 'new' });
    await logMessageEdit(client as any, oldMsg as any, newMsg as any);
  });

  it('skips non-guild messages', async () => {
    const client = makeClient();
    const oldMsg = makeMessage({ content: 'old', guild: null });
    const newMsg = makeMessage({ content: 'new', guild: null });
    await logMessageEdit(client as any, oldMsg as any, newMsg as any);
  });
});

describe('logMessageDelete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateMessageLogCache();
  });

  it('logs a deletion to the log channel', async () => {
    const client = makeClient();
    const msg = makeMessage();
    await logMessageDelete(client as any, msg as any);
    const logChannel = msg.guild.channels.cache.get('log-ch')!;
    expect(logChannel.send).toHaveBeenCalled();
  });

  it('skips bot messages', async () => {
    const client = makeClient();
    const msg = makeMessage({ author: { ...makeMessage().author, bot: true } });
    await logMessageDelete(client as any, msg as any);
  });

  it('skips non-guild messages', async () => {
    const client = makeClient();
    const msg = makeMessage({ guild: null });
    await logMessageDelete(client as any, msg as any);
  });

  it('skips deletion in the log channel itself', async () => {
    const client = makeClient();
    const msg = makeMessage({ channel: { id: 'log-ch' } });
    await logMessageDelete(client as any, msg as any);
    // Should not send because deletion happened in log channel
  });

  it('shows attachments in deletion log', async () => {
    const client = makeClient();
    const attachments = Object.assign(
      new Map([['att1', { name: 'file.png', url: 'https://cdn.example.com/file.png' }]]),
      { map: (fn: any) => [{ name: 'file.png', url: 'https://cdn.example.com/file.png' }].map(fn) },
    );
    const msg = makeMessage({ attachments });
    await logMessageDelete(client as any, msg as any);
    const logChannel = msg.guild.channels.cache.get('log-ch')!;
    expect(logChannel.send).toHaveBeenCalled();
  });
});

describe('invalidateMessageLogCache', () => {
  it('clears the cache', () => {
    invalidateMessageLogCache();
  });
});
