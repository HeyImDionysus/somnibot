/**
 * /api/store/promotions — Promotion/Coupon CRUD.
 *
 * GET: List all promotions
 * POST: Create a promotion
 * PUT: Update a promotion
 * DELETE: Delete a promotion
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';


export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('promotions')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
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
  const parsed = await parseBody(req, schemas.promotion.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const {
    name,
    type,
    value,
    coupon_code,
    applies_to_product_ids,
    applies_to_plan_ids,
    start_date,
    end_date,
    max_uses,
    min_purchase_cents,
    first_purchase_only,
    active,
  } = body;

  if (!name || !type || value == null) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: name, type, value' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('promotions')
    .insert({
      guild_id: guildId,
      name,
      type,
      value,
      coupon_code: coupon_code ?? null,
      applies_to_product_ids: applies_to_product_ids ?? [],
      applies_to_plan_ids: applies_to_plan_ids ?? [],
      start_date: start_date ?? null,
      end_date: end_date ?? null,
      max_uses: max_uses ?? null,
      min_purchase_cents: min_purchase_cents ?? null,
      first_purchase_only: first_purchase_only ?? false,
      active: active ?? true,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
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

  // Validate shape — use innerType() to get the raw ZodObject before .refine(),
  // so .partial() works correctly. Cross-field validation is done manually below.
  const promoUpdateSchema = schemas.promotion.create.innerType().partial().extend({ id: z.string().uuid() });
  const parsed = await parseBody(req, promoUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const { id, ...updates } = parsed.data;

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing promotion id' }, { status: 400 });
  }

  // If value is being updated, enforce percent ≤ 100 using the effective type
  // (either from the payload or fetched from DB).
  if (updates.value !== undefined) {
    let effectiveType = updates.type;
    if (!effectiveType) {
      const { data: existing } = await supabase
        .from('promotions')
        .select('type')
        .eq('id', id)
        .eq('guild_id', guildId)
        .single();
      effectiveType = existing?.type;
    }
    if (effectiveType === 'percent' && updates.value > 100) {
      return NextResponse.json(
        { success: false, error: 'Percent discount cannot exceed 100%' },
        { status: 400 },
      );
    }
  }

  const { data, error } = await supabase
    .from('promotions')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
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
    return NextResponse.json({ success: false, error: 'Missing promotion id' }, { status: 400 });
  }

  const { error } = await supabase
    .from('promotions')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
