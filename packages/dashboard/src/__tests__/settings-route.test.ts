/**
 * Tests for PUT /api/settings — settings write endpoint.
 *
 * Covers the V10 §6 batched upsert fix (sequential → single operation)
 * and the existing validation, auth, and rate-limiting contracts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn().mockResolvedValue(undefined) }));

import { PUT } from '@/app/api/settings/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { notifyBot } from '@/lib/notify-bot';

import {
  createMockSupabase,
  buildRequest,
  mockAuthSuccess,
  mockAuthUnauthorized,
  mockRateLimited,
  mockRateLimitPass,
} from './helpers';

const mock = createMockSupabase();

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
});

function putSettings(body: unknown) {
  return PUT(buildRequest('/api/settings', { method: 'PUT', body }) as never);
}

describe('PUT /api/settings', () => {
  it('returns 429 when rate limited', async () => {
    mockRateLimited(checkAdminRateLimit as ReturnType<typeof vi.fn>);

    const res = await putSettings({ section: 'discord', values: { guild_id: '123' } });
    expect(res.status).toBe(429);
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthUnauthorized(requireGuildOwner as ReturnType<typeof vi.fn>);

    const res = await putSettings({ section: 'discord', values: { guild_id: '123' } });
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing section', async () => {
    const res = await putSettings({ values: { key: 'val' } });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing values', async () => {
    const res = await putSettings({ section: 'discord' });
    expect(res.status).toBe(400);
  });

  it('upserts all values in a single batch call', async () => {
    mock._query.upsert.mockResolvedValue({ error: null });

    const res = await putSettings({
      section: 'discord',
      values: {
        discord_guild_id: '111222333',
        discord_application_id: '444555666',
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // V10 §6: Should be ONE upsert call with both rows, not two sequential calls
    expect(mock._query.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = mock._query.upsert.mock.calls[0][0];
    expect(upsertArg).toHaveLength(2);
    expect(upsertArg[0]).toMatchObject({ key: 'discord_guild_id', value: '111222333', section: 'discord' });
    expect(upsertArg[1]).toMatchObject({ key: 'discord_application_id', value: '444555666', section: 'discord' });
  });

  it('filters out masked values (••••) — does not overwrite secrets with mask', async () => {
    mock._query.upsert.mockResolvedValue({ error: null });

    const res = await putSettings({
      section: 'discord',
      values: {
        discord_guild_id: '111222333',
        discord_bot_token: '••••••••abcd', // masked — should be skipped
      },
    });

    expect(res.status).toBe(200);
    expect(mock._query.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = mock._query.upsert.mock.calls[0][0];
    expect(upsertArg).toHaveLength(1);
    expect(upsertArg[0].key).toBe('discord_guild_id');
  });

  it('filters out empty-string values', async () => {
    mock._query.upsert.mockResolvedValue({ error: null });

    const res = await putSettings({
      section: 'discord',
      values: {
        discord_guild_id: '111222333',
        discord_application_id: '   ', // blank — should be skipped
      },
    });

    expect(res.status).toBe(200);
    const upsertArg = mock._query.upsert.mock.calls[0][0];
    expect(upsertArg).toHaveLength(1);
  });

  it('skips upsert entirely when all values are masked or empty', async () => {
    const res = await putSettings({
      section: 'discord',
      values: {
        discord_bot_token: '••••••••abcd',
        discord_client_secret: '',
      },
    });

    expect(res.status).toBe(200);
    expect(mock._query.upsert).not.toHaveBeenCalled();
  });

  it('notifies bot after successful save', async () => {
    mock._query.upsert.mockResolvedValue({ error: null });

    await putSettings({ section: 'lavalink', values: { lavalink_host: '10.0.0.1' } });

    expect(notifyBot).toHaveBeenCalledWith('settings', { section: 'lavalink' });
  });

  it('returns 500 when upsert throws', async () => {
    mock._query.upsert.mockRejectedValue(new Error('DB connection lost'));

    const res = await putSettings({
      section: 'discord',
      values: { discord_guild_id: '123' },
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Failed to save');
  });
});
