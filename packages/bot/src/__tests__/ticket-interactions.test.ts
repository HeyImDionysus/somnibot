/**
 * Tests for features/tickets/ticket-interactions.ts — handles Discord button/dropdown
 * interactions from ticket panels (open, close, claim, transcript, reopen, delete).
 * 315 uncovered statements at 19.8% coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: any = {};
    setColor() { return this; } setTitle() { return this; }
    setDescription() { return this; } addFields() { return this; }
    setFooter() { return this; } setTimestamp() { return this; }
    setAuthor() { return this; } setThumbnail() { return this; }
  },
  PermissionFlagsBits: { ManageChannels: 4n, ManageMessages: 8192n },
  ModalBuilder: class { setCustomId() { return this; } setTitle() { return this; } addComponents() { return this; } },
  TextInputBuilder: class { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } setRequired() { return this; } setPlaceholder() { return this; } setMinLength() { return this; } setMaxLength() { return this; } },
  TextInputStyle: { Short: 1, Paragraph: 2 },
  ActionRowBuilder: class { addComponents() { return this; } },
  ChannelType: { GuildText: 0 },
}));

vi.mock('./ticket-service.js', () => ({
  createTicket: vi.fn(async () => ({ success: true, channelId: 'ch-ticket-1', ticketNumber: 1 })),
  claimTicket: vi.fn(async () => ({ success: true })),
  closeTicket: vi.fn(async () => ({ success: true })),
  reopenTicket: vi.fn(async () => ({ success: true })),
  deleteTicket: vi.fn(async () => ({ success: true })),
}));
vi.mock('./transcript-generator.js', () => ({
  generateTranscript: vi.fn(async () => ({ success: true, url: 'https://example.com/transcript' })),
}));

import { handleTicketInteraction } from '../features/tickets/ticket-interactions.js';

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: Function) => resolve(result);
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  return chain;
}

function makeClient(tableOverrides: Record<string, any> = {}) {
  return {
    supabase: {
      from: vi.fn((table: string) => {
        const data = tableOverrides[table] ?? null;
        return makeChain({ data, error: null });
      }),
    },
    guilds: { cache: new Map() },
  } as any;
}

function makeButtonInteraction(customId: string) {
  return {
    customId,
    guildId: 'guild-1',
    channelId: 'ch-1',
    user: { id: 'user-1', username: 'Tester', tag: 'Tester#0001', displayAvatarURL: () => 'url' },
    member: { id: 'user-1', permissions: { has: () => true } },
    guild: {
      id: 'guild-1', name: 'Test',
      members: {
        fetch: vi.fn().mockResolvedValue({
          id: 'user-1', permissions: { has: () => true },
        }),
      },
    },
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
    deferUpdate: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    showModal: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    message: { edit: vi.fn() },
    channel: { send: vi.fn().mockResolvedValue({}) },
  } as any;
}

function makeSelectInteraction(customId: string, values: string[]) {
  return {
    ...makeButtonInteraction(customId),
    isButton: () => false,
    isStringSelectMenu: () => true,
    values,
  } as any;
}

describe('ticket-interactions', () => {
  describe('handleTicketInteraction', () => {
    it('returns false for non-ticket interactions', async () => {
      const interaction = {
        customId: 'some_other_thing',
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
      } as any;
      const result = await handleTicketInteraction(interaction, makeClient());
      expect(result).toBe(false);
    });

    it('handles panel:open button — opens ticket creation', async () => {
      const client = makeClient({
        ticket_panels: { id: 'panel-1', guild_id: 'guild-1', types: [{ id: 'type-1', name: 'Support', intake_form: null }] },
      });
      const interaction = makeButtonInteraction('panel:open:panel-1:type-1');
      const result = await handleTicketInteraction(interaction, client);
      expect(result).toBe(true);
    });

    it('handles ticket:close button', async () => {
      const client = makeClient();
      const interaction = makeButtonInteraction('ticket:close:42');
      const result = await handleTicketInteraction(interaction, client);
      expect(result).toBe(true);
    });

    it('handles ticket:claim button', async () => {
      const client = makeClient();
      const interaction = makeButtonInteraction('ticket:claim:42');
      const result = await handleTicketInteraction(interaction, client);
      expect(result).toBe(true);
    });

    it('handles ticket:transcript button', async () => {
      const client = makeClient();
      const interaction = makeButtonInteraction('ticket:transcript:42');
      const result = await handleTicketInteraction(interaction, client);
      expect(result).toBe(true);
    });

    it('handles ticket:reopen button', async () => {
      const client = makeClient();
      const interaction = makeButtonInteraction('ticket:reopen:42');
      const result = await handleTicketInteraction(interaction, client);
      expect(result).toBe(true);
    });

    it('handles ticket:delete button', async () => {
      const client = makeClient();
      const interaction = makeButtonInteraction('ticket:delete:42');
      const result = await handleTicketInteraction(interaction, client);
      expect(result).toBe(true);
    });

    it('handles panel:open dropdown selection', async () => {
      const client = makeClient({
        ticket_panels: { id: 'panel-1', types: [{ id: 'type-1', name: 'Support' }] },
      });
      const interaction = makeSelectInteraction('panel:open:panel-1', ['type-1']);
      const result = await handleTicketInteraction(interaction, client);
      expect(result).toBe(true);
    });

    it('ignores non-matching button IDs', async () => {
      const interaction = makeButtonInteraction('unrelated:button');
      const result = await handleTicketInteraction(interaction, makeClient());
      expect(result).toBe(false);
    });
  });
});
