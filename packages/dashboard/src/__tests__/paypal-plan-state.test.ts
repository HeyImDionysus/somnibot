import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensurePayPalPlanState } from '@/lib/store/paypal-plan-state';

const config = {
  apiBase: 'https://api-m.sandbox.paypal.com',
  clientId: 'client',
  clientSecret: 'secret',
  webhookId: 'WH-1',
  webhookUrl: 'https://dashboard.example.com/api/paypal/webhook',
  sandbox: true,
  sources: {
    apiBase: 'derived' as const,
    clientId: 'saved' as const,
    clientSecret: 'saved' as const,
    webhookId: 'saved' as const,
    webhookUrl: 'saved' as const,
    sandbox: 'saved' as const,
  },
};

vi.mock('@/lib/paypal', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/paypal')>();
  return { ...original, getPayPalToken: vi.fn().mockResolvedValue('token') };
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ensurePayPalPlanState', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('deactivates and authoritatively verifies an active provider plan', async () => {
    const paypalFetch = vi.fn()
      .mockResolvedValueOnce(response({ id: 'PLAN-1', status: 'ACTIVE' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({ id: 'PLAN-1', status: 'INACTIVE' }));
    vi.stubGlobal('fetch', paypalFetch);

    await expect(ensurePayPalPlanState(config, 'PLAN-1', false)).resolves.toEqual({ ok: true });
    expect(paypalFetch).toHaveBeenNthCalledWith(
      2,
      'https://api-m.sandbox.paypal.com/v1/billing/plans/PLAN-1/deactivate',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('is idempotent when the provider already has the requested state', async () => {
    const paypalFetch = vi.fn().mockResolvedValueOnce(response({ id: 'PLAN-1', status: 'INACTIVE' }));
    vi.stubGlobal('fetch', paypalFetch);

    await expect(ensurePayPalPlanState(config, 'PLAN-1', false)).resolves.toEqual({ ok: true });
    expect(paypalFetch).toHaveBeenCalledTimes(1);
  });

  it('treats a newly created provider plan as safely inactive without activating it', async () => {
    const paypalFetch = vi.fn().mockResolvedValueOnce(response({ id: 'PLAN-1', status: 'CREATED' }));
    vi.stubGlobal('fetch', paypalFetch);

    await expect(ensurePayPalPlanState(config, 'PLAN-1', false)).resolves.toEqual({ ok: true });
    expect(paypalFetch).toHaveBeenCalledTimes(1);
  });
});
