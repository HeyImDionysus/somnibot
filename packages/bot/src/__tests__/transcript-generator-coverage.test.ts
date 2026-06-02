/**
 * tickets/transcript-generator — coverage tests
 *
 * Tests generateTranscript with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  AttachmentBuilder: vi.fn().mockImplementation((_buf: any, opts: any) => ({
    name: opts?.name,
  })),
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { generateTranscript } from '../features/tickets/transcript-generator.js';

function chainBuilder(resolveValue: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'single', 'maybeSingle', 'order', 'limit', 'delete']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeMessages(count: number) {
  const msgs: any[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      id: `msg-${i}`,
      author: {
        id: `u${i}`,
        tag: `User${i}#0001`,
        displayName: `User${i}`,
        displayAvatarURL: (_opts?: any) => `https://cdn.example.com/u${i}.png`,
        bot: i === 0,
      },
      member: { displayName: `User${i}` },
      content: `Message ${i} with **bold** and *italic* and \`code\` and <@1234> and <#5678>`,
      createdAt: new Date(2026, 0, 1, i),
      attachments: Object.assign(
        new Map(i === 1 ? [['att1', { name: 'file.png', url: 'https://cdn.example.com/file.png', contentType: 'image/png' }]] : []),
        { map: (fn: any) => i === 1 ? [{ name: 'file.png', url: 'https://cdn.example.com/file.png', contentType: 'image/png' }].map(fn) : [] },
      ),
      embeds: i === 2 ? [{ title: 'Embed Title', description: 'Embed desc' }] : [],
    });
  }

  return {
    size: msgs.length,
    values: () => msgs[Symbol.iterator](),
    last: () => msgs[msgs.length - 1],
    map: (fn: any) => msgs.map(fn),
  };
}

function makeChannel(messageCount = 5) {
  let called = false;
  return {
    id: 'ticket-ch',
    messages: {
      fetch: vi.fn().mockImplementation(async () => {
        if (!called) {
          called = true;
          return makeMessages(messageCount);
        }
        return makeMessages(0);
      }),
    },
  };
}

function makeGuild(channel: any, extraChannels: [string, any][] = []) {
  return {
    id: 'g1',
    name: 'Test Guild',
    channels: {
      cache: new Map([['ticket-ch', channel], ...extraChannels]),
    },
    members: {
      fetch: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
}

function makeTicket(overrides: any = {}) {
  return {
    id: 't1',
    ticket_number: 42,
    channel_id: 'ticket-ch',
    creator_id: 'u1',
    created_at: '2026-01-01T00:00:00Z',
    closed_at: '2026-01-01T12:00:00Z',
    closed_by: 'mod1',
    panel_id: 'panel1',
    ...overrides,
  };
}

/** Build supabase mock that supports sequential from() calls with different tables. */
function makeSupabase(tableResponses: Record<string, any>) {
  const callCounts: Record<string, number> = {};
  return {
    from: vi.fn().mockImplementation((table: string) => {
      callCounts[table] = (callCounts[table] ?? 0) + 1;
      const resp = tableResponses[table];
      if (Array.isArray(resp)) {
        // Support multiple responses per table
        const idx = Math.min(callCounts[table] - 1, resp.length - 1);
        return chainBuilder(resp[idx]);
      }
      return chainBuilder(resp ?? { data: null, error: null });
    }),
  };
}

describe('generateTranscript', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('generates transcript successfully', async () => {
    const channel = makeChannel(5);
    const guild = makeGuild(channel);
    const supabase = makeSupabase({
      ticket_transcripts: { data: null, error: null },
      tickets: { data: null, error: null },
      ticket_panels: { data: { transcript_channel_id: null, dm_transcript_to_creator: false }, error: null },
    });
    const result = await generateTranscript(guild as any, makeTicket(), supabase as any);
    expect(result.success).toBe(true);
    expect(result.html).toContain('Ticket #42');
    expect(result.html).toContain('<!DOCTYPE html>');
  });

  it('returns error when ticket has no channel', async () => {
    const result = await generateTranscript({} as any, makeTicket({ channel_id: null }), {} as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('no channel');
  });

  it('returns error when channel not found', async () => {
    const guild = { channels: { cache: new Map() } };
    const result = await generateTranscript(guild as any, makeTicket(), {} as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error on DB insert failure', async () => {
    const channel = makeChannel(3);
    const guild = makeGuild(channel);
    const supabase = makeSupabase({
      ticket_transcripts: { data: null, error: { message: 'insert failed' } },
    });
    const result = await generateTranscript(guild as any, makeTicket(), supabase as any);
    expect(result.success).toBe(false);
  });

  it('posts transcript to transcript channel', async () => {
    const channel = makeChannel(3);
    const transcriptSend = vi.fn().mockResolvedValue(undefined);
    const transcriptChannel = { send: transcriptSend };
    const guild = makeGuild(channel, [['transcript-ch', transcriptChannel]]);
    const supabase = makeSupabase({
      ticket_transcripts: { data: null, error: null },
      tickets: { data: null, error: null },
      ticket_panels: {
        data: { transcript_channel_id: 'transcript-ch', dm_transcript_to_creator: false },
        error: null,
      },
    });
    const result = await generateTranscript(guild as any, makeTicket(), supabase as any);
    expect(result.success).toBe(true);
    expect(transcriptSend).toHaveBeenCalled();
  });

  it('DMs transcript to creator when enabled', async () => {
    const channel = makeChannel(2);
    const memberSend = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild(channel);
    guild.members.fetch.mockResolvedValue({ send: memberSend });
    const supabase = makeSupabase({
      ticket_transcripts: { data: null, error: null },
      tickets: { data: null, error: null },
      ticket_panels: {
        data: { transcript_channel_id: null, dm_transcript_to_creator: true },
        error: null,
      },
    });
    const result = await generateTranscript(guild as any, makeTicket(), supabase as any);
    expect(result.success).toBe(true);
    expect(memberSend).toHaveBeenCalled();
  });
});
