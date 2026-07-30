/**
 * Observability-gap [commerce-licenses]: license revocation and the device-session
 * lifecycle previously wrote NO audit_logs row (only /license activate was audited).
 *
 * These tests assert each owner/user-driven state change now writes an append-only
 * commerce audit row via the service-role client (writeCommerceAudit).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: { licenseDeactivate: vi.fn(async () => ({ limited: false, retryAfterMs: 0 })) },
}));

import { PUT as licenseKeyPut } from '@/app/api/license-keys/[key]/route';
import { DELETE as sessionDelete } from '@/app/api/license/sessions/[id]/route';
import { POST as deactivatePost } from '@/app/api/license/deactivate/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

import {
  createMockSupabase,
  registerTable,
  buildRequest,
  mockAuthSuccess,
  mockRateLimitPass,
} from './helpers';

const SESSION_UUID = '11111111-1111-1111-1111-111111111111';

let mock: ReturnType<typeof createMockSupabase>;

beforeEach(() => {
  vi.resetAllMocks();
  mock = createMockSupabase();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
});

describe('PUT /api/license-keys/[key] — revocation audit', () => {
  it('writes a license.revoked audit row (with cascade session count) on revoke', async () => {
    const keyTable = registerTable(mock, 'license_keys');
    keyTable.maybeSingle.mockResolvedValue({ data: { id: 'key-1' } });
    keyTable.single.mockResolvedValue({ data: { id: 'key-1', status: 'revoked' }, error: null });

    const sessTable = registerTable(mock, 'license_sessions');
    sessTable.select.mockResolvedValue({ data: [{ id: 's1' }, { id: 's2' }], error: null });

    const auditTable = registerTable(mock, 'audit_logs');

    const res = await licenseKeyPut(
      buildRequest('/api/license-keys/key-1', {
        method: 'PUT',
        body: { status: 'revoked', revocation_reason: 'chargeback' },
      }) as never,
      { params: Promise.resolve({ key: 'key-1' }) },
    );

    expect(res.status).toBe(200);
    expect(auditTable.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        guild_id: 'guild-1',
        actor_type: 'user',
        actor_id: '123456789',
        action: 'license.revoked',
        category: 'commerce',
        target_type: 'license_key',
        target_id: 'key-1',
        details: expect.objectContaining({
          status: 'revoked',
          revocationReason: 'chargeback',
          sessionsRevoked: 2,
        }),
      }),
    );
  });

  it('writes a license.status_changed audit row on a non-revoke status change', async () => {
    const keyTable = registerTable(mock, 'license_keys');
    keyTable.maybeSingle.mockResolvedValue({ data: { id: 'key-1' } });
    keyTable.single.mockResolvedValue({ data: { id: 'key-1', status: 'suspended' }, error: null });

    registerTable(mock, 'license_sessions');
    const auditTable = registerTable(mock, 'audit_logs');

    const res = await licenseKeyPut(
      buildRequest('/api/license-keys/key-1', {
        method: 'PUT',
        body: { status: 'suspended' },
      }) as never,
      { params: Promise.resolve({ key: 'key-1' }) },
    );

    expect(res.status).toBe(200);
    expect(auditTable.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'license.status_changed',
        target_type: 'license_key',
        target_id: 'key-1',
      }),
    );
  });
});

describe('DELETE /api/license/sessions/[id] — admin session revoke audit', () => {
  it('writes a license.session_revoked audit row', async () => {
    const sessTable = registerTable(mock, 'license_sessions');
    sessTable.maybeSingle.mockResolvedValue({ data: { id: SESSION_UUID }, error: null });

    const auditTable = registerTable(mock, 'audit_logs');

    const res = await sessionDelete(
      buildRequest(`/api/license/sessions/${SESSION_UUID}`, { method: 'DELETE' }) as never,
      { params: Promise.resolve({ id: SESSION_UUID }) },
    );

    expect(res.status).toBe(200);
    expect(auditTable.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        guild_id: 'guild-1',
        actor_type: 'user',
        actor_id: '123456789',
        action: 'license.session_revoked',
        target_type: 'license_session',
        target_id: SESSION_UUID,
        details: expect.objectContaining({ reason: 'admin_revoked' }),
      }),
    );
  });
});

describe('POST /api/license/deactivate — user device-deactivation audit', () => {
  it('writes a license.session_deactivated audit row when a session flips', async () => {
    const keyTable = registerTable(mock, 'license_keys');
    keyTable.single.mockResolvedValue({
      data: { id: 'key-1', guild_id: 'guild-1', bound_discord_id: 'disc-1' },
      error: null,
    });

    mock.rpc.mockResolvedValue({ data: true, error: null });

    const auditTable = registerTable(mock, 'audit_logs');

    const res = await deactivatePost(
      buildRequest('/api/license/deactivate', {
        method: 'POST',
        body: { license_key: 'SMNI-KEY', session_id: SESSION_UUID },
      }) as never,
    );

    expect(res.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledWith('license_deactivate_device', {
      p_license_key_id: 'key-1',
      p_session_id: SESSION_UUID,
    });
    expect(auditTable.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        guild_id: 'guild-1',
        actor_type: 'user',
        actor_id: 'disc-1',
        action: 'license.session_deactivated',
        target_type: 'license_session',
        target_id: SESSION_UUID,
      }),
    );
  });

  it('does NOT write an audit row when no session was deactivated (no-op replay)', async () => {
    const keyTable = registerTable(mock, 'license_keys');
    keyTable.single.mockResolvedValue({
      data: { id: 'key-1', guild_id: 'guild-1', bound_discord_id: 'disc-1' },
      error: null,
    });

    mock.rpc.mockResolvedValue({ data: false, error: null });

    const auditTable = registerTable(mock, 'audit_logs');

    const res = await deactivatePost(
      buildRequest('/api/license/deactivate', {
        method: 'POST',
        body: { license_key: 'SMNI-KEY', session_id: SESSION_UUID },
      }) as never,
    );

    expect(res.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledWith('license_deactivate_device', {
      p_license_key_id: 'key-1',
      p_session_id: SESSION_UUID,
    });
    expect(auditTable.insert).not.toHaveBeenCalled();
  });

  it('never uses a direct session update that could downgrade admin_revoked', async () => {
    const keyTable = registerTable(mock, 'license_keys');
    keyTable.single.mockResolvedValue({
      data: { id: 'key-1', guild_id: 'guild-1', bound_discord_id: 'disc-1' },
      error: null,
    });
    const sessTable = registerTable(mock, 'license_sessions');
    mock.rpc.mockResolvedValue({ data: false, error: null });

    const res = await deactivatePost(
      buildRequest('/api/license/deactivate', {
        method: 'POST',
        body: { license_key: 'SMNI-KEY', session_id: SESSION_UUID },
      }) as never,
    );

    expect(res.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledOnce();
    expect(sessTable.update).not.toHaveBeenCalled();
  });

  it('fails closed on an RPC error without auditing or falling back to a direct update', async () => {
    const keyTable = registerTable(mock, 'license_keys');
    keyTable.single.mockResolvedValue({
      data: { id: 'key-1', guild_id: 'guild-1', bound_discord_id: 'disc-1' },
      error: null,
    });
    const sessTable = registerTable(mock, 'license_sessions');
    const auditTable = registerTable(mock, 'audit_logs');
    mock.rpc.mockResolvedValue({
      data: null,
      error: { code: 'XX000', message: 'database unavailable' },
    });

    const res = await deactivatePost(
      buildRequest('/api/license/deactivate', {
        method: 'POST',
        body: { license_key: 'SMNI-KEY', session_id: SESSION_UUID },
      }) as never,
    );

    expect(res.status).toBe(500);
    expect(sessTable.update).not.toHaveBeenCalled();
    expect(auditTable.insert).not.toHaveBeenCalled();
  });
});
