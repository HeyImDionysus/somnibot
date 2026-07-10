/**
 * Cross-guild plan injection guard for /api/store/plans.
 *
 * A plan row always carries the CALLER'S guild_id, but product_id comes
 * straight from the request body. Without a guild-scoped product ownership
 * check, guild B's owner can attach a plan to guild A's product; because the
 * bot's checkout query picks the cheapest active plan for a product, a $0
 * active injected plan (with an attacker-controlled paypal_plan_id) hijacks
 * guild A's subscription checkout.
 *
 * These tests pin: POST always verifies product_id belongs to the caller's
 * guild (404 otherwise, even for zero-price/inactive plans — the shapes the
 * paid+active compliance wall does not cover), and PUT applies the same check
 * when re-parenting a plan via product_id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { POST, PUT } from '@/app/api/store/plans/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

import {
  buildRequest,
  createMockSupabase,
  mockAuthSuccess,
  mockRateLimitPass,
  registerTable,
} from './helpers';

const CALLER_GUILD = 'guild-1';
const PRODUCT_ID = '00000000-0000-0000-0000-00000000000a';
const PLAN_ID = '00000000-0000-0000-0000-00000000000b';

const basePlanBody = {
  product_id: PRODUCT_ID,
  name: 'Monthly',
  interval_unit: 'MONTH',
  price_cents: 500,
};

describe('/api/store/plans — cross-guild product_id injection', () => {
  let mock: ReturnType<typeof createMockSupabase>;
  let productsTable: ReturnType<typeof registerTable>;
  let plansTable: ReturnType<typeof registerTable>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockSupabase();
    productsTable = registerTable(mock, 'products');
    plansTable = registerTable(mock, 'plans');
    // Route chains .insert(...).select().single() / .update(...).eq...select().single()
    plansTable.insert.mockReturnValue(plansTable);
    plansTable.select.mockReturnValue(plansTable);
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: CALLER_GUILD });
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  });

  describe('POST', () => {
    it('404s and never inserts when product_id is unknown or owned by another guild', async () => {
      // Guild-scoped lookup finds nothing: the product exists only in another guild.
      productsTable.maybeSingle.mockResolvedValue({ data: null, error: null });

      const res = await POST(buildRequest('/api/store/plans', {
        method: 'POST',
        body: basePlanBody,
      }) as never);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.success).toBe(false);
      expect(plansTable.insert).not.toHaveBeenCalled();
      // The ownership lookup itself must be guild-scoped.
      expect(productsTable.eq).toHaveBeenCalledWith('id', PRODUCT_ID);
      expect(productsTable.eq).toHaveBeenCalledWith('guild_id', CALLER_GUILD);
    });

    it('404s cross-guild attachment even for a ZERO-PRICE INACTIVE plan (wall-exempt shape)', async () => {
      // price_cents: 0 + active: false is exactly the shape the paid+active
      // compliance wall skips — ownership must still be enforced here.
      productsTable.maybeSingle.mockResolvedValue({ data: null, error: null });

      const res = await POST(buildRequest('/api/store/plans', {
        method: 'POST',
        body: { ...basePlanBody, price_cents: 0, active: false },
      }) as never);

      expect(res.status).toBe(404);
      expect(plansTable.insert).not.toHaveBeenCalled();
    });

    it('creates the plan when the product belongs to the caller guild', async () => {
      productsTable.maybeSingle.mockResolvedValue({ data: { id: PRODUCT_ID }, error: null });
      plansTable.single.mockResolvedValue({
        data: { id: PLAN_ID, ...basePlanBody, guild_id: CALLER_GUILD },
        error: null,
      });

      const res = await POST(buildRequest('/api/store/plans', {
        method: 'POST',
        body: basePlanBody,
      }) as never);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(plansTable.insert).toHaveBeenCalledWith(expect.objectContaining({
        product_id: PRODUCT_ID,
        guild_id: CALLER_GUILD,
      }));
    });
  });

  describe('PUT', () => {
    it('404s and never updates when re-parenting to a cross-guild product_id', async () => {
      productsTable.maybeSingle.mockResolvedValue({ data: null, error: null });

      const res = await PUT(buildRequest('/api/store/plans', {
        method: 'PUT',
        body: { id: PLAN_ID, product_id: PRODUCT_ID },
      }) as never);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.success).toBe(false);
      expect(plansTable.update).not.toHaveBeenCalled();
      expect(productsTable.eq).toHaveBeenCalledWith('id', PRODUCT_ID);
      expect(productsTable.eq).toHaveBeenCalledWith('guild_id', CALLER_GUILD);
    });

    it('applies the update when re-parenting to a product the caller guild owns', async () => {
      productsTable.maybeSingle.mockResolvedValue({ data: { id: PRODUCT_ID }, error: null });
      plansTable.single.mockResolvedValue({
        data: { id: PLAN_ID, product_id: PRODUCT_ID, guild_id: CALLER_GUILD },
        error: null,
      });

      const res = await PUT(buildRequest('/api/store/plans', {
        method: 'PUT',
        body: { id: PLAN_ID, product_id: PRODUCT_ID },
      }) as never);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(plansTable.update).toHaveBeenCalledWith(
        expect.objectContaining({ product_id: PRODUCT_ID }),
      );
      // Plan update itself stays guild-scoped.
      expect(plansTable.eq).toHaveBeenCalledWith('guild_id', CALLER_GUILD);
    });

    it('does not consult products when product_id is not being changed', async () => {
      plansTable.single.mockResolvedValue({
        data: { id: PLAN_ID, name: 'Renamed', guild_id: CALLER_GUILD },
        error: null,
      });

      const res = await PUT(buildRequest('/api/store/plans', {
        method: 'PUT',
        body: { id: PLAN_ID, name: 'Renamed' },
      }) as never);

      expect(res.status).toBe(200);
      expect(productsTable.maybeSingle).not.toHaveBeenCalled();
    });
  });
});
