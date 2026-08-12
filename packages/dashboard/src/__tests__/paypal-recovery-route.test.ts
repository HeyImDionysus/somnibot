import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  supabase: { marker: 'admin-supabase' },
  createAdminSupabase: vi.fn(),
  executeRecovery: vi.fn(),
  sweepRecovery: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: mocks.createAdminSupabase,
}));

vi.mock('@/app/api/paypal/webhook/handlers', () => ({
  executeProviderMoneyRecovery: mocks.executeRecovery,
  sweepProviderMoneyRecovery: mocks.sweepRecovery,
}));

import { GET, POST } from '@/app/api/paypal/recovery/route';

function request(method: string, headers: Record<string, string> = {}, body?: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/paypal/recovery', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('PayPal recovery route secret gate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.PAYPAL_RECONCILE_SECRET = 'recovery-secret-value';
    mocks.createAdminSupabase.mockReturnValue(mocks.supabase);
    mocks.executeRecovery.mockResolvedValue({ status: 'completed' });
    mocks.sweepRecovery.mockResolvedValue([]);
  });

  it('reaches the recovery consumer with the exact machine secret', async () => {
    const response = await POST(request('POST', {
      'x-paypal-reconcile-secret': 'recovery-secret-value',
    }, { webhook_event_id: 'evt-recovery-1' }));

    expect(response.status).toBe(200);
    expect(mocks.executeRecovery).toHaveBeenCalledWith(
      mocks.supabase,
      'evt-recovery-1',
    );
  });

  it.each([
    ['missing', {}],
    ['wrong', { 'x-paypal-reconcile-secret': 'wrong-secret-value' }],
  ])('denies %s secrets before touching recovery state', async (_label, headers) => {
    const response = await POST(request('POST', headers, { webhook_event_id: 'evt-recovery-1' }));

    expect(response.status).toBe(401);
    expect(mocks.executeRecovery).not.toHaveBeenCalled();
    expect(mocks.createAdminSupabase).not.toHaveBeenCalled();
  });

  it('uses the same secret gate for the sweep consumer', async () => {
    const response = await GET(request('GET', {
      'x-paypal-reconcile-secret': 'recovery-secret-value',
    }));

    expect(response.status).toBe(200);
    expect(mocks.sweepRecovery).toHaveBeenCalledWith(mocks.supabase, 20);
  });
});
