import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMockSupabase } from './helpers/mock-supabase';

const mocks = vi.hoisted(() => ({ requirePermission: vi.fn(), authErrorResponse: vi.fn(), createAdminSupabase: vi.fn(), checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/rbac', () => ({ requirePermission: mocks.requirePermission, authErrorResponse: mocks.authErrorResponse }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: mocks.createAdminSupabase }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: mocks.checkAdminRateLimit }));
vi.mock('@/lib/dashboard/adoption-server-context', () => ({ readAdoptionServerContext: async () => null }));
import { POST } from '@/app/api/dashboard/adoption/verify/route';
const recordedOperationId = '22222222-2222-4222-8222-222222222222';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/dashboard/adoption/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'verify-1' }, body: JSON.stringify(body),
  });
}

describe('owner observation-only verification route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requirePermission.mockResolvedValue({ discordId: 'owner-1', guildId: 'guild-1' });
    mocks.checkAdminRateLimit.mockResolvedValue(null);
  });
  it.each([{ result: 'pass' }, { evidence: {} }, { guildId: 'foreign' }, { actorId: 'other' }, { eligible: true }, { context: {} }, { serverContext: {} }])('rejects browser attestation %j', async (extra) => {
    const response = await POST(request({ trackId: 'core', ...extra }));
    expect(response.status).toBe(400);
    expect(mocks.createAdminSupabase).not.toHaveBeenCalled();
  });
  it.each(['core', 'games'])('records %s through the tenant-pinned server check only', async (trackId) => {
    const supabase = createMockSupabase();
    supabase.rpc.mockResolvedValue({ data: { trackId, operationId: recordedOperationId, result: 'pass', eligible: true, reason: 'observed', checkedAt: '2026-08-31T16:00:00Z', expiresAt: '2026-08-31T16:03:00Z', evidenceIds: ['audit-1'] }, error: null });
    mocks.createAdminSupabase.mockReturnValue(supabase);
    const response = await POST(request({ trackId }));
    expect(response.status).toBe(200);
    expect((await response.json()).operationId).toBe(recordedOperationId);
    expect(supabase.rpc).toHaveBeenCalledWith('check_dashboard_adoption_track', {
      p_guild_id: 'guild-1', p_actor_id: 'owner-1', p_track_id: trackId, p_operation_id: expect.any(String), p_idempotency_key: 'verify-1', p_server_context: null,
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });
  it('keeps a failed runtime outcome visible without claiming endpoint failure', async () => {
    const supabase = createMockSupabase();
    supabase.rpc.mockResolvedValue({ data: { trackId: 'core', operationId: recordedOperationId, result: 'fail', eligible: false, reason: 'dependency_failed', checkedAt: '2026-08-31T16:00:00Z', expiresAt: '2026-08-31T16:03:00Z', evidenceIds: [] }, error: null });
    mocks.createAdminSupabase.mockReturnValue(supabase);
    const response = await POST(request({ trackId: 'core' }));
    expect((await response.json()).data).toMatchObject({ result: 'fail', eligible: false });
  });
  it('denies staff without touching evidence', async () => {
    mocks.requirePermission.mockRejectedValue(new Error('forbidden'));
    mocks.authErrorResponse.mockReturnValue(new Response(null, { status: 403 }));
    expect((await POST(request({ trackId: 'core' }))).status).toBe(403);
    expect(mocks.createAdminSupabase).not.toHaveBeenCalled();
  });
  it('reports unavailable storage without granting a pass', async () => {
    const supabase = createMockSupabase();
    supabase.rpc.mockResolvedValue({ data: null, error: { code: 'unavailable' } });
    mocks.createAdminSupabase.mockReturnValue(supabase);
    expect((await POST(request({ trackId: 'core' }))).status).toBe(503);
  });
});
