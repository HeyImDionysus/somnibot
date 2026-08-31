import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { createMockSupabase, registerTable } from './helpers';

const mocks = vi.hoisted(() => ({
  checkAdminRateLimit: vi.fn(), requireGuildOwner: vi.fn(), createAdminSupabase: vi.fn(),
  checkValkeyHealth: vi.fn(), readValkeyKey: vi.fn(),
}));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: mocks.checkAdminRateLimit }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: mocks.requireGuildOwner }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: mocks.createAdminSupabase }));
vi.mock('@/lib/api/rate-limit', () => ({ checkValkeyHealth: mocks.checkValkeyHealth, readValkeyKey: mocks.readValkeyKey }));

import { GET } from '@/app/api/system-state/route';

const guildId = '1464713668766732393';
const capturedAt = '2026-08-31T13:00:00+00:00';
const rehearsedAt = '2026-08-31T13:30:00+00:00';
const backupId = '11111111-1111-4111-8111-111111111111';
const databaseChecksum = 'a'.repeat(64);
const valkeyChecksum = 'b'.repeat(64);

function fixture() {
  const admin = createMockSupabase();
  const audit = registerTable(admin, 'audit_logs');
  audit.order.mockReturnThis();
  audit.limit.mockResolvedValue({ data: [
    { action: 'launcher.backup.database_succeeded', timestamp: capturedAt, success: true,
      details: { backupId, capturedAt, checksumSha256: databaseChecksum } },
    { action: 'launcher.backup.valkey_succeeded', timestamp: capturedAt, success: true,
      details: { capturedAt, checksumSha256: valkeyChecksum } },
    { action: 'launcher.restore.rehearsal_succeeded', timestamp: rehearsedAt, success: true,
      details: { backupId, capturedAt, rehearsedAt, checksumSha256: databaseChecksum, validated: true } },
  ], error: null });
  admin.rpc.mockResolvedValue({ data: {
    identity: 'c'.repeat(32), backupId, databaseChecksumSha256: databaseChecksum,
    valkeyChecksumSha256: valkeyChecksum, rehearsedAt, deployedExactSha: 'd'.repeat(40),
    scope: 'database_rehearsal_and_valkey_snapshot', expiresAt: '2026-09-01T13:00:00+00:00', evidenceIds: [backupId],
  }, error: null });
  mocks.createAdminSupabase.mockReturnValue(admin);
  return { admin, audit };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime('2026-08-31T14:00:00.000Z');
  mocks.checkAdminRateLimit.mockResolvedValue(null);
  mocks.requireGuildOwner.mockResolvedValue({ ok: true, ctx: { guildId, discordId: 'owner', userId: 'owner' } });
  mocks.checkValkeyHealth.mockResolvedValue(true);
  mocks.readValkeyKey.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe('System State recovery authority', () => {
  it('uses selected-guild server proof and preserves actual PostgreSQL observation timestamps', async () => {
    const { admin, audit } = fixture();

    const response = await GET(new NextRequest('http://localhost/api/system-state?guildId=123456789012345678'));
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith('adoption_recovery_proof', {
      p_guild_id: guildId, p_since: '2026-08-30T14:00:00.000Z',
    });
    expect(audit.eq).toHaveBeenCalledWith('guild_id', guildId);
    expect(audit.in).toHaveBeenCalledWith('action', expect.arrayContaining([
      'launcher.backup.database_failed', 'launcher.backup.valkey_failed', 'launcher.restore.rehearsal_failed',
    ]));
    expect(body).toMatchObject({ data: {
      recovery: { status: 'ready', rehearsalScope: 'database', lastRehearsalAt: '2026-08-31T13:30:00.000Z' },
      backups: { valkey: { status: 'current', capturedAt: '2026-08-31T13:00:00.000Z', lastRestoreRehearsalAt: null } },
    } });
  });

  it('keeps recovery unverified when the current-identity query is unavailable', async () => {
    const { admin } = fixture();
    admin.rpc.mockResolvedValue({ data: null, error: { message: 'fixture-private-connection-error' } });

    const response = await GET(new NextRequest('http://localhost/api/system-state'));
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ data: { recovery: { status: 'unverified' }, backups: { database: { status: 'current' } } } });
    expect(JSON.stringify(body)).not.toContain('fixture-private-connection-error');
  });

  it('never queries recovery authority before selected-guild ownership is established', async () => {
    const { admin } = fixture();
    mocks.requireGuildOwner.mockResolvedValue({ ok: false, response: NextResponse.json({ success: false }, { status: 403 }) });

    const response = await GET(new NextRequest('http://localhost/api/system-state'));

    expect(response.status).toBe(403);
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(admin.from).not.toHaveBeenCalled();
  });
});
