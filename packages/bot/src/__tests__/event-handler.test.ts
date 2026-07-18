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

import { registerEvents, sweepExpiredTempRoleGrants } from '../events/handler.js';

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

function makeTempRoleSweepClient(rows: Array<Record<string, unknown>>, guild: any) {
  let tempRead = 0;
  const deleteEq = vi.fn();
  const guildGet = vi.fn(() => guild);
  const from = vi.fn((table: string) => {
    let deleting = false;
    let targetId = '';
    const chain: any = {};
    for (const method of ['select', 'lt', 'order', 'gt', 'neq', 'in', 'contains', 'is', 'or']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.eq = vi.fn((column: string, value: unknown) => {
      if (deleting) {
        deleteEq(column, value);
        if (column === 'id') targetId = String(value);
      }
      return chain;
    });
    chain.delete = vi.fn(() => {
      deleting = true;
      return chain;
    });
    chain.limit = vi.fn(async () => {
      if (table === 'temp_role_grants') {
        tempRead++;
        return { data: tempRead === 1 ? rows : [], error: null };
      }
      if (table === 'entitlements') return { data: [], error: null };
      return { data: [], error: null };
    });
    chain.maybeSingle = vi.fn(async () => (
      deleting
        ? { data: { id: targetId }, error: null }
        : { data: null, error: null }
    ));
    chain.then = (resolve: Function) => resolve({ data: null, error: null });
    return chain;
  });

  return {
    client: {
      supabase: {
        from,
        rpc: vi.fn(async (name: string) => ({
          data: name === 'commerce_classify_live_role_owner' ? 'none' : null,
          error: null,
        })),
      },
      guilds: { cache: { get: guildGet } },
    } as any,
    deleteEq,
    guildGet,
  };
}

function makeCommerceTempRoleSweepClient(opts: {
  removeOnExpiry: boolean;
  grantId?: string;
  orderId?: string;
  expiresAt?: string;
  source?: string;
  grantStatus?: 'pending' | 'applied';
  classificationResponses?: Array<{
    data: unknown;
    error: { message: string } | null;
  }>;
  memberRoleStates?: Array<boolean | Error>;
  removalError?: Error;
  addError?: Error;
  parentOrderStatus?: string;
  entitlementIsLive?: boolean;
  inspectionError?: { message: string };
  retirementResults?: Array<{ data: unknown; error: unknown }>;
  provenanceReadbacks?: Array<{ data: unknown; error: unknown }>;
  casDeleteResults?: Array<{ data: unknown; error: unknown }>;
  sharedCommerceRetirement?: { retired: boolean };
  sharedNonCommerceRow?: { present: boolean };
}) {
  const grant = {
    id: opts.grantId ?? 'grant-current',
    guild_id: 'guild-1',
    user_id: 'user-1',
    role_id: 'role-1',
    expires_at: opts.expiresAt ?? '2000-01-01T00:00:00.000Z',
    updated_at: '2000-01-01T00:00:00.000Z',
    source: opts.source ?? 'commerce_purchase',
    order_id: opts.orderId ?? 'order-1',
    grant_status: opts.grantStatus ?? 'applied',
    remove_on_expiry: opts.removeOnExpiry,
  };
  let tempRead = 0;
  let classificationRead = 0;
  let memberFetch = 0;
  const deleteEq = vi.fn();
  const acknowledgedDeletes: string[] = [];
  const ownershipOr = vi.fn();
  const successorIntentUpdates: Array<Record<string, unknown>> = [];
  const roleRemove = vi.fn(async () => {
    if (opts.removalError) throw opts.removalError;
  });
  const roleAdd = vi.fn(async () => {
    if (opts.addError) throw opts.addError;
  });
  const fetch = vi.fn(async () => {
    const state = opts.memberRoleStates?.[memberFetch++] ?? false;
    if (state instanceof Error) throw state;
    return {
      roles: {
        cache: { has: () => state },
        add: roleAdd,
        remove: roleRemove,
      },
    };
  });
  const guild = { members: { fetch } };

  const from = vi.fn((table: string) => {
    let deleting = false;
    let targetId = '';
    const chain: any = {};
    const orFilters: string[] = [];
    for (const method of ['select', 'lt', 'neq', 'contains', 'order']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.or = vi.fn((...args: unknown[]) => {
      const expression = String(args[0] ?? '');
      orFilters.push(expression);
      ownershipOr(...args);
      return chain;
    });
    chain.delete = vi.fn(() => {
      deleting = true;
      return chain;
    });
    chain.eq = vi.fn((column: string, value: unknown) => {
      if (column === 'id') targetId = String(value);
      if (deleting) deleteEq(column, value);
      return chain;
    });
    chain.is = vi.fn(() => chain);
    chain.in = vi.fn(() => chain);
    chain.gt = vi.fn(() => chain);
    chain.limit = vi.fn(async () => {
      if (table === 'temp_role_grants') {
        tempRead++;
        if (tempRead === 1) {
          const excludesPreparedCommerce = orFilters.includes(
            'grant_status.eq.applied,order_id.is.null',
          );
          if (
            excludesPreparedCommerce
            && grant.grant_status === 'pending'
            && grant.order_id !== null
          ) {
            return { data: [], error: null };
          }
          return { data: [grant], error: null };
        }
        return { data: [], error: null };
      }
      return { data: [], error: null };
    });
    chain.maybeSingle = vi.fn(async () => {
      if (deleting) {
        const scriptedDelete = opts.casDeleteResults?.shift();
        if (scriptedDelete) return scriptedDelete;
        if (opts.sharedNonCommerceRow) {
          if (!opts.sharedNonCommerceRow.present) {
            return { data: null, error: null };
          }
          opts.sharedNonCommerceRow.present = false;
        }
        acknowledgedDeletes.push(targetId);
        return { data: { id: targetId }, error: null };
      }
      const scriptedReadback = opts.provenanceReadbacks?.shift();
      if (scriptedReadback) return scriptedReadback;
      if (opts.sharedNonCommerceRow?.present) return { data: grant, error: null };
      return { data: null, error: null };
    });
    chain.then = (resolve: Function) => resolve(
      deleting ? { data: null, error: null } : { data: [], error: null },
    );
    return chain;
  });

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'commerce_classify_live_role_owner') {
      ownershipOr(name, args);
      const scripted = opts.classificationResponses?.[classificationRead++];
      if (scripted) return scripted;
      return { data: 'none', error: null };
    }
    if (name === 'commerce_inspect_temp_role_grant') {
      if (opts.inspectionError) return { data: null, error: opts.inspectionError };
      return {
        data: {
          ...grant,
          duration_seconds: 60,
          applied_at: grant.grant_status === 'applied'
            ? new Date(Date.parse(grant.expires_at) - 60_000).toISOString()
            : null,
          parent_order_status: opts.parentOrderStatus ?? 'completed',
          entitlement_is_live: opts.entitlementIsLive ?? true,
        },
        error: null,
      };
    }
    if (name === 'commerce_retire_temp_role_grant') {
      const grantId = String(args.p_grant_id ?? '');
      deleteEq('id', grantId);
      const scriptedRetirement = opts.retirementResults?.shift();
      if (scriptedRetirement) return scriptedRetirement;
      if (opts.sharedCommerceRetirement?.retired) {
        return {
          data: {
            id: grantId,
            retired: true,
            grant_status: 'removed',
            source: 'commerce_reconciled',
            disposition: 'already_retired',
          },
          error: null,
        };
      }
      if (opts.sharedCommerceRetirement) opts.sharedCommerceRetirement.retired = true;
      const tombstone = { grant_status: 'removed', source: 'commerce_reconciled' };
      successorIntentUpdates.push(tombstone);
      acknowledgedDeletes.push(grantId);
      return {
        data: {
          id: grantId,
          retired: true,
          grant_status: 'removed',
          source: 'commerce_reconciled',
        },
        error: null,
      };
    }
    return { data: null, error: null };
  });

  return {
    client: {
      supabase: { from, rpc },
      guilds: { cache: { get: vi.fn(() => guild) } },
    } as any,
    deleteEq,
    fetch,
    roleRemove,
    roleAdd,
    ownershipOr,
    successorIntentUpdates,
    acknowledgedDeletes,
    rpc,
  };
}

