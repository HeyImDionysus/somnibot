/**
 * Tests for /api/settings — authoritative settings read/write contract.
 *
 * Covers the V10 §6 batched upsert fix (sequential → single operation)
 * and the existing validation, auth, and rate-limiting contracts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/discord-runtime-config', () => ({ getDiscordOAuthRuntimeConfig: vi.fn() }));
vi.mock('@/lib/installation-runtime-secret', () => ({ getInstallationRuntimeSecret: vi.fn() }));
vi.mock('@/lib/supabase/auto-config', () => ({ ensureDiscordAuthProvider: vi.fn() }));
vi.mock('@/app/api/webhooks/scope', () => ({
  isSoleInstanceOperator: vi.fn(),
}));

import { DELETE, GET, PUT } from '@/app/api/settings/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { notifyBot } from '@/lib/notify-bot';
import { isSoleInstanceOperator } from '@/app/api/webhooks/scope';
import { getDiscordOAuthRuntimeConfig } from '@/lib/discord-runtime-config';
import { getInstallationRuntimeSecret } from '@/lib/installation-runtime-secret';
import { ensureDiscordAuthProvider } from '@/lib/supabase/auto-config';

import {
  createMockSupabase,
  registerTable,
  buildRequest,
  mockAuthSuccess,
  mockAuthUnauthorized,
  mockRateLimited,
  mockRateLimitPass,
} from './helpers';

let mock: ReturnType<typeof createMockSupabase>;

beforeEach(() => {
  vi.resetAllMocks();
  mock = createMockSupabase();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
  vi.mocked(isSoleInstanceOperator).mockResolvedValue(true);
  vi.mocked(getDiscordOAuthRuntimeConfig).mockResolvedValue({
    applicationId: '111111111111111111',
    clientSecret: 'existing-client-secret',
    sources: { applicationId: 'saved', clientSecret: 'saved' },
  });
  vi.mocked(getInstallationRuntimeSecret).mockResolvedValue('management-access-token');
  vi.mocked(ensureDiscordAuthProvider).mockResolvedValue({ success: true });
  mock.rpc.mockImplementation(async (name: string) => ({
    data: name === 'claim_instance_settings_write_lease' || name === 'release_instance_settings_write_lease',
    error: null,
  }));
});

function putSettings(body: unknown) {
  return PUT(buildRequest('/api/settings', { method: 'PUT', body }) as never);
}

function resetSettings(body: unknown) {
  return DELETE(buildRequest('/api/settings', { method: 'DELETE', body }) as never);
}

describe('GET /api/settings', () => {
  it('returns a saved connection value as the authoritative override while retaining the env fallback', async () => {
    vi.stubEnv('DISCORD_APPLICATION_ID', '222222222222222222');
    const settings = registerTable(mock, 'instance_settings');
    settings.limit.mockResolvedValue({
      data: [{ key: 'discord_application_id', value: '333333333333333333', section: 'discord' }],
      error: null,
    });
    registerTable(mock, 'guild').single.mockResolvedValue({ data: null, error: null });

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      values: { discord_application_id: '333333333333333333' },
      sources: { discord_application_id: 'db' },
      environmentFallbacks: { discord_application_id: true },
    });
  });

  it('keeps Supabase bootstrap credentials deployment-owned even when a stale DB row exists', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://bootstrap.supabase.co');
    const settings = registerTable(mock, 'instance_settings');
    settings.limit.mockResolvedValue({
      data: [{ key: 'supabase_url', value: 'https://ignored.supabase.co', section: 'supabase' }],
      error: null,
    });
    registerTable(mock, 'guild').single.mockResolvedValue({ data: null, error: null });

    const res = await GET();

    await expect(res.json()).resolves.toMatchObject({
      values: { supabase_url: 'https://bootstrap.supabase.co' },
      sources: { supabase_url: 'env' },
      lockedFields: expect.arrayContaining(['supabase_url']),
    });
  });

  it('reports an encrypted saved secret as the authoritative source over an env fallback', async () => {
    vi.stubEnv('DISCORD_TOKEN', 'env-token');
    const settings = registerTable(mock, 'instance_settings');
    settings.limit.mockResolvedValue({
      data: [{ key: 'discord_bot_token_encrypted', value: 'encrypted-payload', section: 'discord' }],
      error: null,
    });
    registerTable(mock, 'guild').single.mockResolvedValue({ data: null, error: null });

    const res = await GET();

    await expect(res.json()).resolves.toMatchObject({
      values: { discord_bot_token: '••••••••' },
      sources: { discord_bot_token: 'db' },
      environmentFallbacks: { discord_bot_token: true },
    });
  });

  it('fails closed when authoritative saved settings cannot be loaded', async () => {
    registerTable(mock, 'instance_settings').limit.mockResolvedValue({
      data: null,
      error: { message: 'read failed' },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
    expect(registerTable(mock, 'guild').single).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

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

  it('returns 403 when a guild owner is not the sole installation operator', async () => {
    vi.mocked(isSoleInstanceOperator).mockResolvedValue(false);

    const res = await putSettings({
      section: 'discord',
      values: { discord_bot_token: 'replacement-token' },
    });

    expect(res.status).toBe(403);
    expect(mock._query.upsert).not.toHaveBeenCalled();
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
        discord_application_id: '444444444444444444',
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.restartRequired).toBe(true);

    // V10 §6: Should be ONE upsert call with both rows, not two sequential calls
    expect(mock._query.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = mock._query.upsert.mock.calls[0][0];
    expect(upsertArg).toHaveLength(2);
    expect(upsertArg[0]).toMatchObject({ key: 'discord_guild_id', value: '111222333', section: 'discord' });
    expect(upsertArg[1]).toMatchObject({ key: 'discord_application_id', value: '444444444444444444', section: 'discord' });
    expect(ensureDiscordAuthProvider).toHaveBeenCalledWith({
      accessToken: 'management-access-token',
      discordClientId: '444444444444444444',
      discordClientSecret: 'existing-client-secret',
      forceCredentialUpdate: true,
    });
  });

  it('does not persist Discord identity changes when Supabase Auth rejects them', async () => {
    vi.mocked(ensureDiscordAuthProvider)
      .mockResolvedValueOnce({ success: false, error: 'provider update denied' })
      .mockResolvedValueOnce({ success: true });

    const res = await putSettings({
      section: 'discord',
      values: { discord_application_id: '555555555555555555' },
    });

    expect(res.status).toBe(409);
    expect(mock._query.upsert).not.toHaveBeenCalled();
    expect(ensureDiscordAuthProvider).toHaveBeenNthCalledWith(2, {
      accessToken: 'management-access-token',
      discordClientId: '111111111111111111',
      discordClientSecret: 'existing-client-secret',
      forceCredentialUpdate: true,
    });
  });

  it('normalizes PayPal mode and rejects invalid runtime connection values', async () => {
    mock._query.upsert.mockResolvedValue({ error: null });

    const normalized = await putSettings({ section: 'paypal', values: { paypal_sandbox: 'no' } });
    expect(normalized.status).toBe(200);
    expect(mock._query.upsert).toHaveBeenCalledWith([
      expect.objectContaining({ key: 'paypal_sandbox', value: 'false' }),
    ], { onConflict: 'key' });

    const invalidPort = await putSettings({ section: 'lavalink', values: { lavalink_port: 'abc' } });
    expect(invalidPort.status).toBe(400);
  });

  it('rejects a malformed Discord application ID before touching Supabase Auth', async () => {
    const res = await putSettings({
      section: 'discord',
      values: { discord_application_id: 'not-a-discord-id' },
    });

    expect(res.status).toBe(400);
    expect(ensureDiscordAuthProvider).not.toHaveBeenCalled();
    expect(mock._query.upsert).not.toHaveBeenCalled();
  });

  it('returns a conflict while another Discord settings write owns the lease', async () => {
    mock.rpc.mockImplementation(async (name: string) => ({
      data: name === 'release_instance_settings_write_lease',
      error: null,
    }));

    const res = await putSettings({
      section: 'discord',
      values: { discord_application_id: '555555555555555555' },
    });

    expect(res.status).toBe(409);
    expect(ensureDiscordAuthProvider).not.toHaveBeenCalled();
    expect(mock._query.upsert).not.toHaveBeenCalled();
  });

  it('rejects launcher-only or unknown secret keys instead of writing them as plaintext', async () => {
    const res = await putSettings({
      section: 'deployment',
      values: { vps_nextauth_secret: 'must-not-be-written' },
    });

    expect(res.status).toBe(400);
    expect(mock._query.upsert).not.toHaveBeenCalled();
  });

  it('rejects a valid setting submitted under the wrong section', async () => {
    const res = await putSettings({
      section: 'paypal',
      values: { discord_application_id: '444444444444444444' },
    });

    expect(res.status).toBe(400);
    expect(mock._query.upsert).not.toHaveBeenCalled();
  });

  it('stores submitted secrets only as project-bound encrypted rows', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'service-role-test-key');
    mock._query.upsert.mockResolvedValue({ error: null });

    const res = await putSettings({
      section: 'paypal',
      values: { paypal_client_secret: 'replacement-secret' },
    });

    expect(res.status).toBe(200);
    const rows = mock._query.upsert.mock.calls[0][0];
    expect(rows[0].key).toBe('paypal_client_secret_encrypted');
    expect(rows[0].value).toMatch(/^somnibot-cloud-v1:/);
    expect(JSON.stringify(rows)).not.toContain('replacement-secret');
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

    expect(res.status).toBe(400);
    expect(mock._query.upsert).not.toHaveBeenCalled();
  });

  it('notifies bot after successful save', async () => {
    mock._query.upsert.mockResolvedValue({ error: null });

    await putSettings({ section: 'lavalink', values: { lavalink_host: '10.0.0.1' } });

    expect(notifyBot).toHaveBeenCalledWith('guild-1', 'settings', { section: 'lavalink' });
  });

  it('returns 500 when upsert throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dbError = new Error('DB connection lost');
    mock._query.upsert.mockRejectedValue(dbError);

    const res = await putSettings({
      section: 'discord',
      values: { discord_guild_id: '123' },
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Failed to save');
    expect(errorSpy).toHaveBeenCalledWith('[Settings] Save error:', dbError);
    errorSpy.mockRestore();
  });
});

describe('DELETE /api/settings', () => {
  it('removes saved values and encrypted secrets so environment defaults become authoritative again', async () => {
    const settings = registerTable(mock, 'instance_settings');
    settings.in.mockResolvedValue({ error: null });

    const res = await resetSettings({
      section: 'discord',
      keys: ['discord_guild_id', 'discord_bot_token'],
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, restartRequired: true });
    expect(settings.delete).toHaveBeenCalledTimes(1);
    expect(settings.in).toHaveBeenCalledWith('key', [
      'discord_guild_id',
      'discord_bot_token_encrypted',
    ]);
  });

  it('updates and verifies Supabase Auth with deployment defaults before removing saved Discord OAuth settings', async () => {
    vi.stubEnv('DISCORD_APPLICATION_ID', '666666666666666666');
    vi.stubEnv('DISCORD_CLIENT_SECRET', 'environment-client-secret');
    const settings = registerTable(mock, 'instance_settings');
    settings.in.mockResolvedValue({ error: null });

    const res = await resetSettings({
      section: 'discord',
      keys: ['discord_application_id', 'discord_client_secret'],
    });

    expect(res.status).toBe(200);
    expect(ensureDiscordAuthProvider).toHaveBeenCalledWith({
      accessToken: 'management-access-token',
      discordClientId: '666666666666666666',
      discordClientSecret: 'environment-client-secret',
      forceCredentialUpdate: true,
    });
    expect(settings.delete).toHaveBeenCalledTimes(1);
  });

  it('rolls Supabase Auth back and retains saved settings when reset verification fails', async () => {
    vi.stubEnv('DISCORD_APPLICATION_ID', '666666666666666666');
    vi.stubEnv('DISCORD_CLIENT_SECRET', 'environment-client-secret');
    vi.mocked(ensureDiscordAuthProvider)
      .mockResolvedValueOnce({ success: false, error: 'verification mismatch' })
      .mockResolvedValueOnce({ success: true });

    const res = await resetSettings({
      section: 'discord',
      keys: ['discord_application_id', 'discord_client_secret'],
    });

    expect(res.status).toBe(409);
    expect(mock._query.delete).not.toHaveBeenCalled();
    expect(ensureDiscordAuthProvider).toHaveBeenNthCalledWith(2, {
      accessToken: 'management-access-token',
      discordClientId: '111111111111111111',
      discordClientSecret: 'existing-client-secret',
      forceCredentialUpdate: true,
    });
  });

  it('rolls Supabase Auth back when saved-setting deletion fails', async () => {
    vi.stubEnv('DISCORD_APPLICATION_ID', '666666666666666666');
    vi.stubEnv('DISCORD_CLIENT_SECRET', 'environment-client-secret');
    registerTable(mock, 'instance_settings').in.mockResolvedValue({
      error: { message: 'delete failed' },
    });

    const res = await resetSettings({
      section: 'discord',
      keys: ['discord_application_id', 'discord_client_secret'],
    });

    expect(res.status).toBe(500);
    expect(ensureDiscordAuthProvider).toHaveBeenNthCalledWith(2, {
      accessToken: 'management-access-token',
      discordClientId: '111111111111111111',
      discordClientSecret: 'existing-client-secret',
      forceCredentialUpdate: true,
    });
  });

  it('does not allow Supabase bootstrap fields to be reset from the dashboard', async () => {
    const res = await resetSettings({ section: 'supabase', keys: ['supabase_url'] });

    expect(res.status).toBe(400);
    expect(mock._query.delete).not.toHaveBeenCalled();
  });

  it('does not reset a valid setting through a different section', async () => {
    const res = await resetSettings({
      section: 'paypal',
      keys: ['discord_application_id'],
    });

    expect(res.status).toBe(400);
    expect(mock._query.delete).not.toHaveBeenCalled();
  });
});
