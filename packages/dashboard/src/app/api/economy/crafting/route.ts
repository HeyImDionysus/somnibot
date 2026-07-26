/**
 * /api/economy/crafting — CRUD for crafting recipes.
 *
 * GET    — List all recipes
 * POST   — Create a new recipe
 * PUT    — Update an existing recipe
 * DELETE — Delete a recipe (by { id } in body)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody } from '@/lib/api/validation';
import { dbError, dbConflictOr500, apiServerError} from '@/lib/api/response';

const recipeInputSchema = z.object({
  item_name: z.string().min(1).max(64),
  qty: z.number().int().min(1).max(999),
});

const recipeSchema = z.object({
  name: z.string().min(1).max(64),
  emoji: z.string().min(1).max(64).optional(),
  description: z.string().max(256).nullable().optional(),
  inputs: z.array(recipeInputSchema).min(1).max(10),
  output_item_id: z.string().uuid().nullable().optional(),
  output_qty: z.number().int().min(1).max(100).optional(),
  cooldown_seconds: z.number().int().min(0).max(86400).optional(),
  category: z.string().min(1).max(32).optional(),
  active: z.boolean().optional(),
});

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('economy_recipes')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .order('category')
      .order('name')
      .limit(500);

    if (error) {
      return dbError(error, 'economy/crafting');
    }

    return NextResponse.json({ success: true, recipes: data ?? [] });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/crafting');
  }
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const result = await parseBody(request, recipeSchema);
    if (!result.ok) return result.response;
    const parsed = result.data;

    const admin = createAdminSupabase();

    // Limit: max 50 recipes per guild
    const { count } = await admin
      .from('economy_recipes')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId);

    if ((count ?? 0) >= 50) {
      return NextResponse.json({ success: false, error: 'Maximum 50 recipes reached.' }, { status: 400 });
    }

    const { data, error } = await admin
      .from('economy_recipes')
      .insert({
        ...parsed,
        inputs: parsed.inputs,
        guild_id: ctx.guildId,
      })
      .select('*')
      .single();

    if (error) {
      return dbConflictOr500(error, 'economy/crafting', 'uq_economy_recipes_guild_lname',
        'A recipe with that name already exists (names are case-insensitive).');
    }

    await notifyBot('economy');
    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/crafting');
  }
}

export async function PUT(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const putSchema = z.object({ id: z.string().uuid() }).merge(recipeSchema.partial());
    const result = await parseBody(request, putSchema);
    if (!result.ok) return result.response;
    const { id, ...parsed } = result.data;
    const admin = createAdminSupabase();

    const updateData: Record<string, unknown> = {
      ...parsed,
      updated_at: new Date().toISOString(),
    };
    if (parsed.inputs) {
      updateData.inputs = parsed.inputs;
    }

    const { data, error } = await admin
      .from('economy_recipes')
      .update(updateData)
      .eq('id', id)
      .eq('guild_id', ctx.guildId)
      .select('*')
      .single();

    if (error) {
      return dbConflictOr500(error, 'economy/crafting', 'uq_economy_recipes_guild_lname',
        'A recipe with that name already exists (names are case-insensitive).');
    }

    await notifyBot('economy');
    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/crafting');
  }
}

export async function DELETE(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const deleteSchema = z.object({ id: z.string().uuid() });
    const result = await parseBody(request, deleteSchema);
    if (!result.ok) return result.response;
    const { id } = result.data;

    const admin = createAdminSupabase();

    const { error } = await admin
      .from('economy_recipes')
      .delete()
      .eq('id', id)
      .eq('guild_id', ctx.guildId);

    if (error) {
      return dbError(error, 'economy/crafting');
    }

    await notifyBot('economy');
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/crafting');
  }
}