function makePaginatedTempRoleSweepClient() {
  const preservedRows = Array.from({ length: 200 }, (_, index) => ({
    id: `grant-${String(index).padStart(3, '0')}`,
    guild_id: 'guild-1',
    user_id: 'user-1',
    role_id: `role-${index}`,
    expires_at: '2000-01-01T00:00:00.000Z',
    updated_at: '2000-01-01T00:00:00.000Z',
    source: 'commerce_purchase',
    order_id: null,
    grant_status: 'applied',
    remove_on_expiry: false,
  }));
  const laterSafeRow = {
    id: 'grant-200',
    guild_id: 'guild-1',
    user_id: 'user-1',
    role_id: 'role-200',
    expires_at: '2000-01-01T00:00:00.000Z',
    updated_at: '2000-01-01T00:00:00.000Z',
    source: 'commerce_purchase',
    order_id: 'order-200',
    grant_status: 'applied',
    remove_on_expiry: false,
  };
  const queryCursors: Array<string | null> = [];
  const deletedIds: string[] = [];
  const guildGet = vi.fn();

  const from = vi.fn(() => {
    let deleting = false;
    let updatePayload: Record<string, unknown> | null = null;
    let cursor: string | null = null;
    let targetId = '';
    const chain: any = {};
    for (const method of ['select', 'lt', 'order', 'is', 'or', 'in']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.gt = vi.fn((column: string, value: unknown) => {
      if (column === 'id') cursor = String(value);
      return chain;
    });
    chain.delete = vi.fn(() => {
      deleting = true;
      return chain;
    });
    chain.update = vi.fn((payload: Record<string, unknown>) => {
      updatePayload = payload;
      return chain;
    });
    chain.eq = vi.fn((column: string, value: unknown) => {
      if ((deleting || updatePayload !== null) && column === 'id') targetId = String(value);
      return chain;
    });
    chain.limit = vi.fn(async () => {
      queryCursors.push(cursor);
      return {
        data: cursor === null ? preservedRows : [laterSafeRow],
        error: null,
      };
    });
    chain.maybeSingle = vi.fn(async () => {
      deletedIds.push(targetId);
      return {
        data: updatePayload?.grant_status === 'removed'
          ? { id: targetId, grant_status: 'removed' }
          : { id: targetId },
        error: null,
      };
    });
    chain.then = (resolve: Function) => resolve({ data: null, error: null });
    return chain;
  });

  return {
    client: {
      supabase: {
        from,
        rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
          if (name === 'commerce_classify_live_role_owner') {
            return { data: 'none', error: null };
          }
          if (name === 'commerce_inspect_temp_role_grant') {
            return {
              data: {
                ...laterSafeRow,
                duration_seconds: 60,
                applied_at: '1999-12-31T23:59:00.000Z',
                parent_order_status: 'completed',
                entitlement_is_live: true,
              },
              error: null,
            };
          }
          if (name === 'commerce_retire_temp_role_grant') {
            const grantId = String(args.p_grant_id ?? '');
            deletedIds.push(grantId);
            return {
              data: {
                id: grantId,
                retired: true,
                grant_status: 'removed',
                source: 'commerce_reconciled',
              },
              error: null,
            };
          }
          return { data: null, error: null };
        }),
      },
      guilds: { cache: { get: guildGet } },
    } as any,
    queryCursors,
    deletedIds,
    guildGet,
  };
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
             lt: vi.fn(() => ({
               or: vi.fn(() => ({
                 order: vi.fn(() => ({ limit: vi.fn(async () => ({ data: [] })) })),
               })),
             })),
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

  describe('temporary role provenance safety', () => {
    const grant = (source: string) => ({
      id: 'grant-1',
      guild_id: 'guild-1',
      user_id: 'user-1',
      role_id: 'role-1',
      expires_at: '2000-01-01T00:00:00.000Z',
      updated_at: '2000-01-01T00:00:00.000Z',
      source,
      order_id: null,
      grant_status: 'applied',
      remove_on_expiry: false,
    });

    it.each(['commerce_purchase', 'purchase', 'economy_purchase'])(
      'does not remove or delete commerce provenance labeled %s',
      async (source) => {
        const { client: sweepClient, deleteEq, guildGet } = makeTempRoleSweepClient([grant(source)], null);

        await sweepExpiredTempRoleGrants(sweepClient);

        expect(guildGet).not.toHaveBeenCalled();
        expect(deleteEq).not.toHaveBeenCalled();
      },
    );

    it('uses an ordered ID cursor so 200 preserved legacy rows cannot starve later grants', async () => {
      const harness = makePaginatedTempRoleSweepClient();

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.queryCursors).toEqual([null, 'grant-199']);
      expect(harness.deletedIds).toEqual(['grant-200']);
      expect(harness.guildGet).not.toHaveBeenCalled();
    });

    it('fails the scan when the database returns null without an error', async () => {
      const limit = vi.fn().mockResolvedValue({ data: null, error: null });
      const order = vi.fn(() => ({ limit }));
      const or = vi.fn(() => ({ order }));
      const inFilter = vi.fn(() => ({ or }));
      const select = vi.fn(() => ({ in: inFilter }));
      const guildGet = vi.fn();
      const sweepClient = {
        supabase: { from: vi.fn(() => ({ select })) },
        guilds: { cache: { get: guildGet } },
      } as any;

      await sweepExpiredTempRoleGrants(sweepClient);

      expect(limit).toHaveBeenCalledWith(200);
      expect(guildGet).not.toHaveBeenCalled();
    });

    it('rejects a page with non-increasing IDs before mutating any row', async () => {
      const malformedRows = [
        {
          id: 'grant-duplicate',
          guild_id: 'guild-1',
          user_id: 'user-1',
          role_id: 'role-1',
          expires_at: '2000-01-01T00:00:00.000Z',
          updated_at: '2000-01-01T00:00:00.000Z',
          source: 'commerce_purchase',
          order_id: 'order-1',
          grant_status: 'applied',
          remove_on_expiry: false,
        },
        {
          id: 'grant-duplicate',
          guild_id: 'guild-1',
          user_id: 'user-1',
          role_id: 'role-2',
          expires_at: '2000-01-01T00:00:00.000Z',
          updated_at: '2000-01-01T00:00:00.000Z',
          source: 'commerce_purchase',
          order_id: 'order-2',
          grant_status: 'applied',
          remove_on_expiry: false,
        },
      ];
      const { client: sweepClient, deleteEq, guildGet } = makeTempRoleSweepClient(
        malformedRows,
        null,
      );

      await sweepExpiredTempRoleGrants(sweepClient);

      expect(deleteEq).not.toHaveBeenCalled();
      expect(guildGet).not.toHaveBeenCalled();
    });

    it('does not sweep a delayed order-backed pending grant before its duration starts', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: false,
        grantStatus: 'pending',
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('preserves an expired pending grant with removal intent because Discord ownership is ambiguous', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        grantStatus: 'pending',
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('tombstones a terminal pending preexisting-role grant without touching Discord', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: false,
        grantStatus: 'pending',
        parentOrderStatus: 'refunded',
        entitlementIsLive: false,
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.successorIntentUpdates).toContainEqual(expect.objectContaining({
        grant_status: 'removed',
        source: 'commerce_reconciled',
      }));
    });

    it('promptly removes and tombstones a terminal applied owned role', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        grantStatus: 'applied',
        expiresAt: '2999-01-01T00:00:00.000Z',
        parentOrderStatus: 'refunded',
        entitlementIsLive: false,
        memberRoleStates: [true, false],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.successorIntentUpdates).toContainEqual(expect.objectContaining({
        grant_status: 'removed',
        source: 'commerce_reconciled',
      }));
    });

    it('force-repairs a confirmed owner before retiring terminal provenance', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        parentOrderStatus: 'refunded',
        entitlementIsLive: false,
        classificationResponses: Array.from({ length: 4 }, () => ({
          data: 'confirmed',
          error: null,
        })),
        memberRoleStates: [false, true],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.roleAdd).toHaveBeenCalledWith(
        'role-1',
        expect.stringContaining('confirmed commerce owner'),
      );
      expect(harness.successorIntentUpdates).toContainEqual(expect.objectContaining({
        grant_status: 'removed',
      }));
    });

    it('compensates a committed repair add whose acknowledgement is lost when ownership becomes stale', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        parentOrderStatus: 'refunded',
        entitlementIsLive: false,
        classificationResponses: [
          { data: 'confirmed', error: null },
          { data: 'confirmed', error: null },
          { data: 'confirmed', error: null },
          { data: 'none', error: null },
          { data: 'none', error: null },
        ],
        memberRoleStates: [false, true, false, false],
        addError: new Error('Discord response was lost after committed add'),
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleAdd).toHaveBeenCalledTimes(1);
      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.roleRemove).toHaveBeenCalledWith(
        'role-1',
        'SomniBot — compensate stale confirmed-owner repair',
      );
    });

    it('accepts a committed repair add whose acknowledgement is lost while ownership stays confirmed', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        parentOrderStatus: 'refunded',
        entitlementIsLive: false,
        classificationResponses: Array.from({ length: 4 }, () => ({
          data: 'confirmed',
          error: null,
        })),
        memberRoleStates: [false, true],
        addError: new Error('Discord response was lost after committed add'),
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleAdd).toHaveBeenCalledTimes(1);
      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.successorIntentUpdates).toContainEqual(expect.objectContaining({
        grant_status: 'removed',
      }));
    });

    it('deletes an order-backed preexisting-role grant without touching Discord', async () => {
      const harness = makeCommerceTempRoleSweepClient({ removeOnExpiry: false });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
    });

    it('retains a confirmed same-identity owner while excluding only the current grant', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        classificationResponses: Array.from({ length: 3 }, () => ({
          data: 'confirmed',
          error: null,
        })),
        memberRoleStates: [true],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
      expect(harness.ownershipOr).toHaveBeenCalledWith(
        'commerce_classify_live_role_owner',
        {
          p_guild_id: 'guild-1',
          p_discord_id: 'user-1',
          p_role_id: 'role-1',
          p_exclude_intent_id: null,
          p_exclude_entitlement_id: null,
          p_exclude_grant_ids: ['grant-current'],
        },
      );
    });

    it('defers an exact provisional reservation with zero Discord or retirement mutation', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        classificationResponses: [{ data: 'pending', error: null }],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.roleAdd).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
      expect(harness.ownershipOr).toHaveBeenCalledWith(
        'commerce_classify_live_role_owner',
        expect.objectContaining({ p_exclude_grant_ids: ['grant-current'] }),
      );
    });

    it('defers without inventing access when a reservation appears after removal', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        classificationResponses: [
          { data: 'none', error: null },
          { data: 'pending', error: null },
        ],
        memberRoleStates: [true, false],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledWith(
        'role-1',
        'SomniBot — temporary role expired',
      );
      expect(harness.roleAdd).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('does not invent access when a reservation appears after an already-absent role', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        classificationResponses: [
          { data: 'none', error: null },
          { data: 'pending', error: null },
        ],
        memberRoleStates: [false],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.roleAdd).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('preserves provenance when initial ownership classification fails', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        classificationResponses: [
          { data: null, error: { message: 'database unavailable' } },
        ],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('keeps the role when authoritative state confirms another owner', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        classificationResponses: Array.from({ length: 3 }, () => ({
          data: 'confirmed',
          error: null,
        })),
        memberRoleStates: [true],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.fetch).toHaveBeenCalledTimes(1);
      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
    });

    it('does not let an expiring non-commerce grant strip a confirmed owner', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        source: 'level_reward',
        removeOnExpiry: true,
        classificationResponses: Array.from({ length: 3 }, () => ({
          data: 'confirmed',
          error: null,
        })),
        memberRoleStates: [true],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.fetch).toHaveBeenCalledTimes(1);
      expect(harness.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
    });

    it('does not let an expiring non-commerce grant strip a confirmed temp owner', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        source: 'level_reward',
        removeOnExpiry: true,
        classificationResponses: Array.from({ length: 3 }, () => ({
          data: 'confirmed',
          error: null,
        })),
        memberRoleStates: [true],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.fetch).toHaveBeenCalledTimes(1);
      expect(harness.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
    });

    it('removes an owned role, confirms absence with Discord, then deletes provenance', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        memberRoleStates: [true, false],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.fetch).toHaveBeenCalledTimes(2);
      expect(harness.roleRemove).toHaveBeenCalledWith(
        'role-1',
        'SomniBot — temporary role expired',
      );
      expect(harness.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
    });

    it('repairs the role when a concurrent temporary owner appears after removal', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        classificationResponses: [
          { data: 'none', error: null },
          { data: 'confirmed', error: null },
          { data: 'confirmed', error: null },
          { data: 'confirmed', error: null },
          { data: 'confirmed', error: null },
        ],
        memberRoleStates: [true, false, false, true],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.roleAdd).toHaveBeenCalledWith(
        'role-1',
        expect.stringContaining('confirmed commerce owner'),
      );
      expect(harness.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
    });

    it('preserves provenance without adding access when post-removal classification fails', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        classificationResponses: [
          { data: 'none', error: null },
          { data: null, error: { message: 'database unavailable' } },
        ],
        memberRoleStates: [true, false],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.roleAdd).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('restores access when the exact grant reactivates at the atomic retirement boundary', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        parentOrderStatus: 'refunded',
        entitlementIsLive: false,
        classificationResponses: [
          { data: 'none', error: null },
          { data: 'none', error: null },
          { data: 'confirmed', error: null },
          { data: 'confirmed', error: null },
          { data: 'confirmed', error: null },
          { data: 'confirmed', error: null },
        ],
        retirementResults: [{
          data: {
            id: 'grant-current',
            retired: false,
            grant_status: 'applied',
            source: 'commerce_purchase',
          },
          error: null,
        }],
        memberRoleStates: [true, false, false, true],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.roleAdd).toHaveBeenCalledTimes(1);
      expect(harness.acknowledgedDeletes).toEqual([]);
    });

    it('preserves provenance without restoring access when retirement remains unknown', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        parentOrderStatus: 'refunded',
        entitlementIsLive: false,
        classificationResponses: [
          { data: 'none', error: null },
          { data: 'none', error: null },
        ],
        retirementResults: [
          { data: null, error: { message: 'database unavailable' } },
          { data: null, error: { message: 'database unavailable' } },
        ],
        provenanceReadbacks: [
          { data: null, error: { message: 'readback unavailable' } },
          { data: null, error: { message: 'readback unavailable' } },
        ],
        memberRoleStates: [true, false],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.roleAdd).not.toHaveBeenCalled();
      expect(harness.acknowledgedDeletes).toEqual([]);
    });

    it('treats a commerce retirement commit with a lost response as retired', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        parentOrderStatus: 'refunded',
        entitlementIsLive: false,
        classificationResponses: [
          { data: 'none', error: null },
          { data: 'none', error: null },
        ],
        retirementResults: [{ data: null, error: { message: 'response lost' } }],
        provenanceReadbacks: [{
          data: {
            id: 'grant-current',
            guild_id: 'guild-1',
            user_id: 'user-1',
            role_id: 'role-1',
            expires_at: '2000-01-01T00:00:00.000Z',
            updated_at: '2000-01-01T00:01:00.000Z',
            source: 'commerce_reconciled',
            order_id: 'order-1',
            grant_status: 'removed',
            remove_on_expiry: true,
          },
          error: null,
        }],
        memberRoleStates: [true, false],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.roleAdd).not.toHaveBeenCalled();
      expect(harness.rpc.mock.calls.filter(([name]) =>
        name === 'commerce_retire_temp_role_grant')).toHaveLength(1);
    });

    it('treats a non-commerce CAS delete commit with a lost response as retired', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        source: 'level_reward',
        removeOnExpiry: false,
        classificationResponses: [{ data: 'none', error: null }],
        casDeleteResults: [{ data: null, error: { message: 'response lost' } }],
        provenanceReadbacks: [{ data: null, error: null }],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleAdd).not.toHaveBeenCalled();
      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
    });

    it('preserves a non-commerce row that changed version at the CAS boundary', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        source: 'level_reward',
        removeOnExpiry: false,
        classificationResponses: [
          { data: 'none', error: null },
          { data: 'none', error: null },
        ],
        casDeleteResults: [{ data: null, error: null }],
        provenanceReadbacks: [{
          data: {
            id: 'grant-current',
            guild_id: 'guild-1',
            user_id: 'user-1',
            role_id: 'role-1',
            expires_at: '2000-01-01T00:00:00.000Z',
            updated_at: '2000-01-01T00:01:00.000Z',
            source: 'level_reward',
            order_id: 'order-1',
            grant_status: 'applied',
            remove_on_expiry: false,
          },
          error: null,
        }],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.deleteEq.mock.calls.filter(([field]) => field === 'id')).toHaveLength(1);
      expect(harness.acknowledgedDeletes).toEqual([]);
      expect(harness.roleAdd).not.toHaveBeenCalled();
    });

    it('retries but preserves an unchanged non-commerce row after a zero-row CAS', async () => {
      const unchanged = {
        id: 'grant-current',
        guild_id: 'guild-1',
        user_id: 'user-1',
        role_id: 'role-1',
        expires_at: '2000-01-01T00:00:00.000Z',
        updated_at: '2000-01-01T00:00:00.000Z',
        source: 'level_reward',
        order_id: 'order-1',
        grant_status: 'applied',
        remove_on_expiry: false,
      };
      const harness = makeCommerceTempRoleSweepClient({
        source: 'level_reward',
        removeOnExpiry: false,
        classificationResponses: [{ data: 'none', error: null }],
        casDeleteResults: [
          { data: null, error: null },
          { data: null, error: null },
        ],
        provenanceReadbacks: [
          { data: unchanged, error: null },
          { data: unchanged, error: null },
        ],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.deleteEq.mock.calls.filter(([field]) => field === 'id')).toHaveLength(2);
      expect(harness.acknowledgedDeletes).toEqual([]);
      expect(harness.roleAdd).not.toHaveBeenCalled();
    });

    it('converges two commerce sweepers on one retirement without restoring access', async () => {
      const sharedRetirement = { retired: false };
      const first = makeCommerceTempRoleSweepClient({
        removeOnExpiry: false,
        classificationResponses: [{ data: 'none', error: null }],
        sharedCommerceRetirement: sharedRetirement,
      });
      const second = makeCommerceTempRoleSweepClient({
        removeOnExpiry: false,
        classificationResponses: [{ data: 'none', error: null }],
        sharedCommerceRetirement: sharedRetirement,
      });

      await Promise.all([
        sweepExpiredTempRoleGrants(first.client),
        sweepExpiredTempRoleGrants(second.client),
      ]);

      expect(sharedRetirement.retired).toBe(true);
      expect(first.roleAdd).not.toHaveBeenCalled();
      expect(second.roleAdd).not.toHaveBeenCalled();
      expect(first.roleRemove).not.toHaveBeenCalled();
      expect(second.roleRemove).not.toHaveBeenCalled();
    });

    it('converges two non-commerce sweepers on one CAS delete without restoring access', async () => {
      const sharedRow = { present: true };
      const first = makeCommerceTempRoleSweepClient({
        source: 'level_reward',
        removeOnExpiry: false,
        classificationResponses: [{ data: 'none', error: null }],
        sharedNonCommerceRow: sharedRow,
      });
      const second = makeCommerceTempRoleSweepClient({
        source: 'level_reward',
        removeOnExpiry: false,
        classificationResponses: [{ data: 'none', error: null }],
        sharedNonCommerceRow: sharedRow,
      });

      await Promise.all([
        sweepExpiredTempRoleGrants(first.client),
        sweepExpiredTempRoleGrants(second.client),
      ]);

      expect(sharedRow.present).toBe(false);
      expect(first.roleAdd).not.toHaveBeenCalled();
      expect(second.roleAdd).not.toHaveBeenCalled();
      expect(first.roleRemove).not.toHaveBeenCalled();
      expect(second.roleRemove).not.toHaveBeenCalled();
      expect(
        first.acknowledgedDeletes.length + second.acknowledgedDeletes.length,
      ).toBe(1);
    });

    it('preserves order-backed provenance when the Discord lookup fails', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        memberRoleStates: [new Error('lookup unavailable')],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('preserves order-backed provenance when Discord role removal fails', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        memberRoleStates: [true],
        removalError: new Error('missing permissions'),
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('repairs a lost-ack removal only while another owner remains confirmed', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        classificationResponses: [
          { data: 'none', error: null },
          { data: 'confirmed', error: null },
          { data: 'confirmed', error: null },
          { data: 'confirmed', error: null },
          { data: 'confirmed', error: null },
        ],
        memberRoleStates: [true, false, true],
        removalError: new Error('Discord response was lost after commit'),
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.roleAdd).toHaveBeenCalledTimes(1);
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it.each([
      ['pending', { data: 'pending', error: null }],
      ['unknown', { data: null, error: { message: 'classifier unavailable' } }],
    ])('does not restore a lost-ack removal from %s ownership', async (_label, uncertainty) => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        classificationResponses: [
          { data: 'none', error: null },
          uncertainty,
        ],
        memberRoleStates: [true],
        removalError: new Error('Discord response was lost after commit'),
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.roleAdd).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('does not add access when post-removal confirmation fails without a confirmed owner', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        memberRoleStates: [true, new Error('confirmation unavailable')],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.roleAdd).not.toHaveBeenCalled();
      expect(harness.fetch).toHaveBeenCalledTimes(2);
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('rejects malformed ownership classifier evidence before mutation', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        classificationResponses: [{ data: false, error: null }],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('does not invent compensation access when classification fails after an absent role', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        classificationResponses: [
          { data: 'none', error: null },
          { data: null, error: { message: 'database unavailable' } },
        ],
        memberRoleStates: [false],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.fetch).toHaveBeenCalledTimes(1);
      expect(harness.roleAdd).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('preserves provenance when the fresh Discord member lookup fails', async () => {
      const fetch = vi.fn().mockRejectedValue(new Error('Discord unavailable'));
      const { client: sweepClient, deleteEq } = makeTempRoleSweepClient(
        [{ ...grant('level_reward'), remove_on_expiry: true }],
        { members: { fetch } },
      );

      await sweepExpiredTempRoleGrants(sweepClient);

      expect(fetch).toHaveBeenCalledWith({ user: 'user-1', force: true });
      expect(deleteEq).not.toHaveBeenCalled();
    });

    it('preserves provenance when Discord role removal fails', async () => {
      const remove = vi.fn().mockRejectedValue(new Error('Missing permissions'));
      const fetch = vi.fn().mockResolvedValue({
        roles: {
          cache: new Map([['role-1', {}]]),
          remove,
        },
      });
      const { client: sweepClient, deleteEq } = makeTempRoleSweepClient(
        [{ ...grant('level_reward'), remove_on_expiry: true }],
        { members: { fetch } },
      );

      await sweepExpiredTempRoleGrants(sweepClient);

      expect(remove).toHaveBeenCalledWith('role-1', 'SomniBot — temporary role expired');
      expect(deleteEq).not.toHaveBeenCalled();
    });

    it('deletes non-commerce provenance only after a fresh lookup confirms the role absent', async () => {
      const remove = vi.fn();
      const fetch = vi.fn().mockResolvedValue({
        roles: {
          cache: new Map(),
          remove,
        },
      });
      const { client: sweepClient, deleteEq } = makeTempRoleSweepClient(
        [{ ...grant('level_reward'), remove_on_expiry: true }],
        { members: { fetch } },
      );

      await sweepExpiredTempRoleGrants(sweepClient);

      expect(fetch).toHaveBeenCalledWith({ user: 'user-1', force: true });
      expect(remove).not.toHaveBeenCalled();
      expect(deleteEq).toHaveBeenCalledWith('id', 'grant-1');
    });
  });

});
