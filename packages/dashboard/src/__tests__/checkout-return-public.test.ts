/**
 * Finding 7 — the buyer's post-purchase destination must be publicly reachable.
 *
 * PayPal's return_url used to be `/store?order_complete=true`. `/store` lives
 * under `app/(dashboard)` and is not in the middleware's public-route list, so
 * every unauthenticated buyer was redirected to the admin `/login` page after
 * paying. These lock in that the new `/portal/order-*` destinations are public
 * AND that no admin surface was made public to achieve it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(),
}));

const mockCreateServerClient = vi.mocked(createServerClient);

async function get(path: string) {
  const { middleware } = await import('../middleware');
  return middleware(new NextRequest(`http://localhost:3000${path}`));
}

describe('post-checkout landing pages are public', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.SESSION_TOKEN;
    delete process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-key';

    // No signed-in user: exactly the buyer coming back from PayPal.
    mockCreateServerClient.mockReturnValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    } as unknown as ReturnType<typeof createServerClient>);
  });

  it.each([
    '/portal/order-complete',
    '/portal/order-cancelled',
  ])('serves %s to an unauthenticated buyer without redirecting to login', async (path) => {
    const res = await get(`${path}?guild=123456789012345678`);

    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });

  it('reaches the confirmation page without consulting Supabase auth at all', async () => {
    mockCreateServerClient.mockImplementation(() => {
      throw new Error('post-checkout landing must not depend on an admin session');
    });

    const res = await get('/portal/order-complete?guild=123456789012345678');

    expect(res.status).toBe(200);
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('still sends an unauthenticated visitor from the admin store to login', async () => {
    // The regression this fix must NOT introduce: making an admin surface public.
    const res = await get('/store?order_complete=true');

    expect(res.headers.get('location')).toContain('/login');
  });

  it.each([
    '/dashboard',
    '/store/products',
    '/store/promotions',
    '/analytics',
  ])('keeps %s behind the admin session', async (path) => {
    const res = await get(path);

    expect(res.headers.get('location')).toContain('/login');
  });
});
