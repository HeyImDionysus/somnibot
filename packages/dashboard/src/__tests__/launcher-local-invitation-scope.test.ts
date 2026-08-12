import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireAuth = vi.fn();
vi.mock('@/lib/api/require-owner', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

const mockRateLimit = vi.fn();
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

const mockCreateAdminSupabase = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => mockCreateAdminSupabase(),
}));

vi.mock('@/lib/team-invitations', () => ({
  writeTeamAudit: vi.fn(),
}));

import { GET as listMine } from '../app/api/rbac/invitations/mine/route';
import { POST as acceptInvitation } from '../app/api/rbac/invitations/[id]/accept/route';
import { POST as declineInvitation } from '../app/api/rbac/invitations/[id]/decline/route';

const routeContext = { params: Promise.resolve({ id: 'invitation-outside-local-guild' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue(null);
  mockRequireAuth.mockResolvedValue({
    ok: true,
    userId: 'launcher-local-owner',
    discordId: '222222222222222222',
    localGuildIds: ['111111111111111111'],
  });
});

describe('launcher-local invitation scope', () => {
  it('does not discover invitations through an owner-local session', async () => {
    const response = await listMine(new Request('http://localhost/api/rbac/invitations/mine'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: [] });
    expect(mockCreateAdminSupabase).not.toHaveBeenCalled();
  });

  it('does not accept invitations through an owner-local session', async () => {
    const response = await acceptInvitation(
      new Request('http://localhost/api/rbac/invitations/anything/accept', { method: 'POST' }),
      routeContext,
    );

    expect(response.status).toBe(404);
    expect(mockCreateAdminSupabase).not.toHaveBeenCalled();
  });

  it('does not decline invitations through an owner-local session', async () => {
    const response = await declineInvitation(
      new Request('http://localhost/api/rbac/invitations/anything/decline', { method: 'POST' }),
      routeContext,
    );

    expect(response.status).toBe(404);
    expect(mockCreateAdminSupabase).not.toHaveBeenCalled();
  });
});
