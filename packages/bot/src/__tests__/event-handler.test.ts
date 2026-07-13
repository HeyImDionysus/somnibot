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
        rpc: vi.fn(async () => ({ data: null, error: null })),
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
  overlappingGrants?: Array<{
    id: string;
    expires_at?: string;
    grant_status?: 'pending' | 'applied';
    remove_on_expiry?: boolean;
  }>;
  overlappingError?: { message: string };
  overlappingResponses?: Array<{
    data: Array<{
      id: string;
      expires_at?: string;
      grant_status?: 'pending' | 'applied';
      remove_on_expiry?: boolean;
    }>;
    error: { message: string } | null;
  }>;
  customers?: Array<{ id: string }>;
  customerError?: { message: string };
  entitlements?: Array<{ id: string }>;
  entitlementError?: { message: string };
  memberRoleStates?: Array<boolean | Error>;
  removalError?: Error;
  addError?: Error;
  transferError?: { message: string };
  beforeDeleteAck?: () => Promise<void>;
  sharedTempRoleRows?: Map<string, Record<string, unknown>>;
  parentOrderStatus?: string;
  entitlementIsLive?: boolean;
  inspectionError?: { message: string };
  retirementResults?: Array<{ data: unknown; error: unknown }>;
}) {
  const grant = {
    id: opts.grantId ?? 'grant-current',
    guild_id: 'guild-1',
    user_id: 'user-1',
    role_id: 'role-1',
    expires_at: opts.expiresAt ?? '2000-01-01T00:00:00.000Z',
    source: opts.source ?? 'commerce_purchase',
    order_id: opts.orderId ?? 'order-1',
    grant_status: opts.grantStatus ?? 'applied',
    remove_on_expiry: opts.removeOnExpiry,
  };
  let tempRead = 0;
  let ownerRead = 0;
  let lastObservedOwner: Record<string, unknown> | null = null;
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
  const normalizeOverlap = (rows: Array<{
    id: string;
    expires_at?: string;
    grant_status?: 'pending' | 'applied';
    remove_on_expiry?: boolean;
  }>) => rows.map((row) => ({
    guild_id: 'guild-1',
    user_id: 'user-1',
    role_id: 'role-1',
    expires_at: '2999-01-01T00:00:00.000Z',
    grant_status: 'applied',
    remove_on_expiry: false,
    order_id: 'order-other',
    ...row,
  }));

  const from = vi.fn((table: string) => {
    let deleting = false;
    let targetId = '';
    let updatePayload: Record<string, unknown> | null = null;
    const filters: Array<{
      operator: 'eq' | 'is' | 'in' | 'gt';
      column: string;
      value: unknown;
    }> = [];
    const matchesFilters = (row: Record<string, unknown>): boolean => filters.every((filter) => {
      const actual = row[filter.column];
      if (filter.operator === 'in') {
        return Array.isArray(filter.value) && filter.value.includes(actual);
      }
      if (filter.operator === 'gt') {
        return typeof actual === 'string'
          && typeof filter.value === 'string'
          && actual > filter.value;
      }
      return actual === filter.value;
    });
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
    chain.update = vi.fn((payload: Record<string, unknown>) => {
      updatePayload = payload;
      successorIntentUpdates.push(payload);
      return chain;
    });
    chain.eq = vi.fn((column: string, value: unknown) => {
      if (column === 'id') targetId = String(value);
      if (deleting || updatePayload?.grant_status === 'removed') deleteEq(column, value);
      filters.push({ operator: 'eq', column, value });
      return chain;
    });
    chain.is = vi.fn((column: string, value: unknown) => {
      filters.push({ operator: 'is', column, value });
      return chain;
    });
    chain.in = vi.fn((column: string, value: unknown) => {
      filters.push({ operator: 'in', column, value });
      return chain;
    });
    chain.gt = vi.fn((column: string, value: unknown) => {
      filters.push({ operator: 'gt', column, value });
      return chain;
    });
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
        const scripted = opts.overlappingResponses?.[tempRead - 2];
        if (scripted) return { ...scripted, data: normalizeOverlap(scripted.data) };
        return {
          data: normalizeOverlap(opts.overlappingGrants ?? []),
          error: opts.overlappingError ?? null,
        };
      }
      if (table === 'customers') {
        return { data: opts.customers ?? [], error: opts.customerError ?? null };
      }
      if (table === 'entitlements') {
        return { data: opts.entitlements ?? [], error: opts.entitlementError ?? null };
      }
      return { data: [], error: null };
    });
    chain.maybeSingle = vi.fn(async () => {
      if (deleting) {
        await opts.beforeDeleteAck?.();
        if (opts.sharedTempRoleRows) {
          const current = opts.sharedTempRoleRows.get(targetId);
          if (!current || !matchesFilters(current)) return { data: null, error: null };
          opts.sharedTempRoleRows.delete(targetId);
        }
        acknowledgedDeletes.push(targetId);
        return { data: { id: targetId }, error: null };
      }
      if (table === 'temp_role_grants' && updatePayload?.remove_on_expiry === true) {
        if (opts.sharedTempRoleRows) {
          const current = opts.sharedTempRoleRows.get(targetId);
          if (!current || !matchesFilters(current)) return { data: null, error: null };
          Object.assign(current, updatePayload);
        }
        return {
          data: opts.transferError ? null : { id: targetId, remove_on_expiry: true },
          error: opts.transferError ?? null,
        };
      }
      if (table === 'temp_role_grants' && updatePayload?.grant_status === 'removed') {
        await opts.beforeDeleteAck?.();
        if (opts.sharedTempRoleRows) {
          const current = opts.sharedTempRoleRows.get(targetId);
          if (!current || !matchesFilters(current)) return { data: null, error: null };
          Object.assign(current, updatePayload);
        }
        acknowledgedDeletes.push(targetId);
        return {
          data: { id: targetId, grant_status: 'removed' },
          error: null,
        };
      }
      if (table === 'customers') {
        const customers = opts.customers ?? [{ id: 'customer-1' }];
        return {
          data: customers[0] ?? null,
          error: opts.customerError ?? null,
        };
      }
      return { data: null, error: null };
    });
    chain.then = (resolve: Function) => resolve(
      deleting ? { data: null, error: null } : { data: [], error: null },
    );
    return chain;
  });

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
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
    if (name === 'commerce_find_live_temp_role_owner') {
      ownerRead++;
      ownershipOr('commerce_find_live_temp_role_owner');
      const scripted = opts.overlappingResponses?.[ownerRead - 1];
      if (scripted) {
        const rows = normalizeOverlap(scripted.data);
        if (rows[0]) lastObservedOwner = rows[0];
        return { data: rows[0] ?? null, error: scripted.error };
      }
      if (opts.sharedTempRoleRows) {
        const rows = normalizeOverlap(
          [...opts.sharedTempRoleRows.values()]
            .filter((row) =>
              row.id !== grant.id
              && (row.grant_status === 'pending' || row.grant_status === 'applied')
              && row.source === 'commerce_purchase')
            .map((row) => row as any),
        );
        return { data: rows[0] ?? null, error: opts.overlappingError ?? null };
      }
      const rows = normalizeOverlap(opts.overlappingGrants ?? []);
      if (rows[0]) lastObservedOwner = rows[0];
      return {
        data: rows[0] ?? lastObservedOwner,
        error: opts.overlappingError ?? null,
      };
    }
    if (name === 'commerce_retire_temp_role_grant') {
      const grantId = String(args.p_grant_id ?? '');
      await opts.beforeDeleteAck?.();
      deleteEq('id', grantId);
      const scriptedRetirement = opts.retirementResults?.shift();
      if (scriptedRetirement) return scriptedRetirement;
      const tombstone = { grant_status: 'removed', source: 'commerce_reconciled' };
      successorIntentUpdates.push(tombstone);
      if (opts.sharedTempRoleRows) {
        const current = opts.sharedTempRoleRows.get(grantId);
        if (
          !current
          || current.grant_status !== args.p_expected_grant_status
          || current.expires_at !== args.p_expected_expires_at
          || current.remove_on_expiry !== args.p_expected_remove_on_expiry
        ) {
          return { data: null, error: { message: 'stale grant' } };
        }
        Object.assign(current, tombstone);
      }
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
  };
}

