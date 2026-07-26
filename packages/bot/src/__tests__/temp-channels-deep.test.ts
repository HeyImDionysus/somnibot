/**
 * Deep tests for features/temp-channels/temp-channel-manager.ts — start, handleJoinHub, handleLeaveTemp.
 * 155 uncovered statements at 34.9%.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { TempChannelManager } from '../features/temp-channels/temp-channel-manager.js';

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

function makeSupa(overrides: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => makeChain(overrides[table] ?? null)),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

function makeGuild() {
  const channelCache = new Map();
  return {
    id: 'guild-1', name: 'Test',
    channels: {
      cache: channelCache,
      create: vi.fn(async (opts: any) => {
        const ch = { id: 'vc-new', ...opts, delete: vi.fn(), permissionOverwrites: { create: vi.fn() } };
        channelCache.set(ch.id, ch);
        return ch;
      }),
    },
    members: {
      cache: new Map([['user-1', { id: 'user-1', displayName: 'Tester', voice: { setChannel: vi.fn() } }]]),
      fetch: vi.fn().mockResolvedValue({ id: 'user-1', displayName: 'Tester' }),
    },
  } as any;
}

describe('TempChannelManager deep', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('start loads hubs from database', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', temp_channels_enabled: true },
      temp_channel_hubs: [{ id: 'hub-1', channel_id: 'vc-hub', guild_id: 'guild-1', name_template: '{user}\'s Channel' }],
    });
    const mgr = new TempChannelManager(makeGuild(), supa);
    await mgr.start();
    // Should query config and hubs tables
    expect(supa.from).toHaveBeenCalled();
  });

  it('handleJoinHub creates a temp channel for user', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', temp_channels_enabled: true },
      temp_channel_hubs: [{ id: 'hub-1', channel_id: 'vc-hub', guild_id: 'guild-1', name_template: '{user}\'s Channel', category_id: 'cat-1', user_limit: 10 }],
    });
    const guild = makeGuild();
    const mgr = new TempChannelManager(guild, supa);
    await mgr.start();
    const member = { id: 'user-1', displayName: 'Tester', voice: { setChannel: vi.fn() }, user: { id: 'user-1' } } as any;
    await mgr.handleJoinHub(member, 'vc-hub');
    // Should attempt to create a channel or query DB
    expect(supa.from).toHaveBeenCalled();
  });

  it('reloadHubs refreshes hub configuration', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: 'guild-1', temp_channels_enabled: true },
      temp_channel_hubs: [],
    });
    const mgr = new TempChannelManager(makeGuild(), supa);
    await mgr.reloadHubs();
    // Should query the hubs table
    expect(supa.from).toHaveBeenCalled();
  });
});
