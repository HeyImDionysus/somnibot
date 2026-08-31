import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMockSupabase, registerTable } from './helpers/mock-supabase';

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  authErrorResponse: vi.fn(),
  createAdminSupabase: vi.fn(),
}));

vi.mock('@/lib/rbac', () => ({ requirePermission: mocks.requirePermission, authErrorResponse: mocks.authErrorResponse }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: mocks.createAdminSupabase }));
vi.mock('@/lib/dashboard/adoption-server-context', () => ({ readAdoptionServerContext: async () => null }));

import { GET, PATCH } from '@/app/api/dashboard/adoption/route';

function patchRequest(body: unknown) {
  return new NextRequest('http://localhost/api/dashboard/adoption', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'adoption-map-test-1' },
    body: JSON.stringify(body),
  });
}

describe('dashboard adoption API', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requirePermission.mockResolvedValue({
      userId: 'user-1', discordId: 'owner-1', guildId: 'guild-1', isOwner: true, permissions: ['dashboard.full_access'],
    });
  });

  it('returns a default plan for an authenticated guild without saved state', async () => {
    const supabase = createMockSupabase();
    const adoption = registerTable(supabase, 'dashboard_adoption_maps');
    adoption.maybeSingle.mockResolvedValue({ data: null, error: null });
    supabase.rpc.mockResolvedValue({ data: [], error: null });
    mocks.createAdminSupabase.mockReturnValue(supabase);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.state.selectedTrackIds).toEqual(['core', 'recovery']);
    expect(adoption.eq).toHaveBeenCalledWith('guild_id', 'guild-1');
  });

  it('requires full access before any adoption-map write', async () => {
    const denied = new Error('forbidden');
    mocks.requirePermission.mockRejectedValue(denied);
    mocks.authErrorResponse.mockReturnValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));

    const response = await PATCH(patchRequest({}));

    expect(response.status).toBe(403);
    expect(mocks.createAdminSupabase).not.toHaveBeenCalled();
    expect(mocks.requirePermission).toHaveBeenCalledWith('dashboard.full_access');
  });

  it('rejects an unverified active track before persistence', async () => {
    const supabase = createMockSupabase();
    const adoption = registerTable(supabase, 'dashboard_adoption_maps');
    adoption.maybeSingle.mockResolvedValue({ data: null, error: null });
    supabase.rpc.mockResolvedValue({ data: [], error: null });
    mocks.createAdminSupabase.mockReturnValue(supabase);
    const response = await PATCH(patchRequest({
      mode: 'guided', tutorialVisible: true, selectedTrackIds: ['core', 'recovery'], trackStates: { core: 'active' },
    }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.transitionErrors).toContain('core:verification_required');
    expect(supabase.rpc).not.toHaveBeenCalledWith('publish_dashboard_adoption_map', expect.anything());
  });

  it('publishes through one durable operation and returns authoritative readback', async () => {
    const supabase = createMockSupabase();
    const adoption = registerTable(supabase, 'dashboard_adoption_maps');
    adoption.maybeSingle.mockResolvedValue({ data: null, error: null });
    supabase.rpc.mockResolvedValueOnce({ data: ['core', 'recovery'].map((trackId) => ({
      trackId, result: 'pass', eligible: true, checkedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), reason: 'observed', evidenceIds: [],
    })), error: null });
    supabase.rpc.mockResolvedValue({ data: {
      state: { mode: 'expert', tutorialVisible: false, selectedTrackIds: ['core', 'recovery'], verifiedTrackIds: ['core', 'recovery'], trackStates: { core: 'active', recovery: 'active' } },
      updatedAt: '2026-08-23T14:30:00.000Z', revision: 1,
      operationId: '11111111-1111-4111-8111-111111111111', releaseId: '22222222-2222-4222-8222-222222222222',
    }, error: null });
    mocks.createAdminSupabase.mockReturnValue(supabase);

    const response = await PATCH(patchRequest({
      mode: 'expert', tutorialVisible: false, selectedTrackIds: ['core', 'recovery'],
      trackStates: { core: 'active', recovery: 'active' },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('publish_dashboard_adoption_map', expect.objectContaining({
      p_guild_id: 'guild-1', p_actor_id: 'owner-1', p_idempotency_key: 'adoption-map-test-1',
    }));
    expect(body.data.operationId).toBe('11111111-1111-4111-8111-111111111111');
    expect(body.data.state.mode).toBe('expert');
  });

  it('rejects client-authored verification evidence', async () => {
    const supabase = createMockSupabase();
    mocks.createAdminSupabase.mockReturnValue(supabase);

    const response = await PATCH(patchRequest({
      mode: 'guided', tutorialVisible: true, selectedTrackIds: ['core', 'recovery'],
      verifiedTrackIds: ['core'], trackStates: {},
    }));

    expect(response.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
