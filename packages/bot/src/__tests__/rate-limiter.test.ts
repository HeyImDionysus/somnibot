/**
 * Rate Limiter — Unit Tests
 *
 * Tests AutomationRateLimiter with a mock Valkey instance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutomationRateLimiter } from '../features/automations/rate-limiter.js';

// ── Mock Valkey ────────────────────────────────────────────

function createMockValkey() {
  const store = new Map<string, { value: number; expiresAt: number }>();

  return {
    incr: vi.fn(async (key: string) => {
      const existing = store.get(key);
      if (existing && existing.expiresAt > Date.now()) {
        existing.value++;
        return existing.value;
      }
      store.set(key, { value: 1, expiresAt: Infinity });
      return 1;
    }),
    expire: vi.fn(async (_key: string, _seconds: number) => {}),
    exists: vi.fn(async (key: string) => {
      const existing = store.get(key);
      return existing && existing.expiresAt > Date.now() ? 1 : 0;
    }),
    setex: vi.fn(async (key: string, seconds: number, _value: string) => {
      store.set(key, { value: 1, expiresAt: Date.now() + seconds * 1000 });
    }),
  } as any;
}

// ════════════════════════════════════════════════════════════

describe('AutomationRateLimiter', () => {
  let valkey: ReturnType<typeof createMockValkey>;
  let limiter: AutomationRateLimiter;

  beforeEach(() => {
    valkey = createMockValkey();
    limiter = new AutomationRateLimiter(valkey);
  });

  describe('allowFire', () => {
    it('allows first fire', async () => {
      expect(await limiter.allowFire('g1', 'u1')).toBe(true);
    });

    it('allows up to the per-minute limit (5)', async () => {
      for (let i = 0; i < 5; i++) {
        expect(await limiter.allowFire('g1', 'u1')).toBe(true);
      }
    });

    it('rejects after exceeding limit', async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.allowFire('g1', 'u1');
      }
      expect(await limiter.allowFire('g1', 'u1')).toBe(false);
    });

    it('tracks different users independently', async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.allowFire('g1', 'u1');
      }
      expect(await limiter.allowFire('g1', 'u1')).toBe(false);
      expect(await limiter.allowFire('g1', 'u2')).toBe(true);
    });

    it('tracks different guilds independently', async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.allowFire('g1', 'u1');
      }
      expect(await limiter.allowFire('g1', 'u1')).toBe(false);
      expect(await limiter.allowFire('g2', 'u1')).toBe(true);
    });

    it('calls expire on first incr', async () => {
      await limiter.allowFire('g1', 'u1');
      expect(valkey.expire).toHaveBeenCalledWith(
        expect.stringContaining('fire:g1:u1'),
        60,
      );
    });
  });

  describe('allowDM', () => {
    it('allows first DM', async () => {
      expect(await limiter.allowDM('g1', 'auto1', 'u1')).toBe(true);
    });

    it('rejects second DM within cooldown', async () => {
      await limiter.allowDM('g1', 'auto1', 'u1');
      expect(await limiter.allowDM('g1', 'auto1', 'u1')).toBe(false);
    });

    it('allows DM for different automation', async () => {
      await limiter.allowDM('g1', 'auto1', 'u1');
      expect(await limiter.allowDM('g1', 'auto2', 'u1')).toBe(true);
    });

    it('allows DM for different user', async () => {
      await limiter.allowDM('g1', 'auto1', 'u1');
      expect(await limiter.allowDM('g1', 'auto1', 'u2')).toBe(true);
    });
  });

  describe('allowCustom', () => {
    it('allows up to custom limit', async () => {
      for (let i = 0; i < 3; i++) {
        expect(await limiter.allowCustom('g1', 'a1', 'u1', 3, 120)).toBe(true);
      }
    });

    it('rejects after custom limit', async () => {
      for (let i = 0; i < 3; i++) {
        await limiter.allowCustom('g1', 'a1', 'u1', 3, 120);
      }
      expect(await limiter.allowCustom('g1', 'a1', 'u1', 3, 120)).toBe(false);
    });

    it('sets custom window expiry', async () => {
      await limiter.allowCustom('g1', 'a1', 'u1', 5, 300);
      expect(valkey.expire).toHaveBeenCalledWith(
        expect.stringContaining('custom:g1:a1:u1'),
        300,
      );
    });
  });
});
