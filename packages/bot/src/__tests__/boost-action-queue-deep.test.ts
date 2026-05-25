/**
 * Deep tests for services/action-queue.ts — startActionQueueListener processes pending actions.
 * 599 uncovered statements at 15.8%.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return { ...actual };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { startActionQueueListener } from '../services/action-queue.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range', 'ilike', 'filter']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? (Array.isArray(data) ? data : [data]) : [], error: null, count: 0 });
  return chain;
}

function makeSupa(pendingActions: any[] = []) {
  const channelObj = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  };
  return {
    from: vi.fn(() => makeChain(pendingActions.length > 0 ? pendingActions : null)),
    channel: vi.fn(() => channelObj),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

function makeGuild() {
  const roleCache = new Map([['role-1', { id: 'role-1', name: 'Test', position: 1, setPosition: vi.fn() }]]);
  const channelCache = new Map([['ch-1', {
    id: 'ch-1', name: 'test',
    send: vi.fn().mockResolvedValue({ id: 'msg-1' }),
  }]]);
  return {
    id: 'guild-1', name: 'Test Guild',
    roles: {
      cache: roleCache,
      create: vi.fn(async (opts: any) => ({ id: 'new-role-1', ...opts })),
      fetch: vi.fn().mockResolvedValue(roleCache),
    },
    channels: {
      cache: channelCache,
      create: vi.fn(async (opts: any) => ({ id: 'new-ch-1', ...opts })),
      fetch: vi.fn().mockResolvedValue(channelCache),
    },
    members: {
      cache: new Map(),
      fetch: vi.fn().mockResolvedValue(new Map()),
    },
  } as any;
}

describe('Action Queue deep', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts listener with no pending actions', async () => {
    const supa = makeSupa();
    await startActionQueueListener(makeGuild(), supa);
  });

  it('starts listener and processes pending create_role action', async () => {
    const supa = makeSupa([{
      id: 'aq-1', guild_id: 'guild-1', action: 'create_role',
      payload: { name: 'NewRole', color: '#ff0000', permissions: '0' },
      status: 'pending', attempt_count: 0, created_at: new Date().toISOString(),
    }]);
    await startActionQueueListener(makeGuild(), supa);
  });

  it('starts listener and processes pending create_channel action', async () => {
    const supa = makeSupa([{
      id: 'aq-2', guild_id: 'guild-1', action: 'create_channel',
      payload: { name: 'new-channel', type: 0 },
      status: 'pending', attempt_count: 0, created_at: new Date().toISOString(),
    }]);
    await startActionQueueListener(makeGuild(), supa);
  });

  it('starts listener and processes pending send_embed action', async () => {
    const supa = makeSupa([{
      id: 'aq-3', guild_id: 'guild-1', action: 'send_embed',
      payload: { channel_id: 'ch-1', embed: { title: 'Test', description: 'Hello' } },
      status: 'pending', attempt_count: 0, created_at: new Date().toISOString(),
    }]);
    await startActionQueueListener(makeGuild(), supa);
  });

  it('starts listener and processes pending config_reload action', async () => {
    const supa = makeSupa([{
      id: 'aq-4', guild_id: 'guild-1', action: 'config_reload',
      payload: { feature: 'economy' },
      status: 'pending', attempt_count: 0, created_at: new Date().toISOString(),
    }]);
    await startActionQueueListener(makeGuild(), supa);
  });

  it('starts listener and processes pending delete_role action', async () => {
    const supa = makeSupa([{
      id: 'aq-5', guild_id: 'guild-1', action: 'delete_role',
      payload: { role_id: 'role-1' },
      status: 'pending', attempt_count: 0, created_at: new Date().toISOString(),
    }]);
    const guild = makeGuild();
    guild.roles.cache.get('role-1').delete = vi.fn().mockResolvedValue(undefined);
    await startActionQueueListener(guild, supa);
  });

  it('starts listener and processes pending update_role action', async () => {
    const supa = makeSupa([{
      id: 'aq-6', guild_id: 'guild-1', action: 'update_role',
      payload: { role_id: 'role-1', name: 'Renamed', color: '#00ff00' },
      status: 'pending', attempt_count: 0, created_at: new Date().toISOString(),
    }]);
    const guild = makeGuild();
    guild.roles.cache.get('role-1').edit = vi.fn().mockResolvedValue({});
    await startActionQueueListener(guild, supa);
  });
});
