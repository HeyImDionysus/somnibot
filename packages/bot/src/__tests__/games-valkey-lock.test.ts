/**
 * W2B [game-economy]: distributed per-user game lock tests.
 *
 * The per-user "game in progress" lock guards the TOCTOU between
 * checkDailyLimit's read and addDailyLoss's increment.  An in-memory
 * Set<string> is bypassed across process restart and multi-instance,
 * so the lock is backed by Valkey (SET NX PX + owner-token release)
 * with an in-memory fallback when Valkey is unavailable.
 *
 * Coverage:
 *  - concurrent acquire: the second command is rejected while the first holds
 *  - TTL auto-expiry: SET NX carries a bounded PX so a crash cannot deadlock
 *  - release only by owner: a stale token release does not free another owner's lock
 *  - Valkey-down fallback: acquire/release degrade to the in-memory Set
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { GamesManager } from '../features/games/games-manager.js';

const CONFIG = {
  guild_id: 'guild-1',
  economy_games_enabled: true,
  economy_coinflip_max_bet: 10000,
  economy_slots_max_bet: 10000,
  economy_blackjack_max_bet: 10000,
  economy_daily_loss_limit: 0,
};

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range', 'ilike', 'like']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? (Array.isArray(data) ? data : [data]) : [], error: null, count: 0 });
  return chain;
}

function makeSupa(walletBalance = 5000) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'economy_wallets') return makeChain({ wallet: walletBalance });
      return makeChain({ ...CONFIG });
    }),
    rpc: vi.fn(async () => ({ data: 0, error: null })),
  } as any;
}

/**
 * A minimal Valkey stub that honours SET ... NX/PX semantics and the
 * owner-token compare-and-delete used for safe release.  `tick(ms)`
 * simulates TTL expiry without real timers.
 */
function makeValkey() {
  const store = new Map<string, { value: string; expireAt: number | null }>();
  let now = 0;
  const live = (k: string): boolean => {
    const e = store.get(k);
    if (!e) return false;
    if (e.expireAt !== null && e.expireAt <= now) { store.delete(k); return false; }
    return true;
  };
  return {
    _store: store,
    tick: (ms: number) => { now += ms; },
    set: vi.fn(async (...args: unknown[]) => {
      const [k, v] = args as [string, string];
      // parse optional PX <ms> and NX flags anywhere in the tail
      const tail = args.slice(2).map((a) => String(a));
      const nx = tail.includes('NX');
      let expireAt: number | null = null;
      const pxIdx = tail.findIndex((t) => t === 'PX');
      if (pxIdx >= 0) expireAt = now + Number(tail[pxIdx + 1]);
      const exIdx = tail.findIndex((t) => t === 'EX');
      if (exIdx >= 0) expireAt = now + Number(tail[exIdx + 1]) * 1000;
      if (nx && live(k)) return null;
      store.set(k, { value: v, expireAt });
      return 'OK';
    }),
    get: vi.fn(async (k: string) => (live(k) ? store.get(k)!.value : null)),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    ttl: vi.fn(async () => 30),
    // compare-and-delete: delete only if the stored value equals ARGV[1]
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
      if (live(key) && store.get(key)!.value === token) { store.delete(key); return 1; }
      return 0;
    }),
  };
}

let interactionSeq = 0;
function makeInteraction(userId = 'user-1', id?: string) {
  return {
    // Each Discord interaction carries a unique id; mint one per call unless a
    // caller pins it (to simulate a re-delivered INTERACTION_CREATE replay).
    id: id ?? `int-${++interactionSeq}`,
    guildId: 'guild-1',
    channelId: 'ch-1',
    user: { id: userId, username: 'Tester', displayAvatarURL: () => 'url' },
    member: { id: userId },
    options: { getString: vi.fn(() => 'heads'), getInteger: vi.fn(() => 100) },
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
  } as any;
}

