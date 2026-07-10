/**
 * /api/store/plans — Subscription plan CRUD.
 *
 * GET: List all plans (optionally filtered by product_id)
 * POST: Create a new plan
 * PUT: Update a plan
 * DELETE: Delete a plan by ID
 *
 * COMPLIANCE WALL: a chargeable plan is the one config change that can make a
 * subscription product buyable WITHOUT touching the product row (the
 * product-side wall in /api/store/products only re-checks on product-field
 * changes). So before a CHARGEABLE plan is written — created, re-priced,
 * re-activated, given a paypal_plan_id, or moved to another product — this
 * route re-runs the wall against the parent product's granted roles. See the
 * DECISION MATRIX in commerce-income-wall.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError, apiError } from '@/lib/api/response';
import {
  assertProductRolesNotIncomeEarning,
  isChargeablePlan,
  type WallCheckResult,
} from '@/lib/api/commerce-income-wall';

/**
 * Verify the target product exists AND belongs to the caller's guild.
 *
 * Every plan write that binds a plan to a product (POST create, PUT
 * product_id change) must pass this check regardless of the plan's
 * price/active state. The plan row always carries the CALLER'S guild_id but
 * product_id comes straight from the request body — without this check, a
 * plan created in guild B can attach to guild A's product, and the bot's
 * checkout (cheapest active plan for the product) would happily select it.
 *
 * Returns null when the write may proceed, or a 404/500 error response.
 */
async function requireGuildProduct(
  supabase: SupabaseClient,
  guildId: string,
  productId: string,
): Promise<NextResponse | null> {
  const { data: product, error } = await supabase
    .from('products')
    .select('id')
    .eq('id', productId)
    .eq('guild_id', guildId)
    .maybeSingle();
  if (error) {
    return dbError(error, 'store/plans');
  }
  if (!product) {
    return apiError('Product not found for this guild', 404);
  }
  return null;
}

/**
 * Compliance-wall check for a plan write. Call only when the EFFECTIVE plan
 * state (stored + updated values) is CHARGEABLE — active with price_cents > 0
 * or with a paypal_plan_id (checkout starts a subscription from the PayPal id
 * alone and charges PayPal's price, not our DB row) — because only a
 * chargeable plan opens a real-money purchase path through its parent.
 *
 * Resolves the parent product GUILD-SCOPED and blocks when the parent is an
 * ACTIVE SUBSCRIPTION granting any role that earns role-income. Other parents
 * never become buyable through a plan (verified against the checkout,
 * payment-handler.ts): a one-time purchase ignores `plans` entirely and
 * charges `products.price_cents`, and free products are refused at checkout —
 * so a plan write under those parents is inert and must not 409. An INACTIVE
 * subscription parent does not block either (it cannot be bought); flipping
 * it active re-runs the product-side wall, which now checks the stored plans
 * for chargeability and catches the collision then.
 *
 * Roles under test: `granted_role_ids` only (V1) — subscription activation
 * never consumes `metadata.grant_role_id` (V2 is a one-time-purchase vector).
 *
 * Returns null when the write may proceed, or an error response (fail CLOSED
 * on lookup errors).
 */
async function checkPlanWall(
  supabase: SupabaseClient,
  guildId: string,
  productId: string,
): Promise<NextResponse | null> {
  const { data: product, error } = await supabase
    .from('products')
    .select('type, active, granted_role_ids')
    .eq('id', productId)
    .eq('guild_id', guildId)
    .maybeSingle();
  if (error) {
    return dbError(error, 'store/plans');
  }
  if (!product) {
    // Unknown or cross-guild product — never attach a plan to a product this
    // guild does not own (the wall could not be evaluated).
    return apiError('Product not found for this guild', 404);
  }

  if (product.type !== 'subscription' || product.active === false) {
    // A plan cannot make this parent buyable (see the doc comment above).
    return null;
  }

  const rolesGranted = (product.granted_role_ids as string[] | null) ?? [];
  const wall: WallCheckResult = await assertProductRolesNotIncomeEarning(
    supabase,
    guildId,
    rolesGranted,
    true,
  );
  if (!wall.ok) {
    return apiError(wall.message, 409);
  }
  return null;
}

