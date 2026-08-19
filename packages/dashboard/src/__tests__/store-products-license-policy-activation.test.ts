import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn(async () => null) }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn(async () => {}) }));
vi.mock('@/lib/paypal', () => ({
  getPayPalRuntimeConfig: vi.fn(async () => ({ clientId: 'x', clientSecret: 'y', webhookId: 'z' })),
  getPayPalToken: vi.fn(async () => 'token'),
}));
vi.mock('@/lib/admin-changes', () => ({
  recordAdminChange: vi.fn(async () => {}),
  recordCrudChange: vi.fn(async () => {}),
  readRowBefore: vi.fn(async () => null),
  undoByRestoring: vi.fn(() => ({ kind: 'db' })),
}));
vi.mock('@/lib/api/commerce-income-wall', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertProductRolesNotIncomeEarning: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/api/license-delivery-rail', () => ({
  requiresLicenseConfig: vi.fn(() => false),
  ensureLicenseConfigProvisioned: vi.fn(async () => ({ ok: true })),
  ensureLicenseDeliveryConfigOrDisable: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/api/live-discord-facts', () => ({
  validateAssignableDiscordTargets: vi.fn(async () => ({ ok: true })),
}));

import { PUT } from '@/app/api/store/products/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

const productId = '00000000-0000-4000-8000-000000000789';

function pendingProductDouble(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({
    data: {
      type: 'subscription',
      delivery_type: 'license_key',
      granted_role_ids: [],
      granted_channel_ids: [],
      active: false,
      metadata: {
        completed_project_licensing: {
          plansAndFeatures: 'Annual Pro',
          outputFormats: '',
          policyPending: true,
        },
      },
      ...overrides,
    },
    error: null,
  }));
  return { from: vi.fn(() => chain) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireGuildOwner).mockResolvedValue({
    ok: true,
    ctx: { guildId: 'guild-1', discordId: 'owner-1' },
  } as never);
  vi.mocked(createAdminSupabase).mockReturnValue(pendingProductDouble() as never);
});

describe('PUT /api/store/products licensing-policy activation gate', () => {
  it('refuses activation while the dashboard-created policy is pending', async () => {
    const response = await PUT(new Request('http://localhost/api/store/products', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: productId, active: true }),
    }) as never);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Save and verify the requested license policy before activating this product.',
    });
  });

  it('refuses generic metadata replacement while policy recovery is pending', async () => {
    const response = await PUT(new Request('http://localhost/api/store/products', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: productId, metadata: { note: 'replacement' } }),
    }) as never);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Complete license policy recovery before replacing product metadata.',
    });
  });

  it('refuses conversion to dynamic delivery without an inactive pending-policy lock', async () => {
    vi.mocked(createAdminSupabase).mockReturnValue(pendingProductDouble({
      delivery_type: 'file',
      active: true,
      metadata: {},
    }) as never);

    const response = await PUT(new Request('http://localhost/api/store/products', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: productId, delivery_type: 'license_key', active: true }),
    }) as never);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Dynamic conversion must remain inactive until its requested license policy is saved.',
    });
  });
});
