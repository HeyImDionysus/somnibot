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
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';
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
let inserts: Record<string, unknown>[];
let updates: Record<string, unknown>[];
let deleteError: { code: string; message: string } | null;

function installSupabase() {
  deletes = 0;
  inserts = [];
  updates = [];
  deleteError = null;
  const from = vi.fn((table: string) => {
    let operation: 'read' | 'insert' | 'update' = 'read';
    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      in: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(async () => table === 'products'
        ? { data: [{ id: '00000000-0000-4000-8000-0000000000a1', type: 'one_time' }], error: null }
        : { data: [existingRow], error: null }),
      insert: vi.fn((value: Record<string, unknown>) => { operation = 'insert'; inserts.push(value); return chain; }),
      update: vi.fn((value: Record<string, unknown>) => { operation = 'update'; updates.push(value); return chain; }),
      delete: vi.fn(() => {
        deletes += 1;
        const del: Record<string, unknown> = {
          eq: vi.fn(() => del),
          then: (resolve: (v: unknown) => unknown) => resolve({ error: deleteError }),
        };
        return del;
      }),
      single: vi.fn(async () => ({
        data: operation === 'insert'
          ? { ...existingRow, ...inserts.at(-1) }
          : { ...existingRow, ...updates.at(-1) },
        error: null,
      })),
    };
    return chain;
  });
  vi.mocked(createAdminSupabase).mockReturnValue({ from } as never);
}

describe('/api/store/promotions checkout-enforced CRUD', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRateLimitPass(vi.mocked(checkAdminRateLimit));
    mockAuthSuccess(vi.mocked(requireGuildOwner), { guildId: GUILD });
    vi.mocked(readRowBefore).mockResolvedValue(existingRow);
    installSupabase();
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates a canonical promotion and writes an audit', async () => {
    const res = await promotionsPOST(
      buildRequest('/api/store/promotions', {
        method: 'POST',
        body: {
          name: 'Summer Sale', type: 'percentage', value: 25, coupon_code: 'SUMMER25',
          applies_to_product_ids: [], applies_to_plan_ids: [], start_date: null, end_date: null,
          max_uses: 100, min_purchase_cents: 0, first_purchase_only: false, active: true,
        },
      }) as never,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(inserts[0]).toMatchObject({ guild_id: GUILD, coupon_code: 'SUMMER25', current_uses: 0 });
    expect(recordCrudChange).toHaveBeenCalledWith(expect.objectContaining({ action: 'store.promotion_created' }), expect.anything());
  });

  it('updates the complete authoritative promotion contract', async () => {
    const res = await promotionsPUT(
      buildRequest('/api/store/promotions', {
        method: 'PUT',
        body: { id: PROMO_ID, promotion: {
          name: 'Summer Sale', type: 'percentage', value: 50, coupon_code: 'SUMMER25',
          applies_to_product_ids: [], applies_to_plan_ids: [], start_date: null, end_date: null,
          max_uses: 10, min_purchase_cents: 100, first_purchase_only: true, active: false,
        } },
      }) as never,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(updates[0]).toMatchObject({ value: 50, active: false, first_purchase_only: true });
  });

  it('rejects legacy percent shapes instead of silently changing their meaning', async () => {
    const res = await promotionsPOST(
      buildRequest('/api/store/promotions', {
        method: 'POST',
        body: {
          name: 'Legacy Shape',
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

    expect(res.status).toBe(400);
  });

  it('still lists existing promotions so nothing is hidden', async () => {
    const res = await promotionsGET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual([existingRow]);
  });

  it('deletes an unused promotion', async () => {
    const res = await promotionsDELETE(
      buildRequest(`/api/store/promotions?id=${PROMO_ID}`, { method: 'DELETE' }) as never,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(deletes).toBe(1);
  });

  it('archives a promotion when order history prevents deletion', async () => {
    deleteError = { code: '23503', message: 'orders_promotion_id_fkey' };

    const res = await promotionsDELETE(
      buildRequest(`/api/store/promotions?id=${PROMO_ID}`, { method: 'DELETE' }) as never,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, archived: true });
    expect(updates).toContainEqual({ active: false });
    expect(recordCrudChange).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'store.promotion_archived' }),
      expect.anything(),
    );
  });

  it('keeps the owner check and rate limit in front of writes', async () => {
    vi.mocked(requireGuildOwner).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);

    const res = await promotionsPOST(
      buildRequest('/api/store/promotions', { method: 'POST', body: { name: 'x' } }) as never,
    );

    expect(res.status).toBe(401);
  });
});
