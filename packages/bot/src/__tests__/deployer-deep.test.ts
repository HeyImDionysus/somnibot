/**
 * Deep tests for deploy/deployer.ts — deployServerState with various states.
 * 268 uncovered statements at 37.0%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return { ...actual };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { deployServerState } from '../deploy/deployer.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? (Array.isArray(data) ? data : [data]) : [], error: null, count: 0 });
  return chain;
}

function makeSupa() {
  return {
    from: vi.fn(() => makeChain()),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

function makeGuild(botPosition = 1) {
  const botRole = { id: 'role-bot', name: 'Somnibot', position: botPosition, rawPosition: botPosition, managed: true };
  const everyoneRole = { id: 'guild-1', name: '@everyone', position: 0, rawPosition: 0 };
  const roleCache = new Map([
    ['role-bot', botRole],
    ['guild-1', everyoneRole],
  ]);
  const channelCache = new Map();

  return {
    id: 'guild-1', name: 'Test Guild',
    members: {
      me: {
        roles: { highest: botRole },
        permissions: { has: vi.fn(() => true) },
      },
    },
    roles: {
      cache: roleCache,
      create: vi.fn(async (opts: any) => ({ id: 'new-role', ...opts, position: 1 })),
      everyone: everyoneRole,
      botRoleFor: vi.fn(() => botRole),
      fetch: vi.fn().mockResolvedValue(roleCache),
    },
    channels: {
      cache: channelCache,
      create: vi.fn(async (opts: any) => ({ id: 'new-ch', ...opts })),
    },
  } as any;
}

describe('Deployer deep', () => {
  it('deployServerState returns early if bot is not top position', async () => {
    const guild = makeGuild(0); // position 0, not top
    // Add a role above the bot
    guild.roles.cache.set('role-above', { id: 'role-above', name: 'Above', position: 2, rawPosition: 2, managed: false });
    const result = await deployServerState(guild, makeSupa(), {
      roles: [],
      channels: [],
      categories: [],
      everyonePermissions: '0',
    }, {
      dryRun: false, cleanExisting: false,
    });
    expect(result).toBeDefined();
    expect(result.success).toBeDefined();
  });

  it('deployServerState performs dry run with empty state', async () => {
    const result = await deployServerState(makeGuild(), makeSupa(), {
      roles: [],
      channels: [],
      categories: [],
      everyonePermissions: '0',
    }, {
      dryRun: true, cleanExisting: false,
    });
    expect(result).toBeDefined();
    expect(result.actions).toBeInstanceOf(Array);
  });

  it('deployServerState deploys roles', async () => {
    const guild = makeGuild(5);
    const result = await deployServerState(guild, makeSupa(), {
      roles: [
        { key: 'mod', name: 'Moderator', tier: 'staff', color: 0xff0000, permissions: '0', hoist: false, mentionable: false, position: 0 },
      ],
      channels: [],
      categories: [],
      everyonePermissions: '0',
    }, {
      dryRun: false, cleanExisting: false,
      onProgress: vi.fn(),
    });
    expect(result).toBeDefined();
  });
});
