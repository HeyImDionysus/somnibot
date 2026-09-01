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
vi.mock('@somnibot/shared', async () => import('../../../shared/src/index'));

import { GET } from '@/app/api/dashboard/control-center/route';

describe('dashboard control-center search API', () => {
  beforeEach(() => vi.resetAllMocks());

  it('passes only role-authorized kinds and returns no cross-provider rows', async () => {
    mocks.requirePermission.mockResolvedValue({
      guildId: 'guild-1', discordId: 'support-1', isOwner: false,
      permissions: ['dashboard.manage_customers'],
    });
    const supabase = createMockSupabase();
    const guild = registerTable(supabase, 'guild');
    const diagnostics = registerTable(supabase, 'bot_diagnostics');
    guild.maybeSingle.mockResolvedValue({ data: { id: 'guild-1', name: 'Guild', setup_completed: true }, error: null });
    diagnostics.maybeSingle.mockResolvedValue({ data: null, error: null });
    supabase.rpc.mockResolvedValue({ data: [
      { kind: 'customers', id: 'customer-1', label: 'Buyer', description: 'Customer', href: '/customers/customer-1' },
      { kind: 'products', id: 'product-1', label: 'Hidden product', description: 'Product', href: '/store?productId=product-1' },
    ], error: null });
    mocks.createAdminSupabase.mockReturnValue(supabase);

    const response = await GET(new NextRequest('http://localhost/api/dashboard/control-center?q=buyer'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('search_dashboard_control_center', expect.objectContaining({
      p_guild_id: 'guild-1', p_query: 'buyer', p_kinds: ['customers'],
    }));
    expect(body.data.searchResults.filter((result: { readonly kind: string }) => result.kind === 'customers')).toHaveLength(1);
    expect(body.data.searchResults.some((result: { readonly kind: string }) => result.kind === 'products')).toBe(false);
  });
});
