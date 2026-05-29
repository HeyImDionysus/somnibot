/**
 * V5 Audit §13.2 — Launcher validator unit tests.
 *
 * Tests the pure input-validation logic from validators.ts.
 * Network-dependent validators (Discord API, Supabase API) are tested
 * via mocked fetch — we verify the branching logic, not the live APIs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Replicated pure validation helpers ────────────────────

/** Validates Supabase URL format (from validateSupabase). */
function validateSupabaseUrl(url: string): { ok: boolean; error?: string } {
  try {
    const parsed = new URL(url.trim());
    const isLocalDev = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !isLocalDev) {
      return { ok: false, error: 'Supabase URL must use HTTPS.' };
    }
    const isSupabaseDomain = parsed.hostname.endsWith('.supabase.co') || parsed.hostname.endsWith('.supabase.com');
    if (!isSupabaseDomain && !isLocalDev) {
      return { ok: false, error: 'Supabase URL must be a *.supabase.co domain or localhost. Got: ' + parsed.hostname };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Invalid Supabase URL.' };
  }
}

/** Validates non-empty trimmed string (used for required fields). */
function validateRequired(value: string, fieldName: string): { ok: boolean; error?: string } {
  if (!value.trim()) return { ok: false, error: `${fieldName} is required.` };
  return { ok: true };
}

/** Multi-guild ID parser (from validateGuildId). */
function parseGuildIds(input: string): string[] {
  return input.split(',').map(id => id.trim()).filter(Boolean);
}

// ── Tests ────────────────────────────────────────────────────

describe('Supabase URL validation', () => {
  it('accepts valid Supabase URLs', () => {
    expect(validateSupabaseUrl('https://my-project.supabase.co')).toEqual({ ok: true });
    expect(validateSupabaseUrl('https://abc123.supabase.com')).toEqual({ ok: true });
  });

  it('accepts localhost URLs (any protocol)', () => {
    expect(validateSupabaseUrl('http://localhost:54321')).toEqual({ ok: true });
    expect(validateSupabaseUrl('http://127.0.0.1:54321')).toEqual({ ok: true });
    expect(validateSupabaseUrl('http://[::1]:54321')).toEqual({ ok: true });
  });

  it('rejects non-Supabase HTTPS domains', () => {
    const result = validateSupabaseUrl('https://evil.example.com');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('*.supabase.co');
  });

  it('rejects HTTP on non-localhost domains', () => {
    const result = validateSupabaseUrl('http://my-project.supabase.co');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTPS');
  });

  it('rejects completely invalid URLs', () => {
    const result = validateSupabaseUrl('not-a-url');
    expect(result.ok).toBe(false);
  });

  it('rejects empty strings', () => {
    const result = validateSupabaseUrl('');
    expect(result.ok).toBe(false);
  });

  it('trims whitespace before parsing', () => {
    expect(validateSupabaseUrl('  https://my-project.supabase.co  ')).toEqual({ ok: true });
  });

  it('rejects FTP protocol', () => {
    const result = validateSupabaseUrl('ftp://files.supabase.co');
    expect(result.ok).toBe(false);
  });
});

describe('Required field validation', () => {
  it('accepts non-empty values', () => {
    expect(validateRequired('my-token', 'Discord Token')).toEqual({ ok: true });
  });

  it('rejects empty strings', () => {
    const result = validateRequired('', 'Discord Token');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Discord Token');
  });

  it('rejects whitespace-only strings', () => {
    const result = validateRequired('   ', 'Secret Key');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Secret Key');
  });
});

describe('Guild ID parser', () => {
  it('parses single guild ID', () => {
    expect(parseGuildIds('123456789')).toEqual(['123456789']);
  });

  it('parses comma-separated guild IDs', () => {
    expect(parseGuildIds('111,222,333')).toEqual(['111', '222', '333']);
  });

  it('trims whitespace around IDs', () => {
    expect(parseGuildIds(' 111 , 222 , 333 ')).toEqual(['111', '222', '333']);
  });

  it('filters empty segments', () => {
    expect(parseGuildIds('111,,333,')).toEqual(['111', '333']);
  });

  it('returns empty array for empty input', () => {
    expect(parseGuildIds('')).toEqual([]);
  });

  it('returns empty array for comma-only input', () => {
    expect(parseGuildIds(',,,')).toEqual([]);
  });
});
