/**
 * /api/store/plans — Subscription plan CRUD.
 *
 * GET: List all plans (optionally filtered by product_id)
 * POST: Create a new plan
 * PUT: Update a plan
 * DELETE: Delete a plan by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError, apiError } from '@/lib/api/response';

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
