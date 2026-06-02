/**
 * guild-router — coverage tests
 *
 * Tests GuildRouter and getGuildId with REAL imports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock external deps before importing
vi.mock('../guild-context.js', () => ({
  GuildContext: vi.fn().mockImplementation(function (this: any, guild: any) {
    this.guild = guild;
    this.guildId = guild.id;
    this.loadConfig = vi.fn().mockResolvedValue(undefined);
    this.destroy = vi.fn();
    this.getManager = vi.fn();
    return this;
  }),
}));

vi.mock('../guild-init.js', () => ({
  destroyGuildServices: vi.fn(),
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { GuildRouter, getGuildId } from '../guild-router.js';

function makeGuild(id: string, name = 'Test Guild') {
  return { id, name };
}

function makeClient(guilds: Record<string, any> = {}) {
  const cache = new Map(Object.entries(guilds));
  return {
    guilds: { cache },
  };
}

function makeDeps(guildMap: Record<string, any> = { g1: makeGuild('g1') }) {
  const client = makeClient(guildMap);
  const supabase = {} as any;
  const valkey = {} as any;
  const eventBus = {} as any;
  return { client, supabase, valkey, eventBus };
}

describe('GuildRouter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates context on first getContext call', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    const ctx = await router.getContext('g1');
    expect(ctx).toBeDefined();
    expect(ctx.guildId).toBe('g1');
    expect(router.has('g1')).toBe(true);
    expect(router.size).toBe(1);

    router.destroyAll();
  });

  it('returns cached context on subsequent calls', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    const ctx1 = await router.getContext('g1');
    const ctx2 = await router.getContext('g1');
    expect(ctx1).toBe(ctx2);

    router.destroyAll();
  });

  it('getContextSync returns undefined for uninitialized guild', () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    expect(router.getContextSync('g1')).toBeUndefined();
    router.destroyAll();
  });

  it('getContextSync returns context after initialization', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    await router.getContext('g1');
    expect(router.getContextSync('g1')).toBeDefined();

    router.destroyAll();
  });

  it('has() returns false for unknown guild', () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    expect(router.has('unknown')).toBe(false);
    router.destroyAll();
  });

  it('all() iterates over active contexts', async () => {
    const guilds = { g1: makeGuild('g1'), g2: makeGuild('g2') };
    const { client, supabase, valkey, eventBus } = makeDeps(guilds);
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    await router.getContext('g1');
    await router.getContext('g2');

    const all = [...router.all()];
    expect(all).toHaveLength(2);

    router.destroyAll();
  });

  it('remove() destroys and removes a context', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    const ctx = await router.getContext('g1');
    router.remove('g1');

    expect(router.has('g1')).toBe(false);
    expect(router.size).toBe(0);
    expect(ctx.destroy).toHaveBeenCalled();

    router.destroyAll();
  });

  it('remove() is a no-op for unknown guild', () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    expect(() => router.remove('unknown')).not.toThrow();
    router.destroyAll();
  });

  it('destroyAll() cleans up all contexts', async () => {
    const guilds = { g1: makeGuild('g1'), g2: makeGuild('g2') };
    const { client, supabase, valkey, eventBus } = makeDeps(guilds);
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    await router.getContext('g1');
    await router.getContext('g2');
    router.destroyAll();

    expect(router.size).toBe(0);
  });

  it('throws when guild is not in cache', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps({});
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    await expect(router.getContext('missing')).rejects.toThrow('Guild missing not in cache');
    router.destroyAll();
  });

  it('runs initCallback when provided', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const callback = vi.fn().mockResolvedValue(undefined);
    const router = new GuildRouter(client as any, supabase, valkey, eventBus, callback);

    await router.getContext('g1');
    expect(callback).toHaveBeenCalledOnce();

    router.destroyAll();
  });

  it('deduplicates concurrent getContext calls for same guild', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    // Fire two concurrent getContext calls
    const [ctx1, ctx2] = await Promise.all([
      router.getContext('g1'),
      router.getContext('g1'),
    ]);
    expect(ctx1).toBe(ctx2);

    router.destroyAll();
  });

  it('evicts idle guild contexts', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    await router.getContext('g1');
    expect(router.has('g1')).toBe(true);

    // Advance time past the idle timeout (30 min default)
    vi.advanceTimersByTime(31 * 60 * 1000);

    // Advance past the eviction check interval (5 min default) 
    vi.advanceTimersByTime(6 * 60 * 1000);

    expect(router.has('g1')).toBe(false);

    router.destroyAll();
  });
});

describe('getGuildId', () => {
  it('extracts guildId from interaction', () => {
    expect(getGuildId({ guildId: 'g123' })).toBe('g123');
  });

  it('extracts guildId from guild object', () => {
    expect(getGuildId({ guild: { id: 'g456' } as any })).toBe('g456');
  });

  it('prefers guildId over guild.id', () => {
    expect(getGuildId({ guildId: 'g1', guild: { id: 'g2' } as any })).toBe('g1');
  });

  it('throws when no guild context', () => {
    expect(() => getGuildId({})).toThrow('Cannot determine guild ID');
  });

  it('throws when guildId is null', () => {
    expect(() => getGuildId({ guildId: null })).toThrow('Cannot determine guild ID');
  });
});
