import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const mocks = vi.hoisted(() => ({
  createAdminSupabase: vi.fn(),
  requireGuildOwner: vi.fn(),
  checkAdminRateLimit: vi.fn(),
  isSoleInstanceOperator: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: mocks.createAdminSupabase }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: mocks.requireGuildOwner }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: mocks.checkAdminRateLimit }));
vi.mock('@/app/api/webhooks/scope', () => ({ isSoleInstanceOperator: mocks.isSoleInstanceOperator }));

import { DELETE, GET, PUT } from '@/app/api/settings/route';
import {
  createMockSupabase,
  mockAuthSuccess,
  mockAuthUnauthorized,
  mockRateLimited,
  mockRateLimitPass,
  registerTable,
} from './helpers';

let mock: ReturnType<typeof createMockSupabase>;

beforeEach(() => {
  vi.resetAllMocks();
  mock = createMockSupabase();
  mocks.createAdminSupabase.mockReturnValue(mock);
  mockRateLimitPass(mocks.checkAdminRateLimit);
  mockAuthSuccess(mocks.requireGuildOwner);
  mocks.isSoleInstanceOperator.mockResolvedValue(true);
});

function settingsRequest(method: 'DELETE' | 'PUT', body: unknown): NextRequest {
  return new NextRequest('https://dashboard.test/api/settings', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/settings', () => {
  it('returns masked connection state while retaining source metadata', async () => {
    vi.stubEnv('DISCORD_TOKEN', 'env-token');
    registerTable(mock, 'instance_settings').limit.mockResolvedValue({
      data: [{
        key: 'discord_bot_token_encrypted',
        value: 'encrypted-payload',
        section: 'discord',
      }],
      error: null,
    });
    registerTable(mock, 'guild').single.mockResolvedValue({ data: null, error: null });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      values: { discord_bot_token: '••••••••' },
      sources: { discord_bot_token: 'db' },
      environmentFallbacks: { discord_bot_token: true },
    });
  });

  it('does not expose retained encrypted checkout-secret history', async () => {
    registerTable(mock, 'instance_settings').limit.mockResolvedValue({
      data: [{
        key: 'paypal_client_secret_v1_previous_encrypted',
        value: 'somnibot-cloud-v1:encrypted-history',
        section: 'paypal',
      }],
      error: null,
    });
    registerTable(mock, 'guild').single.mockResolvedValue({ data: null, error: null });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain('encrypted-history');
  });

  it('fails closed when authoritative saved settings cannot be loaded', async () => {
    registerTable(mock, 'instance_settings').limit.mockResolvedValue({
      data: null,
      error: { message: 'read failed' },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await GET();

    expect(response.status).toBe(500);
    errorSpy.mockRestore();
  });
});

describe.each(['PUT', 'DELETE'] as const)('%s /api/settings', (method) => {
  it('rejects installation mutations and identifies Launcher authority', async () => {
    const response = method === 'PUT'
      ? await PUT(settingsRequest(method, { section: 'discord', values: { discord_bot_token: 'replacement' } }))
      : await DELETE(settingsRequest(method, { section: 'discord', keys: ['discord_bot_token'] }));

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    await expect(response.json()).resolves.toMatchObject({ authority: 'launcher' });
    expect(mock._query.upsert).not.toHaveBeenCalled();
    expect(mock._query.delete).not.toHaveBeenCalled();
  });

  it('preserves authentication and installation-operator boundaries', async () => {
    mockAuthUnauthorized(mocks.requireGuildOwner);

    const unauthorized = method === 'PUT'
      ? await PUT(settingsRequest(method, {}))
      : await DELETE(settingsRequest(method, {}));

    expect(unauthorized.status).toBe(401);

    mockAuthSuccess(mocks.requireGuildOwner);
    mocks.isSoleInstanceOperator.mockResolvedValue(false);
    const forbidden = method === 'PUT'
      ? await PUT(settingsRequest(method, {}))
      : await DELETE(settingsRequest(method, {}));

    expect(forbidden.status).toBe(403);
  });

  it('retains the write-rate limit before authorization work', async () => {
    mockRateLimited(mocks.checkAdminRateLimit);

    const response = method === 'PUT'
      ? await PUT(settingsRequest(method, {}))
      : await DELETE(settingsRequest(method, {}));

    expect(response.status).toBe(429);
    expect(mocks.requireGuildOwner).not.toHaveBeenCalled();
  });
});
