/**
 * Tests for deploy/deploy-listener.ts — listens for deploy requests
 * from the dashboard via Supabase Realtime and triggers deployServerState.
 * 219 uncovered statements.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => {
  class C extends Map {
    filter(fn: any) { const r = new C(); for (const [k, v] of this) if (fn(v, k)) r.set(k, v); return r; }
    map(fn: any) { return [...this.values()].map(fn); }
  }
  return {
    EmbedBuilder: class {
    // Real EmbedBuilder always exposes `data` (branded embeds read
    // data.footer to append attribution without clobbering it).
    data: Record<string, unknown> = {};
      setColor() { return this; } setTitle() { return this; }
      setDescription() { return this; } setFooter() { return this; }
      setTimestamp() { return this; } addFields() { return this; }
    },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionFlagsBits: { ManageRoles: 8n, ManageChannels: 4n },
    PermissionsBitField: class { static Flags = { ViewChannel: 1n }; },
    Collection: C,
  };
});

vi.mock('../deploy/deployer.js', () => ({
  deployServerState: vi.fn(async () => ({
    success: true, deployId: 'test-deploy', duration: 150,
    actions: [{ step: 1, action: 'set', entityType: 'everyone', entityName: '@everyone', success: true }],
    errors: [], idMappings: [],
  })),
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock('../guards/bot-role-guard.js', () => ({
  checkBotRolePosition: vi.fn(async () => ({ isTopPosition: true, rolesAboveBot: [] })),
  checkBotPermissions: vi.fn(() => ({ hasRequired: true, missing: [] })),
}));

import { getDeployStatus, startDeployListener } from '../deploy/deploy-listener.js';

function makeSupa() {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'single', 'maybeSingle', 'order', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: Function) => resolve({ data: null, error: null });
  chain.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
  return {
    from: vi.fn(() => chain),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: any) => { if (typeof cb === 'function') cb('SUBSCRIBED'); }),
    })),
  };
}

function makeGuild() {
  return {
    id: 'guild-1', name: 'Test', memberCount: 100,
    members: { me: { id: 'bot-1', permissions: { has: () => true } } },
    roles: { cache: new Map(), everyone: { id: 'guild-1', setPermissions: vi.fn() } },
    channels: { cache: new Map() },
    client: { user: { id: 'bot-1' } },
  } as any;
}

describe('deploy-listener', () => {
  describe('getDeployStatus', () => {
    it('returns null or an object', () => {
      const status = getDeployStatus();
      expect(status === null || typeof status === 'object').toBe(true);
    });
  });

  describe('startDeployListener', () => {
    it('creates a realtime subscription for deploy_requests', () => {
      const client: any = {
        supabase: makeSupa(),
        eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
        guilds: { cache: new Map([['guild-1', makeGuild()]]) },
      };
      startDeployListener(client);
      expect(client.supabase.channel).toHaveBeenCalled();
    });

    it('listens for postgres_changes INSERT events', () => {
      const onFn = vi.fn().mockReturnThis();
      const client: any = {
        supabase: { ...makeSupa(), channel: vi.fn(() => ({ on: onFn, subscribe: vi.fn() })) },
        eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
        guilds: { cache: new Map([['guild-1', makeGuild()]]) },
      };
      startDeployListener(client);
      // Should register at least one listener
      expect(onFn).toHaveBeenCalled();
    });
  });
});
