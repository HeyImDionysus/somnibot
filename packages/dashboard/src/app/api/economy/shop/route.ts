/**
 * /api/economy/shop — CRUD for economy shop items.
 *
 * GET    — List all items (active + inactive)
 * POST   — Create a new item
 * PATCH  — Update an existing item
 * DELETE — Delete an item (removes from inventory too via CASCADE)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody } from '@/lib/api/validation';
import { dbError, dbConflictOr500, apiServerError } from '@/lib/api/response';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';
import { discordSnowflakeSchema } from '@/lib/api/discord-values';
import { ECONOMY_AUTOMATIC_ITEM_EFFECT_TYPES } from '@somnibot/shared/constants/economy';

const automaticEffectSchema = z.object({
  type: z.enum(ECONOMY_AUTOMATIC_ITEM_EFFECT_TYPES),
  tier: z.number().int().min(1).max(10).optional(),
});

const amountEffectSchema = z.object({
  type: z.enum(['wallet_credit', 'xp_credit']),
  amount: z.number().int().min(1).max(1_000_000_000),
});

const roleEffectSchema = z.object({
  type: z.literal('role_grant'),
  role_id: discordSnowflakeSchema,
});

const itemEffectSchema = z.union([
  automaticEffectSchema,
  amountEffectSchema,
  roleEffectSchema,
]);

const itemSchemaBase = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(256).nullable().optional(),
  emoji: z.string().min(1).max(64).optional(),
  category: z.enum(['Tools', 'Bait', 'Seeds', 'Materials', 'Consumables', 'Roles', 'Cosmetics', 'Lootboxes', 'Protection', 'Farming', 'Accessories']).optional(),
  price: z.number().int().min(0).optional(),
  sell_price: z.number().int().min(0).optional(),
  stock: z.number().int().min(0).nullable().optional(),
  max_per_user: z.number().int().min(1).nullable().optional(),
  require_role_id: discordSnowflakeSchema.nullable().optional(),
  grant_role_id: discordSnowflakeSchema.nullable().optional(),
  usable: z.boolean().optional(),
  use_effect: itemEffectSchema.nullable().optional(),
  durability: z.number().int().min(1).nullable().optional(),
  tradeable: z.boolean().optional(),
  active: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

function validateItemBehavior(
  item: Partial<z.infer<typeof itemSchemaBase>>,
  ctx: z.RefinementCtx,
): void {
  const effect = item.use_effect;
  const manual = effect != null && ['wallet_credit', 'xp_credit', 'role_grant'].includes(effect.type);
  if (manual && item.usable !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['usable'],
      message: 'Consumable effects must be usable',
    });
  }
  if (!manual && item.usable === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['usable'],
      message: 'Only consumable effects can be manually used',
    });
  }
}

const itemSchema = itemSchemaBase.superRefine(validateItemBehavior);

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('economy_items')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(500);

    if (error) {
      return dbError(error, 'economy/shop');
    }

    return NextResponse.json({ success: true, data: data ?? [] });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/shop');
  }
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const result = await parseBody(request, itemSchema);
    if (!result.ok) return result.response;
    const parsed = result.data;

    const admin = createAdminSupabase();

    // Check item count limit (max 100 items per guild)
    const { count } = await admin
      .from('economy_items')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId);

    if ((count ?? 0) >= 100) {
      return NextResponse.json({ success: false, error: 'Maximum 100 shop items reached.' }, { status: 400 });
    }

    const { data, error } = await admin
      .from('economy_items')
      .insert({ ...parsed, guild_id: ctx.guildId })
      .select('*')
      .single();

    if (error) {
      return dbConflictOr500(error, 'economy/shop', 'uq_economy_items_guild_lname',
        'An item with that name already exists (names are case-insensitive).');
    }

    await notifyBot(ctx.guildId, 'economy');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'created',
      action: 'shop.item_created',
      table: 'economy_items',
      targetType: 'shop item',
      targetId: (data as { id?: string } | null)?.id ?? null,
      label: parsed.name,
      after: data as Record<string, unknown> | null,
    }, admin);

    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/shop');
  }
}

export async function PATCH(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const patchSchema = z.object({ id: z.string().uuid() }).merge(itemSchemaBase.partial());
    const result = await parseBody(request, patchSchema);
    if (!result.ok) return result.response;
    const { id, ...parsed } = result.data;
    const admin = createAdminSupabase();

    const before = await readRowBefore(admin, 'economy_items', { id, guild_id: ctx.guildId });
    if (!before) {
      return NextResponse.json({ success: false, error: 'Shop item not found.' }, { status: 404 });
    }

    const completeItem = itemSchema.safeParse({ ...before, ...parsed });
    if (!completeItem.success) {
      return NextResponse.json({
        success: false,
        error: completeItem.error.issues[0]?.message ?? 'Invalid item behavior.',
      }, { status: 400 });
    }

    const { data, error } = await admin
      .from('economy_items')
      .update({ ...parsed, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('guild_id', ctx.guildId)
      .select('*')
      .single();

    if (error) {
      return dbConflictOr500(error, 'economy/shop', 'uq_economy_items_guild_lname',
        'An item with that name already exists (names are case-insensitive).');
    }

    await notifyBot(ctx.guildId, 'economy');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'updated',
      action: 'shop.item_updated',
      table: 'economy_items',
      targetType: 'shop item',
      targetId: id,
      label: (before?.name as string | undefined) ?? parsed.name,
      before,
      after: parsed as Record<string, unknown>,
      match: { id, guild_id: ctx.guildId },
    }, admin);

    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/shop');
  }
}

export async function DELETE(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ success: false, error: 'Missing item id' }, { status: 400 });
    }

    const admin = createAdminSupabase();

    // Capture the whole row first — once it is gone this record is the only
    // remaining copy of what the item was.
    const before = await readRowBefore(admin, 'economy_items', { id, guild_id: ctx.guildId });

    const { error } = await admin
      .from('economy_items')
      .delete()
      .eq('id', id)
      .eq('guild_id', ctx.guildId);

    if (error) {
      return dbError(error, 'economy/shop');
    }

    await notifyBot(ctx.guildId, 'economy');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'deleted',
      action: 'shop.item_deleted',
      table: 'economy_items',
      targetType: 'shop item',
      targetId: id,
      label: before?.name as string | undefined,
      before,
      blastRadius: 'medium',
    }, admin);

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/shop');
  }
}
