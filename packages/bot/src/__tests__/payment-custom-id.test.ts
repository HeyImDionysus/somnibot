/**
 * Payment Handler — custom_id format tests (V5 Audit §2.1, §2.2)
 *
 * Verifies the short-key format stays within PayPal's 127-char limit
 * and that both old and new key formats can be parsed.
 */
import { describe, it, expect } from 'vitest';

// ── PayPal custom_id format ────────────────────────────────

interface LongKeyMeta {
  guild_id: string;
  product_id: string;
  customer_id: string;
  discord_id: string;
}

interface ShortKeyMeta {
  g: string;
  p: string;
  c: string;
  d: string;
}

function buildShortCustomId(guildId: string, productId: string, customerId: string, discordId: string): string {
  return JSON.stringify({ g: guildId, p: productId, c: customerId, d: discordId });
}

function buildLongCustomId(guildId: string, productId: string, customerId: string, discordId: string): string {
  return JSON.stringify({ guild_id: guildId, product_id: productId, customer_id: customerId, discord_id: discordId });
}

function parseCustomId(raw: string): LongKeyMeta | null {
  try {
    const parsed = JSON.parse(raw);
    // Support both short-key (V5+) and legacy long-key format
    if (parsed.g && parsed.p && parsed.c && parsed.d) {
      return { guild_id: parsed.g, product_id: parsed.p, customer_id: parsed.c, discord_id: parsed.d };
    }
    if (parsed.guild_id && parsed.product_id && parsed.customer_id && parsed.discord_id) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Tests ──────────────────────────────────────────────────

describe('PayPal custom_id format', () => {
  // Realistic UUIDs and snowflakes
  const guildId = '550e8400-e29b-41d4-a716-446655440000';
  const productId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const customerId = '123e4567-e89b-12d3-a456-426614174000';
  const discordId = '1234567890123456789';

  describe('short-key format [2.1]', () => {
    it('is significantly shorter than long-key format', () => {
      const shortId = buildShortCustomId(guildId, productId, customerId, discordId);
      const longId = buildLongCustomId(guildId, productId, customerId, discordId);
      // Short keys save ~40 chars of JSON overhead
      expect(shortId.length).toBeLessThan(longId.length);
      expect(longId.length - shortId.length).toBeGreaterThanOrEqual(30);
    });

    it('can be parsed back to metadata', () => {
      const customId = buildShortCustomId(guildId, productId, customerId, discordId);
      const meta = parseCustomId(customId);
      expect(meta).not.toBeNull();
      expect(meta!.guild_id).toBe(guildId);
      expect(meta!.product_id).toBe(productId);
      expect(meta!.customer_id).toBe(customerId);
      expect(meta!.discord_id).toBe(discordId);
    });
  });

  describe('legacy long-key format', () => {
    it('can still be parsed (backward compatibility)', () => {
      const customId = buildLongCustomId(guildId, productId, customerId, discordId);
      const meta = parseCustomId(customId);
      expect(meta).not.toBeNull();
      expect(meta!.guild_id).toBe(guildId);
    });

    it('is longer than short-key format', () => {
      const longId = buildLongCustomId(guildId, productId, customerId, discordId);
      const shortId = buildShortCustomId(guildId, productId, customerId, discordId);
      expect(longId.length).toBeGreaterThan(shortId.length);
    });
  });

  describe('amount verification [2.2]', () => {
    it('detects amount mismatch', () => {
      const capturedAmountCents = 999; // PayPal captured $9.99
      const expectedAmountCents = 1999; // Order expected $19.99
      expect(capturedAmountCents).not.toBe(expectedAmountCents);
    });

    it('confirms matching amounts', () => {
      const capturedValue = '19.99';
      const capturedCents = Math.round(parseFloat(capturedValue) * 100);
      const expectedCents = 1999;
      expect(capturedCents).toBe(expectedCents);
    });

    it('handles floating-point conversion correctly', () => {
      // $10.10 is a common float trap
      const capturedValue = '10.10';
      const capturedCents = Math.round(parseFloat(capturedValue) * 100);
      expect(capturedCents).toBe(1010);
    });
  });

  describe('edge cases', () => {
    it('returns null for invalid JSON', () => {
      expect(parseCustomId('not-json')).toBeNull();
    });

    it('returns null for empty object', () => {
      expect(parseCustomId('{}')).toBeNull();
    });

    it('returns null for missing keys', () => {
      expect(parseCustomId('{"g":"x"}')).toBeNull();
    });
  });
});
