/**
 * /api/store/plans — subscription plan CRUD.
 *
 * Every mutation evaluates complete post-write plan sets for the affected
 * source and destination products before writing. The database trigger remains
 * authoritative for concurrent writes and direct database changes.
 */
import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError, apiError, apiServerError } from '@/lib/api/response';
import { humanizeColumn, readRowBefore, recordAdminChange } from '@/lib/admin-changes';
import {
  assertProductRolesNotIncomeEarning,
  COMMERCE_INCOME_WALL_MESSAGE,
  evaluateEffectivePostWriteProduct,
  isCommerceIncomeWallConflictError,
  loadProductPlans,
  loadProductTemporaryRoleIds,
  type PlanWallFields,
  type ProductWallFields,
} from '@/lib/api/commerce-income-wall';

interface GuildProductRow extends ProductWallFields {
  id: string;
  temporaryRoleIds: string[];
}

interface GuildPlanRow extends PlanWallFields {
  product_id: string;
}

type ProductLoadResult =
  | { ok: true; value: GuildProductRow }
  | { ok: false; response: NextResponse };

type PlanLoadResult =
  | { ok: true; value: GuildPlanRow }
  | { ok: false; response: NextResponse };

function commerceWriteError(error: { message: string; code?: string }) {
  if (isCommerceIncomeWallConflictError(error)) {
    return apiError(COMMERCE_INCOME_WALL_MESSAGE, 409);
  }
  return dbError(error, 'store/plans');
}

/**
 * Why no plan change offers an undo button.
 *
 * The undo route replays a stored payload as a row update, but only against
 * tables listed in `UNDO_TABLE_COLUMNS` — and `plans` is not one of them.
 * Attaching an undo anyway would be silently dropped at record time and shown
 * as a generic "no safe reversal exists"; saying it plainly here tells the
 * owner what to actually do instead.
 */
const PLAN_UNDO_REASON =
  'subscription plans are outside the dashboard undo system — edit the plan again to change it back';

