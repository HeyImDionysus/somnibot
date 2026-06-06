/**
 * Tests for /api/setup first-run finalization behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/auto-config', () => ({ ensureDiscordAuthProvider: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));

import { createClient } from '@supabase/supabase-js';
import { POST } from '@/app/api/setup/route';
import { ensureDiscordAuthProvider } from '@/lib/supabase/auto-config';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

import {
  buildRequest,
  createMockSupabase,
  mockRateLimitPass,
} from './helpers';

describe('POST /api/setup finalize', () => {
  const originalEnv = { ...process.env };
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
    };
    mock = createMockSupabase();
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('does not lock setup when Discord auth auto-config fails', async () => {
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'SUPABASE_ACCESS_TOKEN not set',
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: { action: 'finalize' },
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: 'SUPABASE_ACCESS_TOKEN not set',
      authConfigured: false,
      authError: 'SUPABASE_ACCESS_TOKEN not set',
      setupLocked: false,
    });
    expect(mock._query.upsert).not.toHaveBeenCalled();
  });

  it('locks setup only after Discord auth is configured', async () => {
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: true,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: { action: 'finalize' },
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      authConfigured: true,
      authError: null,
      setupLocked: true,
    });
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'setup_completed_at',
        section: 'system',
      }),
      { onConflict: 'key' },
    );
  });

  it('passes a submitted Supabase access token into auth auto-config before locking setup', async () => {
    (ensureDiscordAuthProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyConfigured: false,
    });

    const res = await POST(buildRequest('/api/setup', {
      method: 'POST',
      body: {
        action: 'finalize',
        credentials: {
          supabase_access_token: 'setup-provided-token',
        },
      },
    }));

    expect(res.status).toBe(200);
    expect(ensureDiscordAuthProvider).toHaveBeenCalledWith({
      accessToken: 'setup-provided-token',
    });
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'supabase_access_token',
        value: 'setup-provided-token',
        section: 'supabase',
      }),
      { onConflict: 'key' },
    );
    expect(mock._query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'setup_completed_at',
        section: 'system',
      }),
      { onConflict: 'key' },
    );
  });
});
