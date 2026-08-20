/**
 * /api/store/promotions — Promotion/Coupon CRUD.
 *
 * GET: List all promotions
 * POST: Create an enforceable one-time-product coupon
 * PUT: Update an enforceable one-time-product coupon
 * DELETE: Delete an unused promotion or archive one with order history
 *
 * Checkout reserves and freezes the authoritative discounted integer-cent
 * amount before contacting PayPal. The order records promotion_id and
 * discount_cents in the same transaction that binds the provider checkout.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbConflictOr500, dbError } from '@/lib/api/response';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';
import { parseBody, schemas } from '@/lib/api/validation';

const promotionUpdateSchema = z.object({
  id: z.string().uuid(),
  promotion: schemas.promotion.create,
}).strict();

async function productsBelongToGuild(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  productIds: readonly string[],
): Promise<boolean> {
  if (productIds.length === 0) return true;
  const { data, error } = await supabase
    .from('products')
    .select('id, type')
    .eq('guild_id', guildId)
    .in('id', [...productIds])
    .limit(100);
  return !error
    && (data ?? []).length === new Set(productIds).size
    && (data ?? []).every((product) => product.type === 'one_time');
}

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
    return dbError(error, 'store/promotions');
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  const { guildId, discordId } = auth.ctx;
  const parsed = await parseBody(req, schemas.promotion.create);
  if (!parsed.ok) return parsed.response;
  const supabase = createAdminSupabase();
  if (!await productsBelongToGuild(supabase, guildId, parsed.data.applies_to_product_ids ?? [])) {
    return NextResponse.json({ success: false, error: 'Selected products must be one-time products from this server.' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('promotions')
    .insert({ ...parsed.data, guild_id: guildId, current_uses: 0 })
    .select('*')
    .single();
  if (error) return dbConflictOr500(error, 'store/promotions', 'promotions_guild_coupon_code_key', 'That coupon code is already in use.');

  await recordCrudChange({
    guildId,
    actorId: discordId,
    operation: 'created',
    action: 'store.promotion_created',
    table: 'promotions',
    targetType: 'promotion',
    targetId: data.id,
    label: data.name,
    after: data as Record<string, unknown>,
  }, supabase);
  return NextResponse.json({ success: true, data }, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  const { guildId, discordId } = auth.ctx;
  const parsed = await parseBody(req, promotionUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const supabase = createAdminSupabase();
  if (!await productsBelongToGuild(supabase, guildId, parsed.data.promotion.applies_to_product_ids ?? [])) {
    return NextResponse.json({ success: false, error: 'Selected products must be one-time products from this server.' }, { status: 400 });
  }
  const before = await readRowBefore(supabase, 'promotions', { id: parsed.data.id, guild_id: guildId });
  if (!before) return NextResponse.json({ success: false, error: 'Promotion not found.' }, { status: 404 });

  const { data, error } = await supabase
    .from('promotions')
    .update(parsed.data.promotion)
    .eq('id', parsed.data.id)
    .eq('guild_id', guildId)
    .select('*')
    .single();
  if (error) return dbConflictOr500(error, 'store/promotions', 'promotions_guild_coupon_code_key', 'That coupon code is already in use.');

  await recordCrudChange({
    guildId,
    actorId: discordId,
    operation: 'updated',
    action: 'store.promotion_updated',
    table: 'promotions',
    targetType: 'promotion',
    targetId: parsed.data.id,
    label: data.name,
    before,
    after: data as Record<string, unknown>,
    match: { id: parsed.data.id, guild_id: guildId },
  }, supabase);
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

  // V6 Audit §2.3: Validate UUID format before sending to DB
  const uuidCheck = z.string().uuid().safeParse(id);
  if (!uuidCheck.success) {
    return NextResponse.json({ success: false, error: 'Invalid promotion id format' }, { status: 400 });
  }

  const before = await readRowBefore(supabase, 'promotions', { id: id, guild_id: auth.ctx.guildId });
  if (!before) return NextResponse.json({ success: false, error: 'Promotion not found.' }, { status: 404 });

  const { error } = await supabase
    .from('promotions')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  let archived = false;
  if (error?.code === '23503') {
    const { data, error: archiveError } = await supabase
      .from('promotions')
      .update({ active: false })
      .eq('id', id)
      .eq('guild_id', guildId)
      .select('*')
      .single();
    if (archiveError) return dbError(archiveError, 'store/promotions');
    archived = true;
    await recordCrudChange({
      guildId,
      actorId: auth.ctx.discordId,
      operation: 'updated',
      action: 'store.promotion_archived',
      table: 'promotions',
      targetType: 'promotion',
      targetId: id,
      label: data.name,
      before,
      after: data as Record<string, unknown>,
      match: { id, guild_id: guildId },
      blastRadius: 'medium',
    }, supabase);
  } else if (error) {
    return dbError(error, 'store/promotions');
  }

  if (!archived) await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'deleted',
    action: 'store.promotion_deleted',
    table: 'promotions',
    targetType: 'promotion',
    targetId: id,
    label: before?.coupon_code as string | undefined,

    before,
    blastRadius: 'medium',
  }, supabase);

  return NextResponse.json({ success: true, archived });
}