function makePaginatedTempRoleSweepClient() {
  const preservedRows = Array.from({ length: 200 }, (_, index) => ({
    id: `grant-${String(index).padStart(3, '0')}`,
    guild_id: 'guild-1',
    user_id: 'user-1',
    role_id: `role-${index}`,
    expires_at: '2000-01-01T00:00:00.000Z',
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

    it.each([
      { grantStatus: 'pending' as const, expiresAt: '2999-01-01T00:00:00.000Z' },
      { grantStatus: 'applied' as const, expiresAt: '2999-01-01T00:00:00.000Z' },
    ])('promptly removes and tombstones a terminal $grantStatus owned role', async ({ grantStatus, expiresAt }) => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        grantStatus,
        expiresAt,
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

    it('keeps a terminal order role owned by another exact live grant', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        parentOrderStatus: 'refunded',
        entitlementIsLive: false,
        overlappingGrants: [{ id: 'grant-successor', remove_on_expiry: true }],
      });

      await sweepExpiredTempRoleGrants(harness.client);

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

    it('keeps the role for every unexpired overlapping grant, including prepared pending rows', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        overlappingGrants: [{ id: 'grant-future' }],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
      expect(harness.ownershipOr).toHaveBeenCalled();
      expect(harness.successorIntentUpdates).toContainEqual(expect.objectContaining({
        remove_on_expiry: true,
      }));
    });

    it('treats a delayed pending paid successor as live after its provisional expiry', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        overlappingGrants: [{
          id: 'grant-delayed-pending',
          expires_at: '2000-01-01T00:00:00.000Z',
          grant_status: 'pending',
          remove_on_expiry: false,
        }],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
      expect(harness.ownershipOr).toHaveBeenCalledWith(
        'commerce_find_live_temp_role_owner',
      );
      expect(harness.successorIntentUpdates).toContainEqual(expect.objectContaining({
        remove_on_expiry: true,
      }));
    });

    it('transfers cleanup from expired unswept A to B, then B removes the role on its expiry', async () => {
      const firstSweep = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        overlappingGrants: [{ id: 'grant-successor', remove_on_expiry: false }],
      });

      await sweepExpiredTempRoleGrants(firstSweep.client);

      expect(firstSweep.roleRemove).not.toHaveBeenCalled();
      expect(firstSweep.successorIntentUpdates).toContainEqual(expect.objectContaining({
        remove_on_expiry: true,
      }));
      expect(firstSweep.deleteEq).toHaveBeenCalledWith('id', 'grant-current');

      const successorSweep = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        memberRoleStates: [true, false],
      });
      await sweepExpiredTempRoleGrants(successorSweep.client);

      expect(successorSweep.roleRemove).toHaveBeenCalledWith(
        'role-1',
        'SomniBot — temporary role expired',
      );
      expect(successorSweep.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
    });

    it('compare-deletes a stale B snapshot only after observing the transferred cleanup flag', async () => {
      vi.useFakeTimers();
      let releaseBDelete: (() => void) | undefined;
      let releaseADelete: (() => void) | undefined;
      try {
        const aExpiry = '2030-01-01T00:00:00.000Z';
        const bExpiry = '2030-01-02T00:00:00.000Z';
        const sharedTempRoleRows = new Map<string, Record<string, unknown>>([
          ['grant-a', {
            id: 'grant-a',
            guild_id: 'guild-1',
            user_id: 'user-1',
            role_id: 'role-1',
            expires_at: aExpiry,
            source: 'commerce_purchase',
            order_id: 'order-a',
            grant_status: 'applied',
            remove_on_expiry: true,
          }],
          ['grant-b', {
            id: 'grant-b',
            guild_id: 'guild-1',
            user_id: 'user-1',
            role_id: 'role-1',
            expires_at: bExpiry,
            source: 'commerce_purchase',
            order_id: 'order-b',
            grant_status: 'applied',
            remove_on_expiry: false,
          }],
        ]);

        let reportBDeleteReached!: () => void;
        const bDeleteReached = new Promise<void>((resolve) => { reportBDeleteReached = resolve; });
        const bDeleteRelease = new Promise<void>((resolve) => {
          releaseBDelete = () => resolve();
        });
        const staleB = makeCommerceTempRoleSweepClient({
          grantId: 'grant-b',
          orderId: 'order-b',
          expiresAt: bExpiry,
          removeOnExpiry: false,
          sharedTempRoleRows,
          beforeDeleteAck: async () => {
            reportBDeleteReached();
            await bDeleteRelease;
          },
        });

        // A later worker has fetched B=false and built its delete predicates,
        // but the mock holds evaluation against shared database state.
        vi.setSystemTime(new Date('2030-01-03T00:00:00.000Z'));
        const staleBSweep = sweepExpiredTempRoleGrants(staleB.client);
        await bDeleteReached;

        let reportADeleteReached!: () => void;
        const aDeleteReached = new Promise<void>((resolve) => { reportADeleteReached = resolve; });
        const aDeleteRelease = new Promise<void>((resolve) => {
          releaseADelete = () => resolve();
        });
        const expiringA = makeCommerceTempRoleSweepClient({
          grantId: 'grant-a',
          orderId: 'order-a',
          expiresAt: aExpiry,
          removeOnExpiry: true,
          overlappingGrants: [{
            id: 'grant-b',
            expires_at: bExpiry,
            remove_on_expiry: false,
          }],
          sharedTempRoleRows,
          beforeDeleteAck: async () => {
            reportADeleteReached();
            await aDeleteRelease;
          },
        });

        // This models an earlier worker whose captured cutoff still considers
        // B live. Its acknowledged update mutates the shared row before A's
        // own delete is released.
        vi.setSystemTime(new Date('2030-01-01T12:00:00.000Z'));
        const aSweep = sweepExpiredTempRoleGrants(expiringA.client);
        await aDeleteReached;
        expect(sharedTempRoleRows.get('grant-b')?.remove_on_expiry).toBe(true);

        // The mock now evaluates B's recorded Supabase equality predicates
        // against B=true. The stale remove_on_expiry=false delete matches zero
        // rows; if that predicate is omitted, this test deletes B and fails.
        releaseBDelete!();
        await staleBSweep;
        expect(staleB.acknowledgedDeletes).toEqual([]);
        expect(sharedTempRoleRows.has('grant-b')).toBe(true);

        releaseADelete!();
        await aSweep;
        expect(expiringA.acknowledgedDeletes).toEqual(['grant-a']);
        expect(sharedTempRoleRows.get('grant-a')).toMatchObject({
          grant_status: 'removed',
          source: 'commerce_reconciled',
        });

        vi.setSystemTime(new Date('2030-01-03T00:00:00.000Z'));
        const laterB = makeCommerceTempRoleSweepClient({
          grantId: 'grant-b',
          orderId: 'order-b',
          expiresAt: bExpiry,
          removeOnExpiry: true,
          memberRoleStates: [true, false],
          sharedTempRoleRows,
        });
        await sweepExpiredTempRoleGrants(laterB.client);
        expect(laterB.roleRemove).toHaveBeenCalledWith(
          'role-1',
          'SomniBot — temporary role expired',
        );
        expect(laterB.acknowledgedDeletes).toEqual(['grant-b']);
        expect(sharedTempRoleRows.get('grant-b')).toMatchObject({
          grant_status: 'removed',
          source: 'commerce_reconciled',
        });
      } finally {
        releaseBDelete?.();
        releaseADelete?.();
        vi.useRealTimers();
      }
    });

    it('preserves expired provenance when successor cleanup transfer is not acknowledged', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        overlappingGrants: [{ id: 'grant-successor', remove_on_expiry: false }],
        transferError: { message: 'database unavailable' },
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('keeps the role when a live entitlement snapshot still owns it', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        customers: [{ id: 'customer-1' }],
        entitlements: [{ id: 'entitlement-1' }],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
    });

    it('does not let an expiring non-commerce grant strip a live paid entitlement role', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        source: 'level_reward',
        removeOnExpiry: true,
        customers: [{ id: 'customer-1' }],
        entitlements: [{ id: 'entitlement-paid' }],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
    });

    it('does not let an expiring non-commerce grant strip an overlapping temp owner', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        source: 'level_reward',
        removeOnExpiry: true,
        overlappingGrants: [{ id: 'grant-future' }],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).not.toHaveBeenCalled();
      expect(harness.fetch).not.toHaveBeenCalled();
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
        overlappingResponses: [
          { data: [], error: null },
          { data: [{ id: 'grant-concurrent' }], error: null },
        ],
        memberRoleStates: [true, false, false, true],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.roleAdd).toHaveBeenCalledWith(
        'role-1',
        expect.stringContaining('concurrent commerce owner'),
      );
      expect(harness.deleteEq).toHaveBeenCalledWith('id', 'grant-current');
    });

    it('restores the role and preserves provenance when post-removal ownership lookup fails', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        overlappingResponses: [
          { data: [], error: null },
          { data: [], error: { message: 'database unavailable' } },
        ],
        memberRoleStates: [true, false, false, true],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.roleAdd).toHaveBeenCalledTimes(1);
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('restores access when the exact grant reactivates at the atomic retirement boundary', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        parentOrderStatus: 'refunded',
        entitlementIsLive: false,
        overlappingResponses: [
          { data: [], error: null },
          { data: [], error: null },
          { data: [{ id: 'grant-current', remove_on_expiry: true }], error: null },
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

    it('preserves provenance when atomic retirement fails after terminal removal', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        parentOrderStatus: 'refunded',
        entitlementIsLive: false,
        overlappingResponses: [
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
        ],
        retirementResults: [{ data: null, error: { message: 'database unavailable' } }],
        memberRoleStates: [true, false],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.acknowledgedDeletes).toEqual([]);
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

    it('preserves order-backed provenance when post-removal confirmation fails', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        memberRoleStates: [true, new Error('confirmation unavailable')],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.roleRemove).toHaveBeenCalledTimes(1);
      expect(harness.fetch).toHaveBeenCalledTimes(2);
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('preserves order-backed provenance when an overlap lookup fails', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        overlappingError: { message: 'database unavailable' },
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('preserves order-backed provenance when its unique customer identity is missing', async () => {
      const harness = makeCommerceTempRoleSweepClient({
        removeOnExpiry: true,
        customers: [],
      });

      await sweepExpiredTempRoleGrants(harness.client);

      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.deleteEq).not.toHaveBeenCalled();
    });

    it('preserves provenance when the fresh Discord member lookup fails', async () => {
      const fetch = vi.fn().mockRejectedValue(new Error('Discord unavailable'));
      const { client: sweepClient, deleteEq } = makeTempRoleSweepClient(
        [grant('level_reward')],
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
        [grant('level_reward')],
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
        [grant('level_reward')],
        { members: { fetch } },
      );

      await sweepExpiredTempRoleGrants(sweepClient);

      expect(fetch).toHaveBeenCalledWith({ user: 'user-1', force: true });
      expect(remove).not.toHaveBeenCalled();
      expect(deleteEq).toHaveBeenCalledWith('id', 'grant-1');
    });
  });

});
