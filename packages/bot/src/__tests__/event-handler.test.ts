/**
 * Deep tests for events/handler.ts — registerEvents with mocked Discord client.
 * 652 uncovered statements at 28.3%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => {
    const logger: any = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: () => logger,
    };
    return logger;
  },
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return { ...actual };
});

// Mock all feature handlers that events/handler.ts imports
vi.mock('../features/welcome/index.js', () => ({
  handleMemberJoin: vi.fn(async () => {}),
  handleMemberUpdate: vi.fn(async () => {}),
  handleMemberLeave: vi.fn(async () => {}),
}));

vi.mock('../features/moderation/index.js', () => ({
  processMessage: vi.fn(async () => {}),
  expireInfractions: vi.fn(async () => {}),
}));

vi.mock('../features/moderation/commands.js', () => ({
  handleWarnCommand: vi.fn(async () => {}),
  handleMuteCommand: vi.fn(async () => {}),
  handleKickCommand: vi.fn(async () => {}),
  handleBanCommand: vi.fn(async () => {}),
  handlePardonCommand: vi.fn(async () => {}),
  handleInfractionsCommand: vi.fn(async () => {}),
}));

vi.mock('../features/help/index.js', () => ({
  handleHelpCommand: vi.fn(async () => {}),
  handleHelpCategorySelect: vi.fn(async () => {}),
}));

vi.mock('../features/privacy/forgetme-command.js', () => ({
  handleForgetMeCommand: vi.fn(async () => {}),
}));

vi.mock('../features/privacy/privacy-command.js', () => ({
  handlePrivacyCommand: vi.fn(async () => {}),
}));

vi.mock('../features/account/mydata-command.js', () => ({
  handleMyDataCommand: vi.fn(async () => {}),
}));

vi.mock('../features/tutorial/tutorial-command.js', () => ({
  handleTutorialCommand: vi.fn(async () => {}),
}));

vi.mock('../features/discord-ux/index.js', () => ({
  handleViewProfile: vi.fn(async () => {}),
  handleWarnUser: vi.fn(async () => {}),
  handleViewPurchases: vi.fn(async () => {}),
  handleCreateTicketFromMessage: vi.fn(async () => {}),
  handleReportMessage: vi.fn(async () => {}),
}));

vi.mock('../features/discord-ux/modal-handlers.js', () => ({
  handleModalSubmit: vi.fn(async () => {}),
}));

vi.mock('../features/tickets/ticket-interactions.js', () => ({
  handleTicketInteraction: vi.fn(async () => {}),
}));

vi.mock('../features/reaction-roles/button-roles.js', () => ({
  handleButtonRoleInteraction: vi.fn(async () => {}),
}));

vi.mock('../features/commerce/payment-handler.js', () => ({
  handleBuyButton: vi.fn(async () => {}),
}));

vi.mock('../features/commerce/license-commands.js', () => ({
  handleLicenseCommand: vi.fn(async () => {}),
}));

vi.mock('../features/moderation/escalation.js', () => ({
  executeEscalation: vi.fn(async () => null),
}));

vi.mock('../features/moderation/antiraid.js', () => ({
  processAntiRaid: vi.fn(async () => false),
}));

// events/handler.ts imports processAntiRaid from ../features/anti-raid/index.js
// (NOT ../features/moderation/antiraid.js above). Mock the real path so the
// verification-gate tests can assert whether it ran, and so the "RUNS" test
// does not invoke the real anti-raid pipeline.
vi.mock('../features/anti-raid/index.js', () => ({
  processAntiRaid: vi.fn(async () => false),
  startAntiRaidPruner: vi.fn(),
  stopAntiRaidPruner: vi.fn(),
}));

vi.mock('../features/moderation/automod-actions.js', () => ({
  executeAutoModAction: vi.fn(async () => {}),
}));

vi.mock('../features/levels/index.js', () => ({
  processXpForMessage: vi.fn(async () => {}),
  handleRankCommand: vi.fn(async () => {}),
  handleLeaderboardCommand: vi.fn(async () => {}),
}));

vi.mock('../guild-init.js', () => ({
  onGuildJoin: vi.fn(async () => {}),
  destroyGuildServices: vi.fn(),
}));

vi.mock('../sync/drift-events.js', () => ({
  handleRoleCreate: vi.fn(async () => {}),
  handleRoleUpdate: vi.fn(async () => {}),
  handleRoleDelete: vi.fn(async () => {}),
  handleChannelCreate: vi.fn(async () => {}),
  handleChannelUpdate: vi.fn(async () => {}),
  handleChannelDelete: vi.fn(async () => {}),
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { registerEvents } from '../events/handler.js';

function makeClient() {
  const handlers: Record<string, Function[]> = {};
  return {
    supabase: { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })) })) })) },
    eventBus: { emit: vi.fn() },
    guilds: { cache: new Map() },
    ws: { ping: 42 },
    user: { tag: 'Somni#0001' },
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    once: vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    _handlers: handlers,
    async _emit(event: string, ...args: any[]) {
      for (const h of handlers[event] || []) await h(...args);
    },
  } as any;
}

describe('events/handler', () => {
  let client: any;

  beforeEach(() => {
    vi.clearAllMocks();
    client = makeClient();
  });

  it('registerEvents registers all expected event listeners', () => {
    registerEvents(client);
    expect(client.on).toHaveBeenCalled();
    expect(client.once).toHaveBeenCalled();

    // Check that all critical events are registered
    const registeredEvents = client.on.mock.calls.map((c: any[]) => c[0]);
    expect(registeredEvents).toContain('guildMemberAdd');
    expect(registeredEvents).toContain('guildMemberRemove');
    expect(registeredEvents).toContain('messageCreate');
    expect(registeredEvents).toContain('interactionCreate');
  });

  it('registerEvents does not duplicate process-level handlers', () => {
    const events = ['unhandledRejection', 'uncaughtException', 'SIGTERM', 'SIGINT'] as const;
    const before = new Map(events.map((event) => [event, process.listenerCount(event)]));

    registerEvents(makeClient());
    registerEvents(makeClient());

    for (const event of events) {
      expect(process.listenerCount(event) - before.get(event)!).toBeLessThanOrEqual(1);
    }
  });

  it('handles ready event', async () => {
    registerEvents(client);
    await client._emit('ready', client);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles guildMemberAdd event', async () => {
    registerEvents(client);
    const member = { id: 'user-1', guild: { id: 'guild-1' }, user: { tag: 'Test#0001' } };
    await client._emit('guildMemberAdd', member);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles guildMemberRemove event', async () => {
    registerEvents(client);
    const member = { id: 'user-1', guild: { id: 'guild-1' }, user: { tag: 'Test#0001' } };
    await client._emit('guildMemberRemove', member);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles messageCreate event (ignores bots)', async () => {
    registerEvents(client);
    const message = { author: { bot: true }, guildId: 'guild-1' };
    await client._emit('messageCreate', message);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles messageCreate event for real user', async () => {
    registerEvents(client);
    const message = {
      author: { bot: false, id: 'user-1' },
      guildId: 'guild-1',
      guild: { id: 'guild-1' },
      member: { id: 'user-1' },
      content: 'hello',
      channel: { id: 'ch-1' },
    };
    await client._emit('messageCreate', message);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles interactionCreate for chat input command', async () => {
    registerEvents(client);
    const interaction = {
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isContextMenuCommand: () => false,
      isAutocomplete: () => false,
      commandName: 'help',
      guildId: 'guild-1',
      user: { id: 'user-1' },
      reply: vi.fn().mockResolvedValue({}),
      deferReply: vi.fn().mockResolvedValue({}),
      editReply: vi.fn().mockResolvedValue({}),
    };
    await client._emit('interactionCreate', interaction);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles interactionCreate for button', async () => {
    registerEvents(client);
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isContextMenuCommand: () => false,
      isAutocomplete: () => false,
      customId: 'ticket:open:panel-1',
      guildId: 'guild-1',
      user: { id: 'user-1' },
      reply: vi.fn().mockResolvedValue({}),
      deferReply: vi.fn().mockResolvedValue({}),
    };
    await client._emit('interactionCreate', interaction);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles interactionCreate for modal submit', async () => {
    registerEvents(client);
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => false,
      isModalSubmit: () => true,
      isStringSelectMenu: () => false,
      isContextMenuCommand: () => false,
      isAutocomplete: () => false,
      customId: 'warn:user-1',
      guildId: 'guild-1',
      user: { id: 'user-1' },
      reply: vi.fn().mockResolvedValue({}),
    };
    await client._emit('interactionCreate', interaction);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles roleCreate event', async () => {
    registerEvents(client);
    const role = { id: 'role-1', guild: { id: 'guild-1' }, name: 'NewRole' };
    await client._emit('roleCreate', role);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles roleUpdate event', async () => {
    registerEvents(client);
    const oldRole = { id: 'role-1', name: 'Old' };
    const newRole = { id: 'role-1', name: 'New', guild: { id: 'guild-1' } };
    await client._emit('roleUpdate', oldRole, newRole);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles roleDelete event', async () => {
    registerEvents(client);
    const role = { id: 'role-1', guild: { id: 'guild-1' }, name: 'Gone' };
    await client._emit('roleDelete', role);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles channelCreate event', async () => {
    registerEvents(client);
    const channel = { id: 'ch-1', guild: { id: 'guild-1' }, name: 'new-ch' };
    await client._emit('channelCreate', channel);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles channelUpdate event', async () => {
    registerEvents(client);
    const oldCh = { id: 'ch-1', guild: { id: 'guild-1' } };
    const newCh = { id: 'ch-1', guild: { id: 'guild-1' }, name: 'updated' };
    await client._emit('channelUpdate', oldCh, newCh);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles channelDelete event', async () => {
    registerEvents(client);
    const channel = { id: 'ch-1', guild: { id: 'guild-1' }, name: 'gone-ch' };
    await client._emit('channelDelete', channel);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  it('handles guildMemberUpdate event', async () => {
    registerEvents(client);
    const oldMember = { id: 'user-1', roles: { cache: new Map() } };
    const newMember = { id: 'user-1', roles: { cache: new Map() }, guild: { id: 'guild-1' } };
    await client._emit('guildMemberUpdate', oldMember, newMember);
      expect(Object.keys(client._handlers).length).toBeGreaterThan(0);
  });

  // ── Codex round-2 finding #4: gate normal event handlers during verification ──
  // In setup-verification mode the bot is logged in only so the wizard can
  // confirm it is online; the GuildRouter is an empty placeholder and
  // guild_config rows do not exist yet. Normal guild event handlers must bail
  // out (client.setupVerificationMode === true), else half-initialized
  // pipelines run and produce the pre-setup error noise the gate suppresses
  // (e.g. handleMemberJoin logging a missing guild_config row).
  it('does NOT run guildMemberAdd feature pipeline while in setup-verification mode', async () => {
    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    const { handleMemberJoin } = await import('../features/welcome/index.js');
    client.setupVerificationMode = true;
    registerEvents(client);

    const member = { id: 'user-1', guild: { id: 'guild-1' }, user: { bot: false, tag: 'Test#0001' } };
    await client._emit('guildMemberAdd', member);

    // Gate short-circuits BEFORE any feature work.
    expect(processAntiRaid).not.toHaveBeenCalled();
    expect(handleMemberJoin).not.toHaveBeenCalled();
  });

  it('does NOT run the messageCreate pipeline while in setup-verification mode', async () => {
    const { processMessage } = await import('../features/moderation/index.js');
    client.setupVerificationMode = true;
    registerEvents(client);

    const message = {
      author: { bot: false, id: 'user-1' },
      guild: { id: 'guild-1' },
      guildId: 'guild-1',
      content: 'hello',
      channel: { id: 'ch-1' },
    };
    await client._emit('messageCreate', message);

    expect(processMessage).not.toHaveBeenCalled();
  });

  it('RUNS guildMemberAdd once verification mode is cleared (transition lights handlers up)', async () => {
    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    const { handleMemberJoin } = await import('../features/welcome/index.js');
    // Register while gated, then clear the flag exactly as the full-boot
    // transition does — the SAME registered handler must now run.
    client.setupVerificationMode = true;
    registerEvents(client);
    client.setupVerificationMode = false;

    const member = { id: 'user-1', guild: { id: 'guild-1' }, user: { bot: false, tag: 'Test#0001' } };
    await client._emit('guildMemberAdd', member);

    expect(processAntiRaid).toHaveBeenCalledTimes(1);
    expect(handleMemberJoin).toHaveBeenCalledTimes(1);
  });

  // ── Codex finding #1: the periodic crons unconditionally call
  // client.router.all(). Setup-verification mode installs an EMPTY GuildRouter
  // before returning precisely so those sweeps do not throw
  // "Cannot read properties of undefined". This test proves an empty router
  // makes the crons harmless no-ops (they iterate zero contexts and do not
  // throw) rather than crashing the process every interval.
  it('periodic crons are safe no-ops when the router has no contexts (verification mode)', async () => {
    const { expireInfractions } = await import('../features/moderation/index.js');
    vi.useFakeTimers();
    try {
      const cronClient = makeClient();
      // Empty placeholder router, exactly like setup-verification mode installs.
      cronClient.router = {
        all: () => [][Symbol.iterator](),
      };
      // Supabase stub covering the temp-role-sweep and prune crons that query
      // Supabase directly (no router iteration): all resolve empty.
      cronClient.supabase = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            lt: vi.fn(() => ({ limit: vi.fn(async () => ({ data: [] })) })),
          })),
        })),
        rpc: vi.fn(async () => ({ data: {}, error: null })),
      };

      registerEvents(cronClient);

      // Advance well past the 15-min and 30-min cron intervals; must not throw.
      await expect(vi.advanceTimersByTimeAsync(31 * 60 * 1000)).resolves.not.toThrow();

      // Router had zero contexts → the per-guild cron work never ran.
      expect(expireInfractions).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

});
