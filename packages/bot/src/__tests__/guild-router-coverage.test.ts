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

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { GuildRouter, getGuildId } from '../guild-router.js';
import { destroyGuildServices } from '../guild-init.js';

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

    await router.destroyAll();
  });

  it('returns cached context on subsequent calls', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    const ctx1 = await router.getContext('g1');
    const ctx2 = await router.getContext('g1');
    expect(ctx1).toBe(ctx2);

    await router.destroyAll();
  });

  it('getContextSync returns undefined for uninitialized guild', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    expect(router.getContextSync('g1')).toBeUndefined();
    await router.destroyAll();
  });

  it('getContextSync returns context after initialization', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    await router.getContext('g1');
    expect(router.getContextSync('g1')).toBeDefined();

    await router.destroyAll();
  });

  it('has() returns false for unknown guild', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    expect(router.has('unknown')).toBe(false);
    await router.destroyAll();
  });

  it('all() iterates over active contexts', async () => {
    const guilds = { g1: makeGuild('g1'), g2: makeGuild('g2') };
    const { client, supabase, valkey, eventBus } = makeDeps(guilds);
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    await router.getContext('g1');
    await router.getContext('g2');

    const all = [...router.all()];
    expect(all).toHaveLength(2);

    await router.destroyAll();
  });

  it('remove() destroys and removes a context', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    const ctx = await router.getContext('g1');
    await router.remove('g1');

    expect(router.has('g1')).toBe(false);
    expect(router.size).toBe(0);
    expect(ctx.destroy).toHaveBeenCalled();

    await router.destroyAll();
  });

  it('retains the context when an awaited service drain rejects', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);
    const ctx = await router.getContext('g1');
    vi.mocked(destroyGuildServices)
      .mockRejectedValueOnce(new Error('audit residue remains'))
      .mockResolvedValue(undefined);

    await expect(router.remove('g1')).rejects.toThrow('audit residue remains');
    expect(router.getContextSync('g1')).toBe(ctx);
    expect(ctx.destroy).not.toHaveBeenCalled();

    await router.remove('g1');
    expect(router.has('g1')).toBe(false);
    expect(ctx.destroy).toHaveBeenCalledOnce();
    await router.destroyAll();
  });

  it('remove() is a no-op for unknown guild', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    await expect(router.remove('unknown')).resolves.toBeUndefined();
    await router.destroyAll();
  });

  it('destroyAll() cleans up all contexts', async () => {
    const guilds = { g1: makeGuild('g1'), g2: makeGuild('g2') };
    const { client, supabase, valkey, eventBus } = makeDeps(guilds);
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    await router.getContext('g1');
    await router.getContext('g2');
    await router.destroyAll();

    expect(router.size).toBe(0);
  });

  // ── Codex round-3 finding #3: replacing a placeholder must not leak its timer ──
  // index.ts installs empty placeholder routers (verification mode, guildless
  // deferred boot) and later replaces them with the real router in runFullBoot.
  // The replacement calls destroyAll() first — these assert that actually
  // releases the eviction interval and that a double teardown (transition path
  // already destroyed the verification placeholder) stays safe.
  it('destroyAll() clears the eviction interval so a replaced placeholder leaks no timer', () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const before = vi.getTimerCount();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    // Constructor arms the periodic eviction interval.
    expect(vi.getTimerCount()).toBe(before + 1);

    router.destroyAll();

    // Interval released — a full boot replacing this router leaves nothing running.
    expect(vi.getTimerCount()).toBe(before);
  });

  it('destroyAll() is idempotent (safe when the transition already tore the placeholder down)', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    await router.getContext('g1');
    await router.destroyAll();

    await expect(router.destroyAll()).resolves.toBeUndefined();
    expect(router.size).toBe(0);
  });

  it('does not create a new context while async destroyAll is draining', async () => {
    const guilds = { g1: makeGuild('g1'), g2: makeGuild('g2') };
    const { client, supabase, valkey, eventBus } = makeDeps(guilds);
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);
    await router.getContext('g1');
    let release!: () => void;
    const draining = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(destroyGuildServices).mockImplementationOnce(() => draining);

    const destroying = router.destroyAll();
    await expect(router.getContext('g2')).rejects.toThrow(/shutting down/);

    release();
    await destroying;
    expect(router.size).toBe(0);
  });

  it('fences and tears down an initialization that finishes after destroyAll starts', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    let initializedCtx: any;
    let signalInitStarted!: () => void;
    const initStarted = new Promise<void>((resolve) => {
      signalInitStarted = resolve;
    });
    let releaseInit!: () => void;
    const initGate = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    const router = new GuildRouter(
      client as any,
      supabase,
      valkey,
      eventBus,
      async (ctx) => {
        initializedCtx = ctx;
        signalInitStarted();
        await initGate;
      },
    );

    const getting = router.getContext('g1');
    await initStarted;
    const destroying = router.destroyAll();
    releaseInit();

    await expect(getting).rejects.toThrow(/shutting down/);
    await destroying;
    expect(destroyGuildServices).toHaveBeenCalledWith(initializedCtx);
    expect(initializedCtx.destroy).toHaveBeenCalledOnce();
    expect(router.size).toBe(0);
  });

  it('fences and tears down an initialization that finishes after remove starts', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    let initializedCtx: any;
    let signalInitStarted!: () => void;
    const initStarted = new Promise<void>((resolve) => {
      signalInitStarted = resolve;
    });
    let releaseInit!: () => void;
    const initGate = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    const router = new GuildRouter(
      client as any,
      supabase,
      valkey,
      eventBus,
      async (ctx) => {
        initializedCtx = ctx;
        signalInitStarted();
        await initGate;
      },
    );

    const getting = router.getContext('g1');
    await initStarted;
    const removing = router.remove('g1');
    releaseInit();

    await expect(getting).rejects.toThrow(/removed during initialization/);
    await removing;
    expect(destroyGuildServices).toHaveBeenCalledWith(initializedCtx);
    expect(initializedCtx.destroy).toHaveBeenCalledOnce();
    expect(router.size).toBe(0);
  });

  it('throws when guild is not in cache', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps({});
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    await expect(router.getContext('missing')).rejects.toThrow('Guild missing not in cache');
    await router.destroyAll();
  });

  it('runs initCallback when provided', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const callback = vi.fn().mockResolvedValue(undefined);
    const router = new GuildRouter(client as any, supabase, valkey, eventBus, callback);

    await router.getContext('g1');
    expect(callback).toHaveBeenCalledOnce();

    await router.destroyAll();
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

    await router.destroyAll();
  });

  it('evicts idle guild contexts', async () => {
    const { client, supabase, valkey, eventBus } = makeDeps();
    const router = new GuildRouter(client as any, supabase, valkey, eventBus);

    await router.getContext('g1');
    expect(router.has('g1')).toBe(true);

    // Advance time past the idle timeout (30 min default)
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    // Advance past the eviction check interval (5 min default) 
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

    expect(router.has('g1')).toBe(false);

    await router.destroyAll();
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