export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const productId = searchParams.get('product_id');

  let query = supabase
    .from('plans')
    .select('*')
    .eq('guild_id', guildId)
    .order('price_cents', { ascending: true })
    .limit(500);

  if (productId) {
    query = query.eq('product_id', productId);
  }

  const { data, error } = await query;

  if (error) {
    return dbError(error, 'store/plans');
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.plan.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const {
    product_id,
    name,
    paypal_plan_id,
    interval_unit,
    interval_count,
    price_cents,
    currency,
    trial_days,
    active,
  } = body;

  if (!product_id || !name || !interval_unit || price_cents == null) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: product_id, name, interval_unit, price_cents' },
      { status: 400 },
    );
  }

  // Cross-guild injection guard: ALWAYS verify product ownership before
  // insert — for zero-price and inactive plans too, not only chargeable ones.
  const notOwned = await requireGuildProduct(supabase, guildId, product_id);
  if (notOwned) return notOwned;

  // Compliance wall: a CHARGEABLE plan (active, and priced > 0 or carrying a
  // paypal_plan_id) makes the parent subscription buyable — re-check the
  // role-income overlap before writing it. Inactive plans, and zero-price
  // plans with no PayPal id, open no purchase path and are not blocked
  // (calibration: never block config that moves no real money).
  if (isChargeablePlan({ active: active ?? true, price_cents, paypal_plan_id })) {
    const blocked = await checkPlanWall(supabase, guildId, product_id);
    if (blocked) return blocked;
  }

  const { data, error } = await supabase
    .from('plans')
    .insert({
      product_id,
      guild_id: guildId,
      name,
      paypal_plan_id: paypal_plan_id ?? null,
      interval_unit,
      interval_count: interval_count ?? 1,
      price_cents,
      currency: currency ?? 'USD',
      trial_days: trial_days ?? 0,
      active: active ?? true,
    })
    .select()
    .single();

  if (error) {
    return dbError(error, 'store/plans');
  }

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  // Validate with plan.create schema (all fields optional for update) + required id
  const planUpdateSchema = schemas.plan.create.partial().extend({ id: z.string().uuid() });
  const parsed = await parseBody(req, planUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const { id, ...updates } = parsed.data;

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing plan id' }, { status: 400 });
  }

  // Cross-guild injection guard on re-parenting: changing product_id must
  // never point this guild's plan at another guild's product.
  if (updates.product_id) {
    const notOwned = await requireGuildProduct(supabase, guildId, updates.product_id);
    if (notOwned) return notOwned;
  }

  // Compliance wall: re-check whenever the update can turn this plan into (or
  // move) a CHARGEABLE plan — `price_cents` 0→paid, `active` false→true,
  // `paypal_plan_id` set on a previously chargeless plan, or `product_id`
  // pointing the plan at a different parent. Effective values (stored row +
  // updates) decide, mirroring the product PUT wall.
  const PLAN_WALL_TRIGGER_FIELDS = ['price_cents', 'active', 'product_id', 'paypal_plan_id'] as const;
  if (PLAN_WALL_TRIGGER_FIELDS.some((f) => f in updates)) {
    const { data: existingPlan, error: planErr } = await supabase
      .from('plans')
      .select('product_id, price_cents, active, paypal_plan_id')
      .eq('id', id)
      .eq('guild_id', guildId)
      .maybeSingle();
    if (planErr) {
      return dbError(planErr, 'store/plans');
    }

    const pick = <K extends string>(key: K, fallback: unknown) =>
      (key in updates ? (updates as Record<string, unknown>)[key] : fallback);

    const effectiveProductId = pick('product_id', existingPlan?.product_id) as string | undefined;
    const effectivePrice = pick('price_cents', existingPlan?.price_cents) as number | undefined;
    const effectiveActive = pick('active', existingPlan?.active) as boolean | undefined;
    const effectivePayPalPlanId = pick('paypal_plan_id', existingPlan?.paypal_plan_id) as
      | string
      | undefined;

    // Only a CHARGEABLE plan opens a purchase path. (A missing plan row makes
    // effectiveProductId undefined — the update below then 404s naturally.)
    if (
      effectiveProductId &&
      isChargeablePlan({
        active: effectiveActive,
        price_cents: effectivePrice,
        paypal_plan_id: effectivePayPalPlanId,
      })
    ) {
      const blocked = await checkPlanWall(supabase, guildId, effectiveProductId);
      if (blocked) return blocked;
    }
  }

  const { data, error } = await supabase
    .from('plans')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return dbError(error, 'store/plans');
  }

  return NextResponse.json({ success: true, data });
}

export async function DELETE(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing plan id' }, { status: 400 });
  }

  const { error } = await supabase
    .from('plans')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return dbError(error, 'store/plans');
  }

  return NextResponse.json({ success: true });
}
