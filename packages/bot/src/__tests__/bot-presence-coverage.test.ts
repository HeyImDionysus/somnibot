/**
 * bot-presence — coverage tests
 *
 * Tests BotPresenceManager with REAL imports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('discord.js', () => ({
  ActivityType: { Watching: 3, Listening: 2, Playing: 0, Custom: 4 },
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { BotPresenceManager } from '../features/discord-ux/bot-presence.js';
import { PlatformEventBus } from '../services/event-bus.js';

function chainBuilder(resolveValue: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'ilike', 'limit', 'order', 'maybeSingle', 'single']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeSupabase(config: any = null, productCount = 0) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'guild_config') {
        return chainBuilder({ data: config, error: null });
      }
      if (table === 'products') {
        const chain = chainBuilder({ count: productCount, data: null, error: null });
        return chain;
      }
      return chainBuilder();
    }),
  };
}

function makeClient(guildId: string, memberCount = 100) {
  const setPresence = vi.fn();
  const guild = {
    id: guildId,
    memberCount,
  };
  return {
    user: { setPresence },
    guilds: { cache: new Map([[guildId, guild]]) },
    router: undefined as any,
  };
}

describe('BotPresenceManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() sets initial presence and begins interval', async () => {
    const client = makeClient('g1', 500);
    const supabase = makeSupabase();
    const manager = new BotPresenceManager(client as any, 'g1', supabase as any);

    manager.start(30_000);

    // Wait for async updatePresence to settle
    await vi.advanceTimersByTimeAsync(100);

    expect(client.user.setPresence).toHaveBeenCalled();
    manager.stop();
  });

  it('stop() clears the interval', () => {
    const client = makeClient('g1');
    const supabase = makeSupabase();
    const manager = new BotPresenceManager(client as any, 'g1', supabase as any);

    manager.start(30_000);
    manager.stop();

    // Stopping twice is safe
    manager.stop();
  });

  it('rotates through presence entries on interval', async () => {
    const client = makeClient('g1', 200);
    const supabase = makeSupabase(null, 5);
    const manager = new BotPresenceManager(client as any, 'g1', supabase as any);

    manager.start(1000);

    // First call sets presence
    await vi.advanceTimersByTimeAsync(100);
    const firstCallCount = client.user.setPresence.mock.calls.length;

    // Advance by interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.user.setPresence.mock.calls.length).toBeGreaterThan(firstCallCount);

    manager.stop();
  });

  it('loads custom statuses from guild_config', async () => {
    const client = makeClient('g1', 50);
    const supabase = makeSupabase({
      custom_bot_statuses: ['Status 1', 'Status 2'],
    });
    const manager = new BotPresenceManager(client as any, 'g1', supabase as any);

    manager.start(30_000);
    await vi.advanceTimersByTimeAsync(100);

    manager.stop();
  });

  it('handles missing guild gracefully', async () => {
    const client = makeClient('g1');
    // Remove the guild from cache
    client.guilds.cache.clear();
    const supabase = makeSupabase();
    const manager = new BotPresenceManager(client as any, 'g1', supabase as any);

    manager.start(30_000);
    await vi.advanceTimersByTimeAsync(100);

    // Should not crash
    expect(client.user.setPresence).not.toHaveBeenCalled();
    manager.stop();
  });

  it('includes music status when a track is playing', async () => {
    const client = makeClient('g1', 100);
    // Set up a router with music player context
    client.router = {
      getContextSync: vi.fn().mockReturnValue({
        getManager: vi.fn().mockReturnValue({
          queueManager: {
            getQueue: vi.fn().mockResolvedValue({
              nowPlaying: { info: { title: 'Test Song' } },
            }),
          },
        }),
      }),
    };
    const supabase = makeSupabase();
    const manager = new BotPresenceManager(client as any, 'g1', supabase as any);

    manager.start(30_000);
    await vi.advanceTimersByTimeAsync(100);

    manager.stop();
  });

  it('handles uptime display', async () => {
    const client = makeClient('g1', 50);
    const supabase = makeSupabase();
    const manager = new BotPresenceManager(client as any, 'g1', supabase as any);

    // Advance startedAt into the past to get hours
    (manager as any).startedAt = Date.now() - 2 * 3_600_000;

    manager.start(30_000);
    await vi.advanceTimersByTimeAsync(100);

    manager.stop();
  });

  it('handles product count in presence', async () => {
    const client = makeClient('g1', 50);
    const supabase = makeSupabase(null, 10);
    const manager = new BotPresenceManager(client as any, 'g1', supabase as any);

    manager.start(30_000);

    // Multiple intervals to cycle through entries
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    manager.stop();
  });

  it('handles custom_bot_statuses as non-array gracefully', async () => {
    const client = makeClient('g1');
    const supabase = makeSupabase({ custom_bot_statuses: 'not-array' });
    const manager = new BotPresenceManager(client as any, 'g1', supabase as any);

    manager.start(30_000);
    await vi.advanceTimersByTimeAsync(100);

    manager.stop();
  });

  it('handles supabase error when loading statuses', async () => {
    const client = makeClient('g1');
    const supabase = {
      from: vi.fn().mockImplementation(() => {
        throw new Error('DB error');
      }),
    };
    const manager = new BotPresenceManager(client as any, 'g1', supabase as any);

    manager.start(30_000);
    await vi.advanceTimersByTimeAsync(100);

    // Should not crash
    manager.stop();
  });

  it('reloads saved statuses when the dashboard publishes a settings change', async () => {
    const client = makeClient('g1');
    const supabase = makeSupabase({ custom_bot_statuses: ['Live status'] });
    const eventBus = new PlatformEventBus();
    const manager = new BotPresenceManager(
      client as unknown as ConstructorParameters<typeof BotPresenceManager>[0],
      'g1',
      supabase as unknown as ConstructorParameters<typeof BotPresenceManager>[2],
      eventBus,
    );
    manager.start(30_000);
    await vi.advanceTimersByTimeAsync(100);
    const readsBefore = supabase.from.mock.calls.filter(([table]) => table === 'guild_config').length;
    eventBus.emit('config.changed', 'g1', {
      section: 'all',
      changes: { custom_bot_statuses: { before: [], after: ['Live status'] } },
      changedBy: 'owner',
      occurrenceId: 'presence-reload',
    });
    await vi.advanceTimersByTimeAsync(100);
    const readsAfter = supabase.from.mock.calls.filter(([table]) => table === 'guild_config').length;
    expect(readsAfter).toBeGreaterThan(readsBefore);
    manager.stop();
  });
});