describe('GamesManager distributed game lock', () => {
  let valkey: ReturnType<typeof makeValkey>;

  beforeEach(() => {
    vi.clearAllMocks();
    valkey = makeValkey();
  });

  it('rejects a concurrent acquire from the same user while the first holds the lock', async () => {
    const mgr = new GamesManager(makeSupa(), valkey as any);
    const first = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(first).not.toBeNull();
    const second = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(second).toBeNull();
    // used SET NX under the hood
    expect(valkey.set).toHaveBeenCalled();
    const flags = valkey.set.mock.calls[0].map(String);
    expect(flags).toContain('NX');
    expect(flags).toContain('PX');
  });

  it('lets a different user acquire independently', async () => {
    const mgr = new GamesManager(makeSupa(), valkey as any);
    const a = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    const b = await (mgr as any).acquireGameLock('guild-1', 'user-2');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('auto-expires the lock via TTL so a crash cannot deadlock the user', async () => {
    const mgr = new GamesManager(makeSupa(), valkey as any);
    const first = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(first).not.toBeNull();
    // Simulate the holder crashing without releasing; advance past the TTL.
    valkey.tick(10 * 60 * 1000);
    const again = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(again).not.toBeNull();
  });

  it('releases only when the caller owns the lock (stale token cannot free a new owner)', async () => {
    const mgr = new GamesManager(makeSupa(), valkey as any);
    const staleToken = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(staleToken).not.toBeNull();
    // Lock expires and a fresh owner takes it.
    valkey.tick(10 * 60 * 1000);
    const freshToken = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(freshToken).not.toBeNull();
    // The stale holder's late release must NOT free the fresh owner's lock.
    await (mgr as any).releaseGameLock('guild-1', 'user-1', staleToken);
    const key = 'games:lock:guild-1:user-1';
    expect(valkey._store.has(key)).toBe(true);
    // The fresh owner's own release DOES free it.
    await (mgr as any).releaseGameLock('guild-1', 'user-1', freshToken);
    expect(valkey._store.has(key)).toBe(false);
  });

  it('falls back to the in-memory Set when Valkey is unavailable', async () => {
    // No valkey passed at all → degraded single-instance mode.
    const mgr = new GamesManager(makeSupa());
    const first = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(first).not.toBeNull();
    const second = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(second).toBeNull();
    await (mgr as any).releaseGameLock('guild-1', 'user-1', first);
    const third = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(third).not.toBeNull();
  });

  it('fails closed (denies the lock) when Valkey is configured but SET throws', async () => {
    // A transient Valkey error is ambiguous: the NX may have applied
    // server-side, or an earlier acquire (recorded only in Valkey) may still be
    // live.  Falling back to the in-memory Set would double-grant or orphan the
    // remote key, so a configured-Valkey manager must deny instead of degrade.
    valkey.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const mgr = new GamesManager(makeSupa(), valkey as any);
    const first = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(first).toBeNull();
  });

  it('does not grant a local lock when Valkey already holds one and a later SET throws', async () => {
    // Mixed healthy→degraded (codex P2 finding, games-manager.ts:216):
    // T1 acquires successfully via Valkey; the token is recorded ONLY remotely.
    // T2 arrives while Valkey is momentarily unreachable.  If the fallback
    // consulted the (empty) in-memory Set it would grant a second concurrent
    // lock and reintroduce the daily-loss TOCTOU.  It must fail closed.
    const mgr = new GamesManager(makeSupa(), valkey as any);
    const first = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(first).not.toBeNull(); // recorded only in Valkey, not activeGames
    valkey.set.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const second = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(second).toBeNull(); // no second concurrent lock
    // The in-memory Set was never used, so it holds no key for this user.
    expect((mgr as any).activeGames.has('games:lock:guild-1:user-1')).toBe(false);
  });

  it('does not orphan the remote key: an ambiguous SET failure yields no local token', async () => {
    // Ambiguous SET (codex P2 finding, games-manager.ts:211): the NX applied on
    // the server but the client saw a drop.  Returning IN_MEMORY_TOKEN would
    // make release skip the Lua delete, orphaning the remote key until its TTL.
    // Simulate: the key is already set in Valkey, then the client's SET throws.
    (valkey as any)._store.set('games:lock:guild-1:user-1', { value: 'server-side-token', expireAt: null });
    valkey.set.mockRejectedValueOnce(new Error('socket hang up'));
    const mgr = new GamesManager(makeSupa(), valkey as any);
    const token = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(token).toBeNull(); // never an IN_MEMORY_TOKEN
    // Release with the (null) token is a no-op and does not disturb the remote key.
    await (mgr as any).releaseGameLock('guild-1', 'user-1', token);
    expect((valkey as any)._store.has('games:lock:guild-1:user-1')).toBe(true);
    // eval (the Lua delete) was never invoked for a fail-closed acquire.
    expect(valkey.eval).not.toHaveBeenCalled();
  });

  it('validateBet acquires the lock and rejects a second concurrent game command', async () => {
    const mgr = new GamesManager(makeSupa(), valkey as any);
    const i1 = makeInteraction();
    const v1 = await (mgr as any).validateBet(i1, 100, 'economy_coinflip_max_bet');
    expect(v1).not.toBeNull();
    const i2 = makeInteraction();
    const v2 = await (mgr as any).validateBet(i2, 100, 'economy_coinflip_max_bet');
    expect(v2).toBeNull();
    expect(i2.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('game in progress') }),
    );
    // After the first releases, a new command can proceed.
    await v1.unlock();
    const i3 = makeInteraction();
    const v3 = await (mgr as any).validateBet(i3, 100, 'economy_coinflip_max_bet');
    expect(v3).not.toBeNull();
    await v3.unlock();
  });

  it('idempotency fence: a re-delivered interaction id (same id) is refused after the first bet released', async () => {
    const mgr = new GamesManager(makeSupa(), valkey as any);
    // First bet with a fixed interaction id resolves and releases the lock.
    const i1 = makeInteraction('user-1', 'dup-int-1');
    await mgr.coinflip(i1, 100);
    expect(valkey._store.has('games:lock:guild-1:user-1')).toBe(false);
    // The idempotency claim persists past the lock release.
    expect(valkey._store.has('games:idem:dup-int-1')).toBe(true);
    // A re-delivery of the SAME interaction id must not run a second bet: the
    // lock is free (so it wouldn't stop it), but validateBet's claim refuses it.
    const i2 = makeInteraction('user-1', 'dup-int-1');
    const v2 = await (mgr as any).validateBet(i2, 100, 'economy_coinflip_max_bet');
    expect(v2).toBeNull();
    expect(i2.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('already processed') }),
    );
    // A different interaction id for the same user still proceeds.
    const i3 = makeInteraction('user-1', 'fresh-int-2');
    const v3 = await (mgr as any).validateBet(i3, 100, 'economy_coinflip_max_bet');
    expect(v3).not.toBeNull();
    await v3.unlock();
  });

  it('coinflip releases the lock on the happy path (win or lose)', async () => {
    const mgr = new GamesManager(makeSupa(), valkey as any);
    const i1 = makeInteraction();
    await mgr.coinflip(i1, 100);
    // Lock must be free afterwards so the next command is not blocked.
    const key = 'games:lock:guild-1:user-1';
    expect(valkey._store.has(key)).toBe(false);
    const after = await (mgr as any).acquireGameLock('guild-1', 'user-1');
    expect(after).not.toBeNull();
  });

  it('coinflip releases the lock even when the game throws', async () => {
    const mgr = new GamesManager(makeSupa(), valkey as any);
    const i1 = makeInteraction();
    // Force the reply to throw partway so the finally block is exercised.
    i1.reply = vi.fn().mockRejectedValue(new Error('discord down'));
    await expect(mgr.coinflip(i1, 100)).rejects.toThrow();
    const key = 'games:lock:guild-1:user-1';
    expect(valkey._store.has(key)).toBe(false);
  });
});
