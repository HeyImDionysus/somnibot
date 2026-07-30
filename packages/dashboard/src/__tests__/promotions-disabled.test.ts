/**
 * Finding 8 — promotions must not promise a discount that checkout ignores.
 *
 * There is no redemption path anywhere: checkout prices the PayPal order from
 * `product.price_cents` and never reads `promotions` or writes
 * `orders.discount_cents`. Until redemption exists, the write surface is
 * refused server-side so a stale tab, a bookmark, or a direct API call cannot
 * publish a coupon code that will never be honoured.
 *
 * Read and delete stay open: existing rows must remain visible and removable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/admin-changes', () => ({
  readRowBefore: vi.fn(async () => null),
  recordCrudChange: vi.fn(async () => {}),
}));

import {
  DELETE as promotionsDELETE,
  GET as promotionsGET,
  POST as promotionsPOST,
  PUT as promotionsPUT,
} from '@/app/api/store/promotions/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { buildRequest, mockAuthSuccess, mockRateLimitPass } from './helpers';

const GUILD = 'guild-1';
const PROMO_ID = '00000000-0000-0000-0000-0000000000f1';

const existingRow = {
  id: PROMO_ID,
  guild_id: GUILD,
  name: 'Summer Sale',
  type: 'percentage',
  coupon_code: 'SUMMER25',
  value: 25,
};

let deletes: number;

function installSupabase() {
  deletes = 0;
  const from = vi.fn((table: string) => {
    if (table !== 'promotions') throw new Error(`unexpected table ${table}`);
    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(async () => ({ data: [existingRow], error: null })),
      insert: vi.fn(() => {
        throw new Error('promotions must never be inserted while disabled');
      }),
      update: vi.fn(() => {
        throw new Error('promotions must never be updated while disabled');
      }),
      delete: vi.fn(() => {
        deletes += 1;
        const del: Record<string, unknown> = {
          eq: vi.fn(() => del),
          then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
        };
        return del;
      }),
    };
    return chain;
  });
  vi.mocked(createAdminSupabase).mockReturnValue({ from } as never);
}

describe('/api/store/promotions while redemption does not exist', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRateLimitPass(vi.mocked(checkAdminRateLimit));
    mockAuthSuccess(vi.mocked(requireGuildOwner), { guildId: GUILD });
    installSupabase();
  });

  afterEach(() => vi.restoreAllMocks());

  it('refuses to create a promotion with 501 and a reason the operator can act on', async () => {
    const res = await promotionsPOST(
      buildRequest('/api/store/promotions', {
        method: 'POST',
        body: { name: 'Summer Sale', type: 'percent', value: 25, coupon_code: 'SUMMER25' },
      }) as never,
    );

    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/nothing in checkout redeems them/i);
    expect(body.error).toMatch(/full price/i);
  });

  it('refuses to update a promotion with 501', async () => {
    const res = await promotionsPUT(
      buildRequest('/api/store/promotions', {
        method: 'PUT',
        body: { id: PROMO_ID, value: 50 },
      }) as never,
    );

    expect(res.status).toBe(501);
    expect((await res.json()).success).toBe(false);
  });

  it('refuses a well-formed create just as firmly as a malformed one', async () => {
    // The old route 400'd on shape. A shape fix must not become a way in.
    const res = await promotionsPOST(
      buildRequest('/api/store/promotions', {
        method: 'POST',
        body: {
          name: 'Perfectly Valid',
          type: 'percent',
          value: 10,
          coupon_code: 'VALID10',
          applies_to_product_ids: [],
          applies_to_plan_ids: [],
          max_uses: 100,
          min_purchase_cents: 0,
          first_purchase_only: false,
          active: true,
        },
      }) as never,
    );

    expect(res.status).toBe(501);
  });

  it('still lists existing promotions so nothing is hidden', async () => {
    const res = await promotionsGET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual([existingRow]);
  });

  it('still deletes so a legacy row can be cleaned up', async () => {
    const res = await promotionsDELETE(
      buildRequest(`/api/store/promotions?id=${PROMO_ID}`, { method: 'DELETE' }) as never,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(deletes).toBe(1);
  });

  it('keeps the owner check and rate limit in front of the refusal', async () => {
    vi.mocked(requireGuildOwner).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);

    const res = await promotionsPOST(
      buildRequest('/api/store/promotions', { method: 'POST', body: { name: 'x' } }) as never,
    );

    // A 501 to an unauthenticated caller would leak that the route exists and
    // is owner-scoped; auth must still answer first.
    expect(res.status).toBe(401);
  });
});
