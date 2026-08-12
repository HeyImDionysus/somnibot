/**
 * Draft products are editable while Discord is unverifiable (review 3691625831).
 *
 * The live-target validation exists so a SELLING product cannot grant a role
 * or channel the bot provably cannot assign. A draft (active: false) sells
 * nothing — validating it anyway returned 503 whenever the bot was offline
 * (no live snapshot) and 409 before Discord permissions were finished,
 * blocking owners from preparing products in advance. Activation re-validates.
 */
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
}));
// The bot is OFFLINE: no authoritative snapshot exists, so live validation
// reports `unavailable` — the exact state that blocked drafts with a 503.
vi.mock('@/lib/api/live-discord-facts', () => ({
  validateAssignableDiscordTargets: vi.fn(async () => ({
    ok: false,
    kind: 'unavailable',
    issues: ['Live Discord state is unavailable.'],
  })),
}));

import { POST } from '@/app/api/store/products/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { validateAssignableDiscordTargets } from '@/lib/api/live-discord-facts';

function supaDouble() {
  const chain: any = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'delete']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.insert = vi.fn(() => chain);
  chain.single = vi.fn(async () => ({
    data: { id: 'prod-1', name: 'Draft', active: false }, error: null,
  }));
  chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return { from: vi.fn(() => chain) };
}

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/store/products', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireGuildOwner).mockResolvedValue({
    ok: true,
    ctx: { guildId: 'guild-1', discordId: 'owner-1' },
  } as never);
  vi.mocked(createAdminSupabase).mockReturnValue(supaDouble() as never);
  vi.mocked(validateAssignableDiscordTargets).mockResolvedValue({
    ok: false,
    kind: 'unavailable',
    issues: ['Live Discord state is unavailable.'],
  } as never);
});

describe('POST /api/store/products — drafts skip live-target validation', () => {
  const DRAFT = {
    name: 'Prepared perk',
    type: 'free',
    delivery_type: 'file',
    price_cents: 0,
    granted_role_ids: ['123456789012345678'],
    active: false,
  };

  it('creates a draft with unverifiable targets while the bot is offline', async () => {
    const response = await POST(request(DRAFT));

    expect(response.status).not.toBe(503);
    expect(response.status).not.toBe(409);
    // The live check is deferred entirely — not merely tolerated.
    expect(validateAssignableDiscordTargets).not.toHaveBeenCalled();
  });

  it('still refuses a LIVE product with the same unverifiable targets', async () => {
    const response = await POST(request({ ...DRAFT, active: true }));

    expect(response.status).toBe(503);
    expect(validateAssignableDiscordTargets).toHaveBeenCalledTimes(1);
  });
});
