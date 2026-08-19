import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/paypal', () => ({ getPayPalRuntimeConfig: vi.fn() }));
vi.mock('@/lib/paypal-policy', () => ({
  loadPayPalPolicy: vi.fn(),
  applyPayPalPolicyEnvironment: vi.fn((config) => config),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { GET } from '@/app/api/store/onboarding/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { getPayPalRuntimeConfig } from '@/lib/paypal';
import { loadPayPalPolicy } from '@/lib/paypal-policy';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  buildRequest,
  createMockSupabase,
  mockAuthSuccess,
  mockRateLimitPass,
  registerTable,
} from './helpers';

const runtime = {
  apiBase: 'https://api-m.sandbox.paypal.com',
  clientId: 'configured-client',
  clientSecret: 'configured-secret',
  webhookId: 'WH-CONFIGURED',
  webhookUrl: 'https://dashboard.example.com/api/paypal/webhook',
  sandbox: true,
  sources: {
    apiBase: 'derived',
    clientId: 'saved',
    clientSecret: 'saved',
    webhookId: 'saved',
    webhookUrl: 'saved',
    sandbox: 'saved',
  },
};

describe('GET /api/store/onboarding', () => {
  let mock: ReturnType<typeof createMockSupabase>;
  let webhooks: ReturnType<typeof registerTable>;

  beforeEach(() => {
    vi.resetAllMocks();
    mock = createMockSupabase();
    webhooks = registerTable(mock, 'webhook_events');
    webhooks.select.mockReturnValue(webhooks);
    webhooks.eq.mockReturnValue(webhooks);
    webhooks.order.mockReturnValue(webhooks);
    webhooks.limit.mockReturnValue(webhooks);
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: 'guild-onboarding' });
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    (getPayPalRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue(runtime);
    (loadPayPalPolicy as ReturnType<typeof vi.fn>).mockResolvedValue({ environment: 'sandbox' });
  });

  it('reports the effective runtime environment and tenant-scoped evidence without returning credentials', async () => {
    (loadPayPalPolicy as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ environment: 'live' });
    webhooks.maybeSingle.mockResolvedValue({
      data: {
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        result: 'success',
        processed_at: '2026-08-10T12:00:00.000Z',
      },
      error: null,
    });

    const response = await GET(buildRequest('/api/store/onboarding'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(webhooks.eq).toHaveBeenCalledWith('guild_id', 'guild-onboarding');
    expect(body.data).toMatchObject({
      guildId: 'guild-onboarding',
      environment: 'sandbox',
      apiBase: 'http://localhost/api',
      credentialsConfigured: true,
      webhookIdConfigured: true,
      webhookUrlReady: true,
      lastWebhook: {
        result: 'success',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
      },
    });
    expect(JSON.stringify(body)).not.toContain('configured-secret');
    expect(JSON.stringify(body)).not.toContain('configured-client');
    expect(JSON.stringify(body)).not.toContain('WH-CONFIGURED');
  });

  it('accepts the offset timestamp shape returned by PostgreSQL for the latest webhook', async () => {
    webhooks.maybeSingle.mockResolvedValue({
      data: {
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        result: 'success',
        processed_at: '2026-08-11T21:12:00.123456+00:00',
      },
      error: null,
    });

    const response = await GET(buildRequest('/api/store/onboarding'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.lastWebhook).toEqual({
      result: 'success',
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      processedAt: '2026-08-11T21:12:00.123456+00:00',
    });
  });

  it('fails closed when webhook evidence has an invalid boundary shape', async () => {
    webhooks.maybeSingle.mockResolvedValue({
      data: { event_type: '', result: 'made-up', processed_at: 'not-a-date' },
      error: null,
    });

    const response = await GET(buildRequest('/api/store/onboarding'));
    expect(response.status).toBe(500);
  });
});
