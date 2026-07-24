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
  PermissionFlagsBits: { ManageGuild: 32n, ManageChannels: 4n, ManageMessages: 8192n },
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
import {
  memberCanManageTicket,
  canMemberManageTicket,
  emitTicketDenied,
  ticketDeniedMessage,
} from '../features/tickets/ticket-authz.js';

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

// ── Lifecycle authorization (finding: tickets-authz) ───────────────────────
//
// Claim/reopen/delete buttons and /ticket close|add|remove must re-check
// manager-role membership at the handler layer; a non-manager non-creator who
// can merely SEE the ticket channel must be denied (branded ephemeral reply +
// a ticket.denied event that yields one denied-attempt audit row).

const TICKET_ROW = {
  id: 't1',
  guild_id: 'guild-1',
  panel_id: 'panel-1',
  channel_id: 'ch-ticket-1',
  ticket_number: 42,
  creator_id: 'creator-1',
  type: 'support',
  status: 'open',
  claimed_by: null,
};

const PANEL_ROW = {
  id: 'panel-1',
  manager_roles: ['manager-role-1'],
  ticket_types: [{ id: 'support', label: 'Support' }],
};

function makeGateClient() {
  const client = makeClient({ tickets: TICKET_ROW, ticket_panels: PANEL_ROW });
  client.eventBus = { emit: vi.fn() };
  return client;
}

function makeGateButton(customId: string, userId: string, member: any) {
  return {
    customId,
    guildId: 'guild-1',
    channelId: 'ch-ticket-1',
    user: { id: userId, username: userId, tag: `${userId}#0001`, displayAvatarURL: () => 'url' },
    member,
    guild: { id: 'guild-1', name: 'Test', members: { fetch: vi.fn() }, channels: { cache: { get: () => undefined } } },
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    message: { edit: vi.fn() },
    channel: { send: vi.fn().mockResolvedValue({}) },
  } as any;
}

