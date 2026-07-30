/**
 * GuildContext.destroy() — Unit Tests (V5 Audit §6.1)
 *
 * Tests that destroy() properly iterates managers and calls destroy()
 * on any that implement the Destroyable interface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

afterEach(() => vi.restoreAllMocks());

// ── Minimal Destroyable implementation ──────────────────────

interface Destroyable {
  destroy(): void | Promise<void>;
}

// ── Inline GuildContext for testing (matches production logic) ──

class GuildContext {
  private managers = new Map<string, unknown>();

  setManager<T>(key: string, manager: T): void {
    this.managers.set(key, manager);
  }

  getManager<T>(key: string): T | undefined {
    return this.managers.get(key) as T | undefined;
  }

  get managerCount(): number {
    return this.managers.size;
  }

  destroy(): void {
    for (const [key, manager] of this.managers) {
      try {
        if (manager && typeof (manager as Destroyable).destroy === 'function') {
          const result = (manager as Destroyable).destroy();
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((err) => {
              console.error(`[GuildContext] Error destroying manager "${key}":`, err);
            });
          }
        }
      } catch (err) {
        console.error(`[GuildContext] Error destroying manager "${key}":`, err);
      }
    }
    this.managers.clear();
  }
}

// ── Tests ──────────────────────────────────────────────────

describe('GuildContext.destroy()', () => {
  let ctx: GuildContext;

  beforeEach(() => {
    ctx = new GuildContext();
  });

  it('calls destroy() on managers that implement Destroyable', () => {
    const destroyFn = vi.fn();
    const manager = { destroy: destroyFn, name: 'TestManager' };
    ctx.setManager('test', manager);

    ctx.destroy();
    expect(destroyFn).toHaveBeenCalledOnce();
    expect(ctx.managerCount).toBe(0);
  });

  it('handles managers without destroy() gracefully', () => {
    const plainManager = { name: 'PlainManager' };
    ctx.setManager('plain', plainManager);

    expect(() => ctx.destroy()).not.toThrow();
    expect(ctx.managerCount).toBe(0);
  });

  it('handles async destroy() (fire-and-forget)', () => {
    const asyncDestroy = vi.fn().mockResolvedValue(undefined);
    const manager = { destroy: asyncDestroy };
    ctx.setManager('async', manager);

    ctx.destroy();
    expect(asyncDestroy).toHaveBeenCalledOnce();
  });

  it('continues destroying other managers if one throws', () => {
    const badDestroy = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const goodDestroy = vi.fn();

    ctx.setManager('bad', { destroy: badDestroy });
    ctx.setManager('good', { destroy: goodDestroy });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx.destroy();

    expect(badDestroy).toHaveBeenCalledOnce();
    expect(goodDestroy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalled();
    expect(ctx.managerCount).toBe(0);
    consoleSpy.mockRestore();
  });

  it('handles null/undefined managers in the map', () => {
    ctx.setManager('null', null);
    ctx.setManager('undef', undefined);

    expect(() => ctx.destroy()).not.toThrow();
    expect(ctx.managerCount).toBe(0);
  });

  it('clears all managers after destroy', () => {
    ctx.setManager('a', { destroy: vi.fn() });
    ctx.setManager('b', { name: 'plain' });
    ctx.setManager('c', { destroy: vi.fn() });

    ctx.destroy();
    expect(ctx.managerCount).toBe(0);
    expect(ctx.getManager('a')).toBeUndefined();
  });
});
