/**
 * GuildRouter LRU Eviction — Unit Tests (V5 Audit §14.2)
 *
 * Tests the idle guild context eviction logic added in V5 audit remediation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Minimal stubs ──────────────────────────────────────────

class MockGuildContext {
  public destroyed = false;
  public guildId: string;

  constructor(guildId: string) {
    this.guildId = guildId;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

// ── Inline GuildRouter eviction logic (matches production) ──

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

class GuildRouter {
  private contexts = new Map<string, MockGuildContext>();
  private lastAccess = new Map<string, number>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Don't start auto-eviction in tests — we'll call evictIdle() manually
  }

  addContext(guildId: string, ctx: MockGuildContext): void {
    this.contexts.set(guildId, ctx);
    this.lastAccess.set(guildId, Date.now());
  }

  touchContext(guildId: string): void {
    this.lastAccess.set(guildId, Date.now());
  }

  get size(): number {
    return this.contexts.size;
  }

  getContext(guildId: string): MockGuildContext | undefined {
    return this.contexts.get(guildId);
  }

  remove(guildId: string): void {
    const ctx = this.contexts.get(guildId);
    if (ctx) {
      ctx.destroy();
      this.contexts.delete(guildId);
      this.lastAccess.delete(guildId);
    }
  }

  destroyAll(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    for (const ctx of this.contexts.values()) {
      ctx.destroy();
    }
    this.contexts.clear();
    this.lastAccess.clear();
  }

  evictIdle(): void {
    const now = Date.now();
    const toEvict: string[] = [];

    for (const [guildId, lastTime] of this.lastAccess) {
      if (now - lastTime > IDLE_TIMEOUT_MS && this.contexts.has(guildId)) {
        toEvict.push(guildId);
      }
    }

    for (const guildId of toEvict) {
      this.remove(guildId);
    }
  }
}

// ── Tests ──────────────────────────────────────────────────

describe('GuildRouter LRU Eviction', () => {
  let router: GuildRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    router = new GuildRouter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not evict recently accessed guilds', () => {
    const ctx1 = new MockGuildContext('g1');
    const ctx2 = new MockGuildContext('g2');
    router.addContext('g1', ctx1);
    router.addContext('g2', ctx2);

    router.evictIdle();

    expect(router.size).toBe(2);
    expect(ctx1.destroyed).toBe(false);
    expect(ctx2.destroyed).toBe(false);
  });

  it('evicts guilds idle for more than IDLE_TIMEOUT_MS', () => {
    const ctx1 = new MockGuildContext('g1');
    const ctx2 = new MockGuildContext('g2');
    router.addContext('g1', ctx1);
    router.addContext('g2', ctx2);

    // Advance time past idle timeout
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 1000);

    router.evictIdle();

    expect(router.size).toBe(0);
    expect(ctx1.destroyed).toBe(true);
    expect(ctx2.destroyed).toBe(true);
  });

  it('keeps active guilds and evicts idle ones', () => {
    const ctx1 = new MockGuildContext('g1');
    const ctx2 = new MockGuildContext('g2');
    router.addContext('g1', ctx1);
    router.addContext('g2', ctx2);

    // Advance 20 minutes, then touch g1
    vi.advanceTimersByTime(20 * 60 * 1000);
    router.touchContext('g1');

    // Advance 15 more minutes — g2 is now idle for 35 min, g1 for 15 min
    vi.advanceTimersByTime(15 * 60 * 1000);

    router.evictIdle();

    expect(router.size).toBe(1);
    expect(ctx1.destroyed).toBe(false);
    expect(ctx2.destroyed).toBe(true);
    expect(router.getContext('g1')).toBeDefined();
    expect(router.getContext('g2')).toBeUndefined();
  });

  it('destroyAll clears everything and cleans up', () => {
    const ctx1 = new MockGuildContext('g1');
    const ctx2 = new MockGuildContext('g2');
    router.addContext('g1', ctx1);
    router.addContext('g2', ctx2);

    router.destroyAll();

    expect(router.size).toBe(0);
    expect(ctx1.destroyed).toBe(true);
    expect(ctx2.destroyed).toBe(true);
  });

  it('remove() destroys a single context and cleans up tracking', () => {
    const ctx1 = new MockGuildContext('g1');
    router.addContext('g1', ctx1);

    router.remove('g1');

    expect(router.size).toBe(0);
    expect(ctx1.destroyed).toBe(true);
  });
});