/** `1999, 'USD'` → `"19.99 USD"` — the real-money amount a subscriber is charged. */
function formatRealMoney(cents: number, currency: string): string {
  const whole = Math.trunc(Math.abs(cents) / 100);
  const fraction = String(Math.abs(cents) % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${whole}.${fraction} ${currency.toUpperCase()}`;
}

/** "every month" / "every 3 months" — the billing cadence in plain words. */
function describeInterval(unit: string, count: number): string {
  const noun = unit.toLowerCase();
  return count === 1 ? `every ${noun}` : `every ${count} ${noun}s`;
}

async function loadGuildProduct(
  supabase: SupabaseClient,
  guildId: string,
  productId: string,
): Promise<ProductLoadResult> {
  const { data, error } = await supabase
    .from('products')
    .select('id, type, active, price_cents, granted_role_ids')
    .eq('id', productId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) return { ok: false, response: dbError(error, 'store/plans') };
  if (!data) {
    return {
      ok: false,
      response: apiError('Product not found for this guild', 404),
    };
  }
  if (typeof data.id !== 'string' || data.id !== productId) {
    return {
      ok: false,
      response: apiServerError(new Error('product lookup returned invalid identity'), 'store/plans'),
    };
  }
  try {
    const temporaryRoleIds = await loadProductTemporaryRoleIds(supabase, guildId, productId);
    return {
      ok: true,
      value: { ...(data as unknown as ProductWallFields), id: productId, temporaryRoleIds },
    };
  } catch (err) {
    return { ok: false, response: apiServerError(err, 'store/plans') };
  }
}

async function loadGuildPlan(
  supabase: SupabaseClient,
  guildId: string,
  planId: string,
): Promise<PlanLoadResult> {
  const { data, error } = await supabase
    .from('plans')
    .select('id, product_id, active, price_cents, paypal_plan_id')
    .eq('id', planId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) return { ok: false, response: dbError(error, 'store/plans') };
  if (!data) {
    return {
      ok: false,
      response: apiError('Plan not found for this guild', 404),
    };
  }
  if (
    typeof data.id !== 'string' ||
    data.id !== planId ||
    typeof data.product_id !== 'string' ||
    data.product_id.length === 0
  ) {
    return {
      ok: false,
      response: apiServerError(new Error('plan lookup returned invalid identity'), 'store/plans'),
    };
  }
  return { ok: true, value: data as unknown as GuildPlanRow };
}

async function checkPostWriteProduct(
  supabase: SupabaseClient,
  guildId: string,
  product: GuildProductRow,
  plans: PlanWallFields[],
): Promise<NextResponse | null> {
  const evaluation = evaluateEffectivePostWriteProduct(
    product,
    plans,
    product.temporaryRoleIds,
  );
  const wall = await assertProductRolesNotIncomeEarning(supabase, guildId, evaluation);
  return wall.ok ? null : apiError(wall.message, 409);
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
    .order('id', { ascending: true })
    .limit(500);

  if (productId) query = query.eq('product_id', productId);
  const { data, error } = await query;
  if (error) return dbError(error, 'store/plans');
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
  const id = crypto.randomUUID();

  try {
    const productResult = await loadGuildProduct(supabase, guildId, body.product_id);
    if (!productResult.ok) return productResult.response;

    const currentPlans = await loadProductPlans(supabase, guildId, body.product_id);
    const candidate: PlanWallFields = {
      id,
      active: body.active ?? true,
      price_cents: body.price_cents,
      paypal_plan_id: body.paypal_plan_id ?? null,
    };
    const blocked = await checkPostWriteProduct(
      supabase,
      guildId,
      productResult.value,
      [...currentPlans, candidate],
    );
    if (blocked) return blocked;
  } catch (err) {
    return apiServerError(err, 'store/plans');
  }

  const { data, error } = await supabase
    .from('plans')
    .insert({
      id,
      product_id: body.product_id,
      guild_id: guildId,
      name: body.name,
      paypal_plan_id: body.paypal_plan_id ?? null,
      interval_unit: body.interval_unit,
      interval_count: body.interval_count ?? 1,
      price_cents: body.price_cents,
      currency: body.currency ?? 'USD',
      trial_days: body.trial_days ?? 0,
      active: body.active ?? true,
    })
    .select()
    .single();

  if (error) return commerceWriteError(error);

  await recordAdminChange(
    {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'store.plan_created',
      targetType: 'subscription plan',
      targetId: id,
      description:
        `Created the subscription plan "${body.name}" — subscribers are charged `
        + `${formatRealMoney(body.price_cents, body.currency ?? 'USD')} in real money `
        + `${describeInterval(body.interval_unit, body.interval_count ?? 1)}`,
      after: data as Record<string, unknown> | null,
      blastRadius: 'medium',
      undoReason:
        'a newly created subscription plan cannot be removed by an undo — delete it '
        + 'from the product\'s plan list instead',
    },
    supabase,
  );

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.plan.update);
  if (!parsed.ok) return parsed.response;
  const { id, ...updates } = parsed.data;

  const existingResult = await loadGuildPlan(supabase, guildId, id);
  if (!existingResult.ok) return existingResult.response;
  const existing = existingResult.value;

  const effectiveProductId = updates.product_id ?? existing.product_id;
  const effectivePlan: PlanWallFields = {
    id,
    active: 'active' in updates ? updates.active as boolean : existing.active,
    price_cents:
      'price_cents' in updates ? updates.price_cents as number : existing.price_cents,
    paypal_plan_id:
      'paypal_plan_id' in updates
        ? updates.paypal_plan_id ?? null
        : existing.paypal_plan_id,
  };

  try {
    const sourceProductResult = await loadGuildProduct(
      supabase,
      guildId,
      existing.product_id,
    );
    if (!sourceProductResult.ok) return sourceProductResult.response;
    const sourcePlans = await loadProductPlans(supabase, guildId, existing.product_id);
    if (!sourcePlans.some((plan) => plan.id === id)) {
      throw new Error('plans lookup failed: edited plan missing from source plan set');
    }

    if (effectiveProductId === existing.product_id) {
      const sourcePostWrite = sourcePlans.map((plan) =>
        plan.id === id ? effectivePlan : plan,
      );
      const blocked = await checkPostWriteProduct(
        supabase,
        guildId,
        sourceProductResult.value,
        sourcePostWrite,
      );
      if (blocked) return blocked;
    } else {
      const destinationProductResult = await loadGuildProduct(
        supabase,
        guildId,
        effectiveProductId,
      );
      if (!destinationProductResult.ok) return destinationProductResult.response;
      const destinationPlans = await loadProductPlans(
        supabase,
        guildId,
        effectiveProductId,
      );

      const sourceBlocked = await checkPostWriteProduct(
        supabase,
        guildId,
        sourceProductResult.value,
        sourcePlans.filter((plan) => plan.id !== id),
      );
      if (sourceBlocked) return sourceBlocked;

      const destinationBlocked = await checkPostWriteProduct(
        supabase,
        guildId,
        destinationProductResult.value,
        [...destinationPlans, effectivePlan],
      );
      if (destinationBlocked) return destinationBlocked;
    }
  } catch (err) {
    return apiServerError(err, 'store/plans');
  }

  // Prior values are captured BEFORE the write — read afterwards they would
  // just be the values that were written.
  const before = await readRowBefore(supabase, 'plans', { id, guild_id: guildId });

  const { data, error } = await supabase
    .from('plans')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) return commerceWriteError(error);

  const changedFields = Object.keys(updates).map(humanizeColumn);
  const pricingChanged = 'price_cents' in updates
    || 'currency' in updates
    || 'active' in updates
    || 'interval_unit' in updates
    || 'interval_count' in updates;

  await recordAdminChange(
    {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'store.plan_updated',
      targetType: 'subscription plan',
      targetId: id,
      description:
        `Updated the subscription plan "${(before?.name as string | undefined) ?? id}"`
        + (changedFields.length > 0 ? ` (${changedFields.join(', ')})` : '')
        + (pricingChanged
          ? ' — this changes what subscribers are charged in real money from their next bill'
          : ''),
      before,
      after: updates as Record<string, unknown>,
      blastRadius: pricingChanged ? 'high' : 'medium',
      undoReason: PLAN_UNDO_REASON,
    },
    supabase,
  );

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
  if (!id) return apiError('Missing plan id', 400);

  const existingResult = await loadGuildPlan(supabase, guildId, id);
  if (!existingResult.ok) return existingResult.response;
  const existing = existingResult.value;

  try {
    const productResult = await loadGuildProduct(supabase, guildId, existing.product_id);
    if (!productResult.ok) return productResult.response;
    const currentPlans = await loadProductPlans(supabase, guildId, existing.product_id);
    if (!currentPlans.some((plan) => plan.id === id)) {
      throw new Error('plans lookup failed: deleted plan missing from source plan set');
    }
    const blocked = await checkPostWriteProduct(
      supabase,
      guildId,
      productResult.value,
      currentPlans.filter((plan) => plan.id !== id),
    );
    if (blocked) return blocked;
  } catch (err) {
    return apiServerError(err, 'store/plans');
  }

  // The whole row, read before it is destroyed — the change history is the only
  // place the deleted plan survives.
  const before = await readRowBefore(supabase, 'plans', { id, guild_id: guildId });

  const { error } = await supabase
    .from('plans')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) return commerceWriteError(error);

  await recordAdminChange(
    {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'store.plan_deleted',
      targetType: 'subscription plan',
      targetId: id,
      description:
        `Deleted the subscription plan "${(before?.name as string | undefined) ?? id}" — `
        + 'nobody can start a new subscription on it',
      before,
      blastRadius: 'high',
      undoReason:
        'the plan row was permanently deleted, so there is nothing to restore it into — '
        + 'create the plan again to offer it',
    },
    supabase,
  );

  return NextResponse.json({ success: true });
}
