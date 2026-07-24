/**
 * [infrastructure-launcher] Launcher audit-log writer.
 *
 * The launcher has no access to the bot's EventBus/AuditService, so it writes
 * durable audit_logs rows over the Supabase REST API. These tests cover the
 * pure row builder, guild resolution, and the best-effort writer (including the
 * update-install and keychain-failure security actions).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildLauncherAuditRow,
  resolveLauncherGuildId,
  writeLauncherAuditLog,
  type LauncherAuditEntry,
} from '../main/audit-log';

const CTX = {
  supabaseUrl: 'https://proj.supabase.co',
  supabaseSecretKey: 'sb_secret_test',
  guildId: 'guild-1',
};

describe('resolveLauncherGuildId', () => {
  it('prefers the first enabled guild', () => {
    expect(resolveLauncherGuildId({
      discordGuildId: 'legacy',
      guilds: [
        { discordGuildId: 'a', enabled: false },
        { discordGuildId: 'b', enabled: true },
      ],
    })).toBe('b');
  });

  it('falls back to the legacy single-guild id', () => {
    expect(resolveLauncherGuildId({ discordGuildId: 'legacy', guilds: [] })).toBe('legacy');
  });
});

describe('buildLauncherAuditRow', () => {
  it('maps an entry onto an audit_logs row with launcher defaults', () => {
    const row = buildLauncherAuditRow('guild-1', {
      action: 'launcher.update.install',
      category: 'security',
      success: true,
    });
    expect(row).toMatchObject({
      guild_id: 'guild-1',
      actor_type: 'system',
      actor_id: 'launcher',
      action: 'launcher.update.install',
      category: 'security',
      success: true,
    });
  });

  it('records failure branches (keychain unavailable) with success=false + error', () => {
    const row = buildLauncherAuditRow('guild-1', {
      action: 'launcher.keychain.unavailable',
      category: 'security',
      success: false,
      errorMessage: 'safeStorage unavailable',
    });
    expect(row.success).toBe(false);
    expect(row.error_message).toBe('safeStorage unavailable');
  });
});

describe('writeLauncherAuditLog', () => {
  const entry: LauncherAuditEntry = {
    action: 'launcher.vps_deployment.executed',
    category: 'security',
    success: true,
  };

  it('does not call fetch and returns ok:false when credentials are missing', async () => {
    const fetchImpl = vi.fn();
    const result = await writeLauncherAuditLog(
      { supabaseUrl: '', supabaseSecretKey: '', guildId: '' },
      entry,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs the audit row to the Supabase audit_logs endpoint with the secret key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    const result = await writeLauncherAuditLog(CTX, entry, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://proj.supabase.co/rest/v1/audit_logs');
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('sb_secret_test');
    expect(init.headers.Authorization).toBe('Bearer sb_secret_test');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      guild_id: 'guild-1',
      action: 'launcher.vps_deployment.executed',
      category: 'security',
      actor_type: 'system',
    });
  });

  it('returns ok:false (without throwing) on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'no' });
    const result = await writeLauncherAuditLog(CTX, entry, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
  });
});
