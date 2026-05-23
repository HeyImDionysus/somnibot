/**
 * Dashboard API Route Validation — Unit Tests (V5 Audit §13.2)
 *
 * Tests input validation, limit capping, and sanitization logic
 * used across API routes.
 */
import { describe, it, expect } from 'vitest';

// ── Inline sanitizeSearch (matches production) ─────────────

function sanitizeSearch(input: string): string {
  // Strip PostgREST metacharacters: , . ( ) * % \
  let sanitized = input.replace(/[,.()*%\\]/g, '');
  sanitized = sanitized.trim();
  // Cap length
  if (sanitized.length > 200) {
    sanitized = sanitized.slice(0, 200);
  }
  return sanitized;
}

// ── Inline limit capping logic (V5 Audit §7.1) ────────────

function capLimit(raw: string | null, defaultVal = 50, max = 200): number {
  const parsed = parseInt(raw ?? String(defaultVal), 10);
  return Math.min(Math.max(1, isNaN(parsed) ? defaultVal : parsed), max);
}

function capOffset(raw: string | null): number {
  const parsed = parseInt(raw ?? '0', 10);
  return Math.max(0, isNaN(parsed) ? 0 : parsed);
}

// ── Tests ──────────────────────────────────────────────────

describe('sanitizeSearch()', () => {
  it('strips PostgREST metacharacters', () => {
    expect(sanitizeSearch('test.user(admin)*')).toBe('testuseradmin');
  });

  it('strips percent signs (prevents LIKE injection)', () => {
    expect(sanitizeSearch('%admin%')).toBe('admin');
  });

  it('strips backslashes', () => {
    expect(sanitizeSearch('test\\escape')).toBe('testescape');
  });

  it('trims whitespace', () => {
    expect(sanitizeSearch('  hello  ')).toBe('hello');
  });

  it('caps at 200 characters', () => {
    const long = 'a'.repeat(300);
    expect(sanitizeSearch(long).length).toBe(200);
  });

  it('preserves normal search terms', () => {
    expect(sanitizeSearch('john_doe')).toBe('john_doe');
    expect(sanitizeSearch('user123')).toBe('user123');
  });

  it('handles empty input', () => {
    expect(sanitizeSearch('')).toBe('');
    expect(sanitizeSearch('   ')).toBe('');
  });

  it('handles commas (PostgREST OR separator)', () => {
    expect(sanitizeSearch('admin,user')).toBe('adminuser');
  });
});

describe('capLimit() [V5 Audit §7.1]', () => {
  it('defaults to 50', () => {
    expect(capLimit(null)).toBe(50);
  });

  it('caps at 200', () => {
    expect(capLimit('999999')).toBe(200);
  });

  it('enforces minimum of 1', () => {
    expect(capLimit('0')).toBe(1);
    expect(capLimit('-5')).toBe(1);
  });

  it('parses valid limits', () => {
    expect(capLimit('25')).toBe(25);
    expect(capLimit('100')).toBe(100);
    expect(capLimit('200')).toBe(200);
  });

  it('handles non-numeric input', () => {
    expect(capLimit('abc')).toBe(50); // Falls back to default
  });
});

describe('capOffset()', () => {
  it('defaults to 0', () => {
    expect(capOffset(null)).toBe(0);
  });

  it('prevents negative offsets', () => {
    expect(capOffset('-10')).toBe(0);
  });

  it('parses valid offsets', () => {
    expect(capOffset('50')).toBe(50);
    expect(capOffset('0')).toBe(0);
  });

  it('handles non-numeric input', () => {
    expect(capOffset('abc')).toBe(0);
  });
});
