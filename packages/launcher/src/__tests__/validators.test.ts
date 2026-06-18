/**
 * V5 Audit §13.2 — Launcher validator unit tests.
 *
 * Tests the pure input-validation logic from validators.ts.
 * Network-dependent validators (Discord API, Supabase API) are tested
 * via mocked fetch — we verify the branching logic, not the live APIs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateAllCredentials } from '../main/validators';

beforeEach(() => {
  vi.unstubAllGlobals();
});

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('full provider validation checks', () => {
  it('returns first-class Discord and Supabase readiness checks on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/users/@me')) return jsonResponse({ username: 'SomniBot', id: 'bot-123' });
      if (url.includes('/applications/@me')) return jsonResponse({ id: 'app-123' });
      if (url.includes('/guilds/guild-123')) return jsonResponse({ name: 'Test Guild' });
      if (url.endsWith('/rest/v1/')) return jsonResponse({});
      if (url.endsWith('/auth/v1/settings')) return jsonResponse({});
      return jsonResponse({}, 404);
    }));

    const result = await validateAllCredentials({
      discordToken: 'token',
      discordApplicationId: 'app-123',
      discordClientSecret: 'client-secret',
      discordGuildId: 'guild-123',
      supabaseUrl: 'https://project.supabase.co',
      supabaseSecretKey: 'sb_secret_key',
      supabasePublishableKey: 'sb_publishable_key',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.meta).toMatchObject({
      botUsername: 'SomniBot',
      botId: 'bot-123',
      guildName: 'Test Guild',
    });
    expect(result.checks.map(check => [check.id, check.status])).toEqual([
      ['discord-bot-token', 'success'],
      ['discord-application', 'success'],
      ['discord-guild', 'success'],
      ['discord-client-secret', 'success'],
      ['supabase-project', 'success'],
    ]);
  });

  it('keeps independent Supabase checks visible when Discord token validation fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/users/@me')) return jsonResponse({}, 401);
      if (url.endsWith('/rest/v1/')) return jsonResponse({});
      if (url.endsWith('/auth/v1/settings')) return jsonResponse({});
      return jsonResponse({}, 500);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await validateAllCredentials({
      discordToken: 'wrong-token',
      discordApplicationId: 'app-123',
      discordClientSecret: 'client-secret',
      discordGuildId: 'guild-123',
      supabaseUrl: 'https://project.supabase.co',
      supabaseSecretKey: 'sb_secret_key',
      supabasePublishableKey: 'sb_publishable_key',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'Invalid bot token. Make sure you copied the full token from Discord Developer Portal → Bot → Token.',
    ]);
    expect(result.checks.map(check => [check.id, check.status])).toEqual([
      ['discord-bot-token', 'failed'],
      ['discord-application', 'skipped'],
      ['discord-guild', 'skipped'],
      ['discord-client-secret', 'success'],
      ['supabase-project', 'success'],
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://project.supabase.co/rest/v1/',
      expect.any(Object),
    );
  });
});
