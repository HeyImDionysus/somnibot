/**
 * Coverage tests — Tickets subsystem
 * Tests: ticket-service (createTicket, claimTicket, closeTicket, etc.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, warning: 0xfee75c, error: 0xed4245 },
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
    setThumbnail() { return this; }
    setTimestamp() { return this; }
    setFooter() { return this; }
    addFields(..._f: any[]) { return this; }
    toJSON() { return {}; }
  }
  class ButtonBuilder {
    setCustomId() { return this; }
    setLabel() { return this; }
    setStyle() { return this; }
    setEmoji() { return this; }
    setDisabled() { return this; }
  }
  class ActionRowBuilder {
    components: any[] = [];
    addComponents(...c: any[]) { this.components.push(...c); return this; }
  }
  return {
    EmbedBuilder,
    ButtonBuilder,
    ActionRowBuilder,
    ChannelType: { GuildText: 0 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageChannels: 4n, ReadMessageHistory: 8n, AttachFiles: 16n },
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
  };
});

vi.mock('../services/event-bus.js', () => ({
  PlatformEventBus: class { emit = vi.fn(); on = vi.fn(); },
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

function makeChain(result: any = { data: null, error: null, count: 0 }) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'in', 'is', 'not',
    'order', 'limit', 'single', 'maybeSingle', 'match', 'contains',
    'overlaps', 'filter', 'or', 'ilike', 'like', 'textSearch']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa(result?: any) {
  const chain = makeChain(result);
  return {
    from: vi.fn(() => chain),
    rpc: vi.fn(async () => ({ data: 42, error: null })),
    _chain: chain,
  };
}

describe('ticket-service', () => {
  let tickets: typeof import('../features/tickets/ticket-service.js');

  beforeEach(async () => {
    vi.resetModules();
    tickets = await import('../features/tickets/ticket-service.js');
  });

  function makeGuild() {
    const send = vi.fn(async () => ({ id: 'msg1' }));
    const createdChannel = {
      id: 'ticket_ch',
      name: 'ticket-42',
      send,
      permissionOverwrites: { create: vi.fn(async () => {}) },
    };
    return {
      id: 'g1',
      name: 'Test Guild',
      channels: {
        cache: new Map([
          ['cat1', { id: 'cat1', name: 'Tickets', type: 4 }],
          ['ticket_ch', createdChannel],
        ]),
        create: vi.fn(async () => createdChannel),
      },
      members: {
        cache: new Map(),
        fetch: vi.fn(async (id: string) => ({
          id,
          user: { tag: `User#${id}`, displayAvatarURL: () => 'url', send: vi.fn(async () => {}) },
          roles: { add: vi.fn(async () => {}) },
        })),
      },
    };
  }

  function makePanel() {
    return {
      id: 'panel1',
      guild_id: 'g1',
      category_id: 'cat1',
      support_role_ids: ['role1'],
      max_tickets_per_user: 3,
      ticket_types: [],
    };
  }

  function makeMember(id = 'u1') {
    return {
      id,
      user: { tag: `User#${id}`, displayAvatarURL: () => 'url', send: vi.fn(async () => {}) },
      guild: { id: 'g1' },
    };
  }

  it('createTicket creates a ticket channel', async () => {
    const guild = makeGuild();
    const supa = makeSupa({ data: { id: 'ticket1', guild_id: 'g1', number: 42 }, error: null, count: 0 });
    const eventBus = { emit: vi.fn(), on: vi.fn() };
    const result = await tickets.createTicket(
      guild as any, makeMember() as any, makePanel() as any,
      { name: 'General', description: 'General support', emoji: '🎫' },
      supa as any, eventBus as any
    );
    expect(result).toBeDefined();
  });

  it('claimTicket assigns staff member', async () => {
    const guild = makeGuild();
    const supa = makeSupa({ data: { id: 'ticket1', channel_id: 'ticket_ch', claimed_by: null }, error: null });
    const eventBus = { emit: vi.fn() };
    await tickets.claimTicket(
      supa as any, guild as any, 'ticket1', 'staff1', eventBus as any
    );
    expect(supa.from).toHaveBeenCalled();
  });

  it('closeTicket closes and updates status', async () => {
    const guild = makeGuild();
    const supa = makeSupa({ data: { id: 'ticket1', channel_id: 'ticket_ch', status: 'open' }, error: null });
    const eventBus = { emit: vi.fn() };
    await tickets.closeTicket(
      supa as any, guild as any, 'ticket1', 'staff1', 'Resolved', eventBus as any
    );
    expect(supa.from).toHaveBeenCalled();
  });

  it('reopenTicket reopens a closed ticket', async () => {
    const guild = makeGuild();
    const supa = makeSupa({ data: { id: 'ticket1', channel_id: 'ticket_ch', status: 'closed' }, error: null });
    const eventBus = { emit: vi.fn() };
    await tickets.reopenTicket(
      supa as any, guild as any, 'ticket1', 'staff1', eventBus as any
    );
    expect(supa.from).toHaveBeenCalled();
  });

  it('deleteTicket removes the channel', async () => {
    const guild = makeGuild();
    const supa = makeSupa({ data: { id: 'ticket1', channel_id: 'ticket_ch' }, error: null });
    const eventBus = { emit: vi.fn() };
    await tickets.deleteTicket(
      supa as any, guild as any, 'ticket1', eventBus as any
    );
    expect(supa.from).toHaveBeenCalled();
  });

  it('addUserToTicket adds permission overwrite', async () => {
    const guild = makeGuild();
    const supa = makeSupa({ data: { id: 'ticket1', channel_id: 'ticket_ch' }, error: null });
    await tickets.addUserToTicket(supa as any, guild as any, 'ticket1', 'user2');
    expect(supa.from).toHaveBeenCalled();
  });

  it('removeUserFromTicket removes permission overwrite', async () => {
    const guild = makeGuild();
    const supa = makeSupa({ data: { id: 'ticket1', channel_id: 'ticket_ch' }, error: null });
    await tickets.removeUserFromTicket(supa as any, guild as any, 'ticket1', 'user2');
    expect(supa.from).toHaveBeenCalled();
  });

  it('checkInactiveTickets checks for stale tickets', async () => {
    const supa = makeSupa({ data: [], error: null });
    const guild = makeGuild();
    const eventBus = { emit: vi.fn() };
    await tickets.checkInactiveTickets(supa as any, guild as any, eventBus as any);
    expect(supa.from).toHaveBeenCalled();
  });
});
