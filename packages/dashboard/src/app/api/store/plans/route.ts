/**
 * /api/store/plans — Subscription plan CRUD.
 *
 * GET: List all plans (optionally filtered by product_id)
 * POST: Create a new plan
 * PUT: Update a plan
 * DELETE: Delete a plan by ID
 *
 * COMPLIANCE WALL: a paid ACTIVE plan is the one config change that can make a
 * subscription product chargeable WITHOUT touching the product row (the
 * product-side wall in /api/store/products only re-checks on product-field
 * changes). So before a paid active plan is written — created, re-priced,
 * re-activated, or moved to another product — this route re-runs the wall
 * against the parent product's granted roles. See commerce-income-wall.ts.
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
  metadataGrantRoleIds,
  type WallCheckResult,
} from '@/lib/api/commerce-income-wall';

/**
 * Compliance-wall check for a plan write. Call only when the EFFECTIVE plan
 * state (stored + updated values) is active with price_cents > 0 — a paid
 * active plan opens a real-money purchase path through its parent product.
 *
 * Resolves the parent product GUILD-SCOPED and blocks when the parent is a
 * currently-buyable-with-this-plan product (non-free, active) granting any
 * role that earns role-income. An INACTIVE parent does not block (it cannot
 * be bought); reactivating it re-runs the product-side wall, which treats a
 * non-free subscription as chargeable and catches the collision then — the
 * same reactivation dance as findPaidProductRoles.
 *
 * Returns null when the write may proceed, or an error response.
 */
async function checkPlanWall(
  supabase: SupabaseClient,
  guildId: string,
  productId: string,
): Promise<NextResponse | null> {
  const { data: product, error } = await supabase
    .from('products')
    .select('type, active, granted_role_ids, metadata')
    .eq('id', productId)
    .eq('guild_id', guildId)
    .maybeSingle();
  if (error) {
    return dbError(error, 'store/plans');
  }
  if (!product) {
    // Unknown or cross-guild product — never attach a paid plan to a product
    // this guild does not own (the wall could not be evaluated).
    return apiError('Product not found for this guild', 404);
  }

  if (product.type === 'free' || product.active === false) {
    // Not buyable even with a paid plan: free products move no real money,
    // and an inactive product cannot be bought. Reactivation re-runs the
    // product-side wall (subscriptions are treated as chargeable there).
    return null;
  }

  const rolesGranted = [
    ...((product.granted_role_ids as string[] | null) ?? []),
    ...metadataGrantRoleIds(product.metadata),
  ];
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

  // Compliance wall: a paid ACTIVE plan makes the parent product chargeable —
  // re-check the role-income overlap before writing it. Zero-price or inactive
  // plans open no purchase path and are not blocked (calibration: never block
  // config that moves no real money).
  if ((active ?? true) && price_cents > 0) {
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

  // Compliance wall: re-check whenever the update can turn this plan into (or
  // move) a paid ACTIVE plan — `price_cents` 0→paid, `active` false→true, or
  // `product_id` pointing the plan at a different parent. Effective values
  // (stored row + updates) decide, mirroring the product PUT wall.
  const PLAN_WALL_TRIGGER_FIELDS = ['price_cents', 'active', 'product_id'] as const;
  if (PLAN_WALL_TRIGGER_FIELDS.some((f) => f in updates)) {
    const { data: existingPlan, error: planErr } = await supabase
      .from('plans')
      .select('product_id, price_cents, active')
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

    // Only a paid ACTIVE plan opens a purchase path. (A missing plan row makes
    // effectiveProductId undefined — the update below then 404s naturally.)
    if (effectiveProductId && effectiveActive !== false && (effectivePrice ?? 0) > 0) {
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
