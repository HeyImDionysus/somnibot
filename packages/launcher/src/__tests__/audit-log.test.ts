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
  buildLauncherAttemptAuditEntry,
  LauncherAttemptTracker,
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

describe('buildLauncherAttemptAuditEntry', () => {
  it('keeps retries in one operation until a terminal outcome', () => {
    // Given: a tracker whose operation ids come from a deterministic source.
    const tracker = new LauncherAttemptTracker(() => 'operation-1');

    // When: a preflight attempt retries and the next attempt succeeds.
    const first = tracker.next('vps-preflight');
    tracker.finish('vps-preflight', 'retry');
    const second = tracker.next('vps-preflight');
    tracker.finish('vps-preflight', 'success');
    const nextOperation = tracker.next('vps-preflight');

    // Then: retry attempts stay ordered under one operation, then reset.
    expect(first).toEqual({ operationId: 'operation-1', attempt: 1 });
    expect(second).toEqual({ operationId: 'operation-1', attempt: 2 });
    expect(nextOperation).toEqual({ operationId: 'operation-1', attempt: 1 });
  });

  it('keeps ordered retry attempts under one operation id', () => {
    // Given: a single updater operation with two completed attempts.
    const first = buildLauncherAttemptAuditEntry({
      operationId: 'updater-op-1',
      attempt: 1,
      phase: 'updater-check',
      result: 'retry',
      code: 'updater_check_failed',
      message: 'Updater check failed.',
      timestamp: '2026-08-18T12:00:00.000Z',
    });

    // When: its retry completes successfully.
    const second = buildLauncherAttemptAuditEntry({
      operationId: 'updater-op-1',
      attempt: 2,
      phase: 'updater-check',
      result: 'success',
      code: 'updater_check_completed',
      message: 'Updater check completed.',
      timestamp: '2026-08-18T12:00:01.000Z',
    });

    // Then: each attempt has one ordered, independently replay-safe occurrence.
    expect(first.correlationId).toBe('updater-op-1');
    expect(first.occurrenceKey).toBe('launcher.attempt:updater-op-1:updater-check:1');
    expect(second.occurrenceKey).toBe('launcher.attempt:updater-op-1:updater-check:2');
    expect(first.details).toMatchObject({ attempt: 1, result: 'retry' });
    expect(second.details).toMatchObject({ attempt: 2, result: 'success' });
  });

  it('redacts secret-shaped error data before a preflight attempt is persisted', () => {
    // Given: a preflight error containing a secret and a private-key path.
    const secret = 'sb_secret_abcdefghijklmnopqrstuvwxyz';
    const keyPath = 'C:\\Users\\operator\\.ssh\\somnibot_deploy';

    // When: the failure is converted into an attempt audit entry.
    const entry = buildLauncherAttemptAuditEntry({
      operationId: 'preflight-op-1',
      attempt: 1,
      phase: 'vps-preflight',
      result: 'failure',
      code: 'vps_preflight_terminal_failure',
      message: `token=${secret} key=${keyPath}`,
      timestamp: '2026-08-18T12:00:00.000Z',
    });

    // Then: no secret, path, or raw command output survives the audit boundary.
    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(JSON.stringify(entry)).not.toContain(keyPath);
    expect(entry.errorMessage).toBe('[redacted]');
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

  it('uses the occurrence key as the durable replay fence for an attempt', async () => {
    const secret = 'sb_secret_abcdefghijklmnopqrstuvwxyz';
    const keyPath = 'C:\\Users\\operator\\.ssh\\somnibot_deploy';
    const entry = buildLauncherAttemptAuditEntry({
      operationId: 'preflight-op-1',
      attempt: 2,
      phase: 'vps-preflight',
      result: 'retry',
      code: 'vps_preflight_retryable_failure',
      message: `token=${secret} key=${keyPath}`,
      timestamp: '2026-08-18T12:00:01.000Z',
    });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });

    const result = await writeLauncherAuditLog(CTX, entry, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const replayResult = await writeLauncherAuditLog(CTX, entry, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    const [replayUrl, replayInit] = fetchImpl.mock.calls[1];
    const serializedRequest = JSON.stringify({ url, init });
    expect(result.ok).toBe(true);
    expect(replayResult.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(url).toBe('https://proj.supabase.co/rest/v1/audit_logs?on_conflict=guild_id,occurrence_key');
    expect(replayUrl).toBe(url);
    expect(init.headers.Prefer).toBe('return=minimal,resolution=ignore-duplicates');
    expect(replayInit.headers.Prefer).toBe(init.headers.Prefer);
    expect(JSON.parse(init.body)).toMatchObject({
      correlation_id: 'preflight-op-1',
      occurrence_key: 'launcher.attempt:preflight-op-1:vps-preflight:2',
    });
    expect(serializedRequest).not.toContain(secret);
    expect(serializedRequest).not.toContain(keyPath);
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
