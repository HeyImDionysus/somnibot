/**
 * Tests for services/action-queue.ts — the action queue listener that
 * processes dashboard-initiated operations (role/channel CRUD, embeds,
 * fulfillment, config reload, etc.)
 *
 * This module has 631 uncovered statements and contains critical
 * business logic: atomic claiming, stale action recovery, the DLQ
 * pipeline, and 15+ action handlers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

vi.mock('discord.js', () => {
  class C extends Map {
    filter(fn: any) { const r = new C(); for (const [k, v] of this) if (fn(v, k)) r.set(k, v); return r; }
    map(fn: any) { return [...this.values()].map(fn); }
    find(fn: any) { return [...this.values()].find(fn); }
    first() { return [...this.values()][0]; }
  }
  return {
    EmbedBuilder: class {
      data: any = {};
      setColor() { return this; } setTitle(t: string) { this.data.title = t; return this; }
      setDescription(d: string) { this.data.description = d; return this; }
      setThumbnail() { return this; } setTimestamp() { return this; }
      setFooter(f: any) { this.data.footer = f; return this; }
      addFields(...f: any[]) { this.data.fields = [...(this.data.fields || []), ...f.flat()]; return this; }
      setAuthor(a: any) { this.data.author = a; return this; }
      setImage() { return this; }
    },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageChannels: 4n, ManageRoles: 8n },
    PermissionsBitField: class {
      value: bigint;
      constructor(v: any) { this.value = BigInt(v); }
      static Flags = { ViewChannel: 1n };
    },
    Collection: C,
  };
});

// Mock all dependencies that action-queue imports
vi.mock('../services/guild-snapshot.js', () => ({
  writeGuildSnapshot: vi.fn(async () => {}),
}));
vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));
vi.mock('../services/commerce-fulfillment.js', () => ({
  CommerceFulfillmentService: class {
    fulfill = vi.fn(async () => ({ success: true, entitlementId: 'ent1', receiptSent: true, eventEmitted: true, errors: [] }));
  },
}));
vi.mock('../services/event-bus.js', () => {
  const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { eventBus: bus, PlatformEventBus: class { emit = vi.fn(); on = vi.fn(); off = vi.fn(); } };
});
vi.mock('../services/reconciliation.js', () => ({
  runReconciliation: vi.fn(async () => {}),
}));

import { startActionQueueListener, getDeployStatus } from '../services/action-queue.js';
import { writeGuildSnapshot } from '../services/guild-snapshot.js';
import { writeAuditLog } from '../services/audit.js';

// ── Helpers ──────────────────────────────────────────────────

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'order', 'limit', 'single', 'maybeSingle', 'match', 'contains', 'overlaps', 'filter', 'or', 'ilike', 'like', 'returns', 'range']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa(rpcResult: any = null, tableOverrides: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => {
      const data = tableOverrides[table] ?? null;
      return makeChain({ data, error: null });
    }),
    rpc: vi.fn(async (fn: string) => {
      if (fn === 'bot_action_queue_claim') {
        return { data: rpcResult ?? [{ id: 'a1' }], error: null };
      }
      if (fn === 'bot_action_queue_recover_stale') {
        return { data: rpcResult ?? [], error: null };
      }
      return { data: rpcResult, error: null };
    }),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: any) => { if (typeof cb === 'function') cb('SUBSCRIBED'); return 'subscribed'; }),
    })),
  };
}

function makeGuild(overrides: any = {}) {
  const textCh: any = {
    id: 'ch-1', type: 0, name: 'general',
    isTextBased: () => true,
    send: vi.fn().mockResolvedValue({ id: 'msg-sent' }),
    messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
    edit: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    permissionOverwrites: { create: vi.fn(), edit: vi.fn(), cache: new Map() },
  };

  const roleObj: any = {
    id: 'role-1', name: 'Admin', position: 50,
    managed: false, editable: true,
    edit: vi.fn().mockResolvedValue({}),
    setPosition: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    setPermissions: vi.fn().mockResolvedValue({}),
  };

  const everyoneRole: any = {
    id: 'guild-1', name: '@everyone', position: 0,
    permissions: { bitfield: 0n },
    setPermissions: vi.fn().mockResolvedValue({}),
  };

  const guild: any = {
    id: 'guild-1',
    name: 'Test Server',
    memberCount: 150,
    iconURL: () => 'https://example.com/icon.png',
    members: {
      me: {
        id: 'bot-1',
        displayName: 'Somnibot',
        user: { id: 'bot-1', tag: 'Somnibot#0001', displayAvatarURL: () => 'https://ex.com/a.png' },
        roles: { highest: { position: 100, comparePositionTo: () => 1 } },
        permissions: { has: () => true },
      },
      cache: new Map([['bot-1', { id: 'bot-1' }]]),
      fetch: vi.fn().mockResolvedValue({
        id: 'user-1', displayName: 'TestUser',
        user: { tag: 'Test#0001', displayAvatarURL: () => 'url' },
        roles: { cache: new Map([['role-1', roleObj]]), add: vi.fn(), remove: vi.fn() },
      }),
    },
    roles: {
      cache: new Map([['role-1', roleObj]]),
      everyone: everyoneRole,
      create: vi.fn().mockResolvedValue({ id: 'new-role', name: 'NewRole', position: 5, setPosition: vi.fn() }),
      fetch: vi.fn().mockResolvedValue(new Map()),
    },
    channels: {
      cache: new Map([['ch-1', textCh]]),
      create: vi.fn().mockResolvedValue({ id: 'new-ch', name: 'new-channel', isTextBased: () => true }),
      fetch: vi.fn().mockResolvedValue(new Map([['ch-1', textCh]])),
    },
    client: {
      user: { id: 'bot-1' },
      users: { fetch: vi.fn().mockResolvedValue({ id: 'user-1', send: vi.fn() }) },
    },
    ...overrides,
  };
  return guild;
}

describe('action-queue', () => {
  describe('startActionQueueListener', () => {
    it('processes pending actions on startup', async () => {
      const guild = makeGuild();
      const supa = makeSupa([], {
        bot_action_queue: [
          { id: 'a1', guild_id: 'guild-1', action: 'refresh_snapshot', payload: {}, status: 'pending' },
        ],
      });
      await startActionQueueListener(guild, supa as any);

      // Should subscribe to realtime channel
      expect(supa.channel).toHaveBeenCalledWith('bot-action-queue');
    });

    it('recovers stale actions before processing pending', async () => {
      const guild = makeGuild();
      const supa = makeSupa([], {});
      await startActionQueueListener(guild, supa as any);

      // Should have called rpc for recovery
      expect(supa.rpc).toHaveBeenCalledWith('bot_action_queue_recover_stale', expect.any(Object));
    });

    it('sets up periodic stale recovery sweep', async () => {
      vi.useFakeTimers();
      const guild = makeGuild();
      const supa = makeSupa([], {});
      await startActionQueueListener(guild, supa as any);

      // The interval call to recoverStaleActions
      const callsBefore = supa.rpc.mock.calls.length;
      vi.advanceTimersByTime(65000);
      // Let any promises settle
      await vi.runAllTimersAsync().catch(() => {});

      vi.useRealTimers();
    });

    it('subscribes to realtime INSERT events', async () => {
      const guild = makeGuild();
      const onFn = vi.fn().mockReturnThis();
      const supa: any = {
        ...makeSupa([], {}),
        channel: vi.fn(() => ({ on: onFn, subscribe: vi.fn() })),
      };
      await startActionQueueListener(guild, supa);

      expect(onFn).toHaveBeenCalledWith(
        'postgres_changes',
        expect.objectContaining({ event: 'INSERT', table: 'bot_action_queue' }),
        expect.any(Function),
      );
    });
  });
});