describe('ticket lifecycle authorization', () => {
  it('(a) denies a claim by an unprivileged non-creator, leaves the ticket unclaimed, and emits one ticket.denied', async () => {
    const client = makeGateClient();
    const attacker = { id: 'attacker-1', roles: [], permissions: { has: () => false } };
    const interaction = makeGateButton('ticket:claim:42', 'attacker-1', attacker);

    const handled = await handleTicketInteraction(interaction, client);
    expect(handled).toBe(true);

    // Branded ephemeral denial.
    expect(interaction.reply).toHaveBeenCalled();
    const replyArg = interaction.reply.mock.calls.at(-1)![0];
    expect(replyArg.ephemeral).toBe(true);
    expect(String(replyArg.content)).toMatch(/denied|manager/i);

    // Exactly one denied-attempt event → one audit row.
    expect(client.eventBus.emit).toHaveBeenCalledTimes(1);
    expect(client.eventBus.emit).toHaveBeenCalledWith('ticket.denied', 'guild-1', {
      ticketId: 't1',
      ticketNumber: 42,
      actorDiscordId: 'attacker-1',
      reason: 'permission-denied',
    });
    // The ticket was never claimed.
    expect(client.eventBus.emit).not.toHaveBeenCalledWith(
      'ticket.claimed',
      expect.anything(),
      expect.anything(),
    );
  });

  it('(c) allows a manager-role holder to claim (no denial)', async () => {
    const client = makeGateClient();
    const manager = { id: 'manager-1', roles: ['manager-role-1'], permissions: { has: () => false } };
    const interaction = makeGateButton('ticket:claim:42', 'manager-1', manager);

    const handled = await handleTicketInteraction(interaction, client);
    expect(handled).toBe(true);

    // No denial was emitted and no ephemeral "denied" reply was sent.
    expect(client.eventBus.emit).not.toHaveBeenCalledWith(
      'ticket.denied',
      expect.anything(),
      expect.anything(),
    );
    expect(interaction.reply).toHaveBeenCalled();
    const replyArg = interaction.reply.mock.calls.at(-1)![0];
    expect(String(replyArg?.content ?? '')).not.toMatch(/denied/i);
  });

  it('(admin) allows a member with Manage Server permission to claim', async () => {
    const client = makeGateClient();
    const admin = { id: 'admin-1', roles: [], permissions: { has: () => true } };
    const interaction = makeGateButton('ticket:claim:42', 'admin-1', admin);

    await handleTicketInteraction(interaction, client);

    expect(client.eventBus.emit).not.toHaveBeenCalledWith(
      'ticket.denied',
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('ticket authorizer (unit)', () => {
  const supabaseWithPanel = () =>
    ({ from: () => makeChain({ data: PANEL_ROW, error: null }) }) as any;

  it('(b) lets the creator close their own ticket without a manager role', async () => {
    const creator = { id: 'creator-1', roles: [], permissions: { has: () => false } };
    const allowed = await canMemberManageTicket(
      supabaseWithPanel(),
      creator,
      TICKET_ROW,
      'close',
      'creator-1',
    );
    expect(allowed).toBe(true);
  });

  it('does NOT let the creator claim/reopen/delete/add/remove (only close)', async () => {
    const creator = { id: 'creator-1', roles: [], permissions: { has: () => false } };
    for (const action of ['claim', 'reopen', 'delete', 'add', 'remove'] as const) {
      const allowed = await canMemberManageTicket(
        supabaseWithPanel(),
        creator,
        TICKET_ROW,
        action,
        'creator-1',
      );
      expect(allowed).toBe(false);
    }
  });

  it('grants a manager-role holder every lifecycle action', async () => {
    const manager = { id: 'manager-1', roles: ['manager-role-1'], permissions: { has: () => false } };
    for (const action of ['claim', 'close', 'reopen', 'delete', 'add', 'remove'] as const) {
      const allowed = await canMemberManageTicket(
        supabaseWithPanel(),
        manager,
        TICKET_ROW,
        action,
        'manager-1',
      );
      expect(allowed).toBe(true);
    }
  });

  it('memberCanManageTicket honors admin permission, role match, and per-type override', () => {
    // Manage Server / Manage Channels permission wins outright.
    expect(memberCanManageTicket({ permissions: { has: () => true }, roles: [] }, [])).toBe(true);
    // Role membership via a discord.js-style roles.cache Collection.
    const withCache = { permissions: { has: () => false }, roles: { cache: { has: (id: string) => id === 'r1' } } };
    expect(memberCanManageTicket(withCache, ['r1'])).toBe(true);
    expect(memberCanManageTicket(withCache, ['r2'])).toBe(false);
    // Per-type override takes precedence over the panel manager_roles.
    const holder = { permissions: { has: () => false }, roles: ['override-role'] };
    expect(
      memberCanManageTicket(holder, ['panel-role'], {
        id: 'support',
        label: 'Support',
        emoji: '🎫',
        color: 'blue',
        managerRoleOverride: ['override-role'],
      } as any),
    ).toBe(true);
    // A member holding only the panel role is NOT authorized when an override is set.
    const panelOnly = { permissions: { has: () => false }, roles: ['panel-role'] };
    expect(
      memberCanManageTicket(panelOnly, ['panel-role'], {
        id: 'support',
        label: 'Support',
        emoji: '🎫',
        color: 'blue',
        managerRoleOverride: ['override-role'],
      } as any),
    ).toBe(false);
  });

  it('emitTicketDenied emits exactly one ticket.denied event with the audit payload', () => {
    const emit = vi.fn();
    emitTicketDenied({ emit } as any, 'guild-1', { id: 't1', ticket_number: 42 }, 'attacker-1');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('ticket.denied', 'guild-1', {
      ticketId: 't1',
      ticketNumber: 42,
      actorDiscordId: 'attacker-1',
      reason: 'permission-denied',
    });
  });

  it('ticketDeniedMessage is branded and matches the denial contract regex', () => {
    for (const action of ['claim', 'close', 'reopen', 'delete', 'add', 'remove'] as const) {
      expect(ticketDeniedMessage(action)).toMatch(/denied|manager/i);
    }
  });
});
