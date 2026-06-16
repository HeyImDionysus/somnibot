/**
 * tickets/panel-manager — coverage tests
 *
 * Tests postPanel and deletePanelMessage with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  ActionRowBuilder: vi.fn().mockImplementation(function () {
    return {
      components: [],
      addComponents: vi.fn().mockImplementation(function (this: any, ...c: any[]) {
        this.components.push(...c);
        return this;
      }),
    };
  }),
  ButtonBuilder: vi.fn().mockImplementation(function () {
    return {
      setCustomId: vi.fn().mockReturnThis(),
      setLabel: vi.fn().mockReturnThis(),
      setStyle: vi.fn().mockReturnThis(),
      setEmoji: vi.fn().mockReturnThis(),
    };
  }),
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
  EmbedBuilder: vi.fn().mockImplementation(function () {
    return {
      setColor: vi.fn().mockReturnThis(),
      setTitle: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      setFooter: vi.fn().mockReturnThis(),
      setThumbnail: vi.fn().mockReturnThis(),
    };
  }),
  StringSelectMenuBuilder: vi.fn().mockImplementation(function () {
    return {
      setCustomId: vi.fn().mockReturnThis(),
      setPlaceholder: vi.fn().mockReturnThis(),
      addOptions: vi.fn().mockReturnThis(),
    };
  }),
}));

vi.mock('@somnibot/shared', () => ({
  SOMNI_PALETTE: { HOT_PINK: 0xFF69B4 },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { postPanel, deletePanelMessage } from '../features/tickets/panel-manager.js';

function chainBuilder(resolveValue: any = { error: null }) {
  const chain: any = {};
  for (const m of ['update', 'eq']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeChannel() {
  return {
    name: 'tickets',
    send: vi.fn().mockResolvedValue({ id: 'new-msg-1' }),
    messages: {
      fetch: vi.fn().mockResolvedValue({
        edit: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
}

function makeGuild(channels: Record<string, any> = {}) {
  return {
    id: 'g1',
    channels: { cache: new Map(Object.entries(channels)) },
  };
}

function makePanel(overrides: any = {}) {
  return {
    id: 'panel1',
    name: 'Support',
    channel_id: 'ch1',
    message_id: null,
    input_mode: 'buttons',
    panel_message: {
      title: 'Support Tickets',
      description: 'Click below to open a ticket',
      footer: 'Powered by SomniBot',
      thumbnail: 'https://example.com/thumb.png',
    },
    ticket_types: [
      { id: 'general', label: 'General', color: 'blue', emoji: '📩', description: 'General help' },
      { id: 'billing', label: 'Billing', color: 'green', emoji: null, description: 'Billing' },
      { id: 'report', label: 'Report', color: 'red', emoji: '🚨', description: 'Report' },
    ],
    ...overrides,
  };
}

describe('postPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('posts a new panel message with buttons', async () => {
    const channel = makeChannel();
    const guild = makeGuild({ ch1: channel });
    const panel = makePanel();
    const supabase = { from: vi.fn().mockReturnValue(chainBuilder()) };

    const result = await postPanel(guild as any, panel as any, supabase as any);
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('new-msg-1');
    expect(channel.send).toHaveBeenCalled();
  });

  it('edits existing panel message', async () => {
    const channel = makeChannel();
    const guild = makeGuild({ ch1: channel });
    const panel = makePanel({ message_id: 'old-msg-1' });
    const supabase = { from: vi.fn().mockReturnValue(chainBuilder()) };

    const result = await postPanel(guild as any, panel as any, supabase as any);
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('old-msg-1');
    expect(channel.messages.fetch).toHaveBeenCalledWith('old-msg-1');
  });

  it('posts new message when existing message was deleted', async () => {
    const channel = makeChannel();
    channel.messages.fetch.mockRejectedValue(new Error('not found'));
    const guild = makeGuild({ ch1: channel });
    const panel = makePanel({ message_id: 'deleted-msg' });
    const supabase = { from: vi.fn().mockReturnValue(chainBuilder()) };

    const result = await postPanel(guild as any, panel as any, supabase as any);
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('new-msg-1');
  });

  it('uses dropdown mode', async () => {
    const channel = makeChannel();
    const guild = makeGuild({ ch1: channel });
    const panel = makePanel({ input_mode: 'dropdown' });
    const supabase = { from: vi.fn().mockReturnValue(chainBuilder()) };

    const result = await postPanel(guild as any, panel as any, supabase as any);
    expect(result.success).toBe(true);
  });

  it('returns error when channel not found', async () => {
    const guild = makeGuild();
    const panel = makePanel({ channel_id: 'missing' });
    const supabase = { from: vi.fn().mockReturnValue(chainBuilder()) };

    const result = await postPanel(guild as any, panel as any, supabase as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('handles send failure', async () => {
    const channel = makeChannel();
    channel.send.mockRejectedValue(new Error('permission denied'));
    const guild = makeGuild({ ch1: channel });
    const panel = makePanel();
    const supabase = { from: vi.fn().mockReturnValue(chainBuilder()) };

    const result = await postPanel(guild as any, panel as any, supabase as any);
    expect(result.success).toBe(false);
  });

  it('handles more than 5 ticket types (multiple button rows)', async () => {
    const types = Array.from({ length: 7 }, (_, i) => ({
      id: `type${i}`,
      label: `Type ${i}`,
      color: 'grey',
      emoji: null,
      description: `Type ${i}`,
    }));
    const channel = makeChannel();
    const guild = makeGuild({ ch1: channel });
    const panel = makePanel({ ticket_types: types });
    const supabase = { from: vi.fn().mockReturnValue(chainBuilder()) };

    const result = await postPanel(guild as any, panel as any, supabase as any);
    expect(result.success).toBe(true);
  });

  it('handles panel without footer/thumbnail', async () => {
    const channel = makeChannel();
    const guild = makeGuild({ ch1: channel });
    const panel = makePanel({
      panel_message: { title: null, description: null, footer: null, thumbnail: null },
    });
    const supabase = { from: vi.fn().mockReturnValue(chainBuilder()) };

    const result = await postPanel(guild as any, panel as any, supabase as any);
    expect(result.success).toBe(true);
  });
});

describe('deletePanelMessage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('deletes the panel message', async () => {
    const channel = makeChannel();
    const guild = makeGuild({ ch1: channel });
    const panel = makePanel({ message_id: 'msg1' });

    await deletePanelMessage(guild as any, panel as any);
    expect(channel.messages.fetch).toHaveBeenCalledWith('msg1');
  });

  it('is a no-op when no message_id', async () => {
    const channel = makeChannel();
    const guild = makeGuild({ ch1: channel });
    const panel = makePanel({ message_id: null });

    await deletePanelMessage(guild as any, panel as any);
    expect(channel.messages.fetch).not.toHaveBeenCalled();
  });

  it('handles channel not found', async () => {
    const guild = makeGuild();
    const panel = makePanel({ message_id: 'msg1', channel_id: 'missing' });

    await deletePanelMessage(guild as any, panel as any);
    // Should not throw
  });

  it('handles message already deleted', async () => {
    const channel = makeChannel();
    channel.messages.fetch.mockRejectedValue(new Error('not found'));
    const guild = makeGuild({ ch1: channel });
    const panel = makePanel({ message_id: 'deleted' });

    await deletePanelMessage(guild as any, panel as any);
    // Should not throw
  });
});
