/**
 * Tests for features/discord-ux/modal-handlers.ts — handles Discord modal
 * submissions for ticket creation, report filing, warn reasons, etc.
 * 237 uncovered statements.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, danger: 0xed4245, success: 0x57f287 },
}));

vi.mock('discord.js', () => {
  class C extends Map {
    filter(fn: any) { const r = new C(); for (const [k, v] of this) if (fn(v, k)) r.set(k, v); return r; }
  }
  return {
    EmbedBuilder: class {
      data: any = {};
      setColor() { return this; } setTitle() { return this; }
      setDescription() { return this; } addFields(...f: any[]) { this.data.fields = f; return this; }
      setTimestamp() { return this; } setFooter() { return this; } setAuthor() { return this; }
    },
    ChannelType: { GuildText: 0 },
    Collection: C,
    PermissionFlagsBits: { ManageMessages: 8192n },
    ButtonBuilder: class { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } },
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonStyle: { Primary: 1, Danger: 4 },
  };
});

vi.mock('../features/moderation/index.js', () => ({
  processInfraction: vi.fn(async () => true),
}));
vi.mock('../features/tickets/index.js', () => ({
  createTicketFromReport: vi.fn(async () => ({ success: true, channelId: 'ch-ticket' })),
}));
vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { handleModalSubmit } from '../features/discord-ux/modal-handlers.js';

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'limit', 'order']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa() {
  return {
    from: vi.fn(() => makeChain({ data: null, error: null })),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

function makeGuild() {
  return {
    id: 'guild-1', name: 'Test',
    members: {
      me: { id: 'bot-1', permissions: { has: () => true } },
      fetch: vi.fn().mockResolvedValue({
        id: 'target-1', displayName: 'Target',
        user: { tag: 'Target#0001', displayAvatarURL: () => 'url' },
        roles: { highest: { position: 5 } },
        kick: vi.fn(), ban: vi.fn(), timeout: vi.fn(),
      }),
      cache: new Map(),
    },
    channels: {
      cache: new Map([['ch-1', {
        id: 'ch-1', name: 'mod-log', type: 0,
        send: vi.fn().mockResolvedValue({}),
      }]]),
    },
  } as any;
}

function makeModalInteraction(customId: string, fields: Record<string, string>) {
  return {
    customId,
    guildId: 'guild-1',
    channelId: 'ch-1',
    user: { id: 'user-1', username: 'mod', tag: 'mod#0001', displayAvatarURL: () => 'url' },
    member: { id: 'user-1', permissions: { has: () => true }, roles: { highest: { position: 50 } } },
    guild: makeGuild(),
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    fields: {
      getTextInputValue: vi.fn((id: string) => fields[id] ?? ''),
    },
    isModalSubmit: () => true,
  } as any;
}

describe('modal-handlers', () => {
  describe('handleModalSubmit', () => {
    it('handles warn modal (warn_reason_TARGET_ID)', async () => {
      const interaction = makeModalInteraction('warn_reason_target-1', {
        warn_reason: 'Spamming in chat',
      });
      const client = { supabase: makeSupa() } as any;
      await handleModalSubmit(interaction, client);
    });

    it('handles report modal (report_message_MSG_ID)', async () => {
      const interaction = makeModalInteraction('report_message_msg-1', {
        report_reason: 'Contains slurs',
        report_details: 'Multiple offensive words',
      });
      const client = { supabase: makeSupa() } as any;
      await handleModalSubmit(interaction, client);
    });

    it('handles ticket create modal (create_ticket_from_MSG_ID)', async () => {
      const interaction = makeModalInteraction('create_ticket_from_msg-1', {
        ticket_subject: 'Need help',
        ticket_description: 'I have a question',
      });
      const client = { supabase: makeSupa() } as any;
      await handleModalSubmit(interaction, client);
    });

    it('handles unknown modal ID gracefully', async () => {
      const interaction = makeModalInteraction('unknown_modal_xyz', {});
      const client = { supabase: makeSupa() } as any;
      await handleModalSubmit(interaction, client);
    });
  });
});
