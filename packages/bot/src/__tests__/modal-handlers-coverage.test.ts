/**
 * modal-handlers — coverage tests
 *
 * Tests handleModalSubmit with REAL imports for all modal types.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  ChannelType: { GuildText: 0 },
  EmbedBuilder: vi.fn().mockImplementation(function () {
    return {
      setColor: vi.fn().mockReturnThis(),
      setTitle: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      addFields: vi.fn().mockReturnThis(),
      setTimestamp: vi.fn().mockReturnThis(),
    };
  }),
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock the infraction service
const mockCreateInfraction = vi.fn().mockResolvedValue({ infraction: { id: 'inf-1' }, replayed: false });
const mockGetActiveWarningCount = vi.fn().mockResolvedValue(3);
const mockCalculateExpiryDate = vi.fn().mockReturnValue('2026-07-01');

vi.mock('../features/moderation/infraction-service.js', () => ({
  createInfraction: (...args: any[]) => mockCreateInfraction(...args),
  getActiveWarningCount: (...args: any[]) => mockGetActiveWarningCount(...args),
  calculateExpiryDate: (...args: any[]) => mockCalculateExpiryDate(...args),
}));

const mockGetEscalationAction = vi.fn().mockReturnValue(null);
const mockExecuteEscalation = vi.fn().mockResolvedValue(undefined);

vi.mock('../features/moderation/escalation.js', () => ({
  getEscalationAction: (...args: any[]) => mockGetEscalationAction(...args),
  executeEscalation: (...args: any[]) => mockExecuteEscalation(...args),
}));

import { handleModalSubmit } from '../features/discord-ux/modal-handlers.js';

function chainBuilder(resolveValue: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle', 'insert', 'in']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeSupabase(responses: Record<string, any> = {}) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (responses[table]) return chainBuilder(responses[table]);
      return chainBuilder();
    }),
    rpc: vi.fn().mockResolvedValue({ data: 1, error: null }),
  };
}

function makeInteraction(customId: string, fields: Record<string, string> = {}) {
  return {
    customId,
    user: { id: 'mod1', tag: 'Mod#0001' },
    fields: {
      getTextInputValue: vi.fn().mockImplementation((key: string) => fields[key] ?? ''),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

function makeGuild(overrides: any = {}) {
  const textChannel = {
    type: 0, // GuildText
    isTextBased: vi.fn().mockReturnValue(true),
    send: vi.fn().mockResolvedValue(undefined),
    messages: { fetch: vi.fn().mockResolvedValue({ content: 'Bad message', url: 'https://discord.com/msg' }) },
  };

  const ticketChannel = {
    id: 'tc1',
    send: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    permissionOverwrites: {
      create: vi.fn().mockResolvedValue(undefined),
    },
    toString: () => '<#tc1>',
  };

  return {
    id: 'g1',
    name: 'Test Guild',
    channels: {
      cache: new Map([
        ['ch1', textChannel],
        ['mod-log', textChannel],
      ]),
      create: vi.fn().mockResolvedValue(ticketChannel),
    },
    members: {
      fetch: vi.fn().mockResolvedValue({
        displayName: 'TargetUser',
        permissions: { has: vi.fn().mockReturnValue(true) },
      }),
    },
    client: {
      users: {
        fetch: vi.fn().mockResolvedValue({
          send: vi.fn().mockResolvedValue(undefined),
        }),
      },
    },
    ...overrides,
  };
}

describe('handleModalSubmit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateInfraction.mockResolvedValue({ infraction: { id: 'inf-1' }, replayed: false });
    mockGetActiveWarningCount.mockResolvedValue(3);
    mockGetEscalationAction.mockReturnValue(null);
  });

  // ── warn_modal ──────────────────────────────────────
  describe('warn_modal', () => {
    it('issues a warning successfully', async () => {
      const interaction = makeInteraction('warn_modal:user1', { warn_reason: 'Spamming' });
      const guild = makeGuild();
      const supabase = makeSupabase({
        guild_config: { data: { infraction_expiry_days: 30, escalation_chain: [], mod_log_channel_id: 'mod-log' }, error: null },
      });
      const eventBus = { emit: vi.fn() };

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any);

      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('has been warned'),
      }));
      expect(eventBus.emit).toHaveBeenCalledWith('infraction.created', 'g1', expect.anything());
    });

    it('rejects user without ModerateMembers permission', async () => {
      const interaction = makeInteraction('warn_modal:user1', { warn_reason: 'Spamming' });
      const guild = makeGuild();
      guild.members.fetch.mockResolvedValue({
        displayName: 'NoPerms',
        permissions: { has: vi.fn().mockReturnValue(false) },
      });
      const supabase = makeSupabase();
      const eventBus = { emit: vi.fn() };

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any);

      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Moderate Members permission'),
      }));
    });

    it('handles failed infraction creation', async () => {
      mockCreateInfraction.mockResolvedValue(null);
      const interaction = makeInteraction('warn_modal:user1', { warn_reason: 'Spam' });
      const guild = makeGuild();
      const supabase = makeSupabase({
        guild_config: { data: { infraction_expiry_days: 30 }, error: null },
      });
      const eventBus = { emit: vi.fn() };

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any);

      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Failed to create warning'),
      }));
    });

    it('auto-escalates when escalation chain triggers', async () => {
      mockGetEscalationAction.mockReturnValue({ action: 'mute', duration: 3600 });
      const interaction = makeInteraction('warn_modal:user1', { warn_reason: 'Repeated offense' });
      const guild = makeGuild();
      const supabase = makeSupabase({
        guild_config: {
          data: {
            infraction_expiry_days: 30,
            escalation_chain: [{ threshold: 3, action: 'mute', duration: 3600 }],
            mod_log_channel_id: null,
          },
          error: null,
        },
      });
      const eventBus = { emit: vi.fn() };
      const client = {} as any;

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any, client);

      expect(mockExecuteEscalation).toHaveBeenCalled();
    });

    it('handles DM failure gracefully', async () => {
      const interaction = makeInteraction('warn_modal:user1', { warn_reason: 'Test' });
      const guild = makeGuild();
      guild.client.users.fetch.mockRejectedValue(new Error('DM disabled'));
      const supabase = makeSupabase({
        guild_config: { data: { infraction_expiry_days: 30 }, error: null },
      });
      const eventBus = { emit: vi.fn() };

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any);

      // Should still complete successfully
      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('has been warned'),
      }));
    });

    it('handles member fetch failure', async () => {
      const interaction = makeInteraction('warn_modal:user1', { warn_reason: 'Test' });
      const guild = makeGuild();
      guild.members.fetch.mockRejectedValue(new Error('not found'));
      const supabase = makeSupabase({
        guild_config: { data: { infraction_expiry_days: 30 }, error: null },
      });
      const eventBus = { emit: vi.fn() };

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any);

      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Moderate Members permission'),
      }));
    });
  });

  // ── ticket_from_msg ─────────────────────────────────
  describe('ticket_from_msg', () => {
    it('creates a ticket from a message', async () => {
      const interaction = makeInteraction('ticket_from_msg:msg1:ch1', {
        ticket_subject: 'Help needed',
        ticket_details: 'More details here',
      });
      const guild = makeGuild();
      const supabase = makeSupabase({
        ticket_panels: { data: { id: 'panel1', open_category_id: 'cat1', manager_roles: ['role1'] }, error: null },
        tickets: { data: { id: 'ticket1' }, error: null },
      });
      const eventBus = { emit: vi.fn() };

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any);

      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Ticket created'),
      }));
      expect(eventBus.emit).toHaveBeenCalledWith('ticket.opened', 'g1', expect.anything());
    });

    it('handles no ticket panel configured', async () => {
      const interaction = makeInteraction('ticket_from_msg:msg1:ch1', {
        ticket_subject: 'Help',
      });
      const guild = makeGuild();
      const supabase = makeSupabase({
        ticket_panels: { data: null, error: null },
      });
      const eventBus = { emit: vi.fn() };

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any);

      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('No ticket panel configured'),
      }));
    });

    it('handles ticket insert error', async () => {
      const interaction = makeInteraction('ticket_from_msg:msg1:ch1', {
        ticket_subject: 'Help',
      });
      const guild = makeGuild();
      const supabase = makeSupabase({
        ticket_panels: { data: { id: 'panel1', open_category_id: null, manager_roles: [] }, error: null },
        tickets: { data: null, error: { message: 'insert failed' } },
      });
      const eventBus = { emit: vi.fn() };

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any);

      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Failed to create ticket'),
      }));
    });

    it('uses fallback ticket number when RPC fails', async () => {
      const interaction = makeInteraction('ticket_from_msg:msg1:ch1', {
        ticket_subject: 'Help',
        ticket_details: '',
      });
      const guild = makeGuild();
      const supabase = makeSupabase({
        ticket_panels: { data: { id: 'panel1', open_category_id: 'cat1', manager_roles: [] }, error: null },
        tickets: { data: { id: 't1' }, error: null },
      });
      supabase.rpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } });
      const eventBus = { emit: vi.fn() };

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any);

      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Ticket created'),
      }));
    });
  });

  // ── report_msg ──────────────────────────────────────
  describe('report_msg', () => {
    it('submits a message report', async () => {
      const interaction = makeInteraction('report_msg:msg1:ch1:author1', {
        report_reason: 'Inappropriate content',
        report_category: 'harassment',
      });
      const guild = makeGuild();
      const supabase = makeSupabase({
        message_reports: { error: null },
        guild_config: { data: { mod_log_channel_id: 'mod-log' }, error: null },
      });
      const eventBus = { emit: vi.fn() };

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any);

      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Report submitted'),
      }));
    });

    it('handles report without mod log channel', async () => {
      const interaction = makeInteraction('report_msg:msg1:ch1:author1', {
        report_reason: 'Bad content',
        report_category: '',
      });
      const guild = makeGuild();
      const supabase = makeSupabase({
        message_reports: { error: null },
        guild_config: { data: null, error: null },
      });
      const eventBus = { emit: vi.fn() };

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any);

      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Report submitted'),
      }));
    });
  });

  // ── giveaway_create ─────────────────────────────────
  describe('giveaway_create', () => {
    it('handles giveaway create modal', async () => {
      const interaction = makeInteraction('giveaway_create', {});
      const guild = makeGuild();
      const supabase = makeSupabase();
      const eventBus = { emit: vi.fn() };

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any);

      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Giveaway creation'),
      }));
    });
  });

  // ── unknown action ──────────────────────────────────
  describe('unknown action', () => {
    it('replies with unknown modal action', async () => {
      const interaction = makeInteraction('unknown_action', {});
      const guild = makeGuild();
      const supabase = makeSupabase();
      const eventBus = { emit: vi.fn() };

      await handleModalSubmit(interaction as any, guild as any, supabase as any, eventBus as any);

      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Unknown modal action.',
        ephemeral: true,
      }));
    });
  });
});
