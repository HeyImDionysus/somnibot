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
import { requirePermission } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';

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
      .order('name');

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, recipes: data ?? [] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to load recipes';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const body = await request.json();
    const parsed = recipeSchema.parse(body);

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
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    await notifyBot('economy');
    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: err.errors }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to create recipe';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const body = await request.json();

    const { id, ...fields } = body;
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ success: false, error: 'Missing recipe id' }, { status: 400 });
    }

    const parsed = recipeSchema.partial().parse(fields);
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
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    await notifyBot('economy');
    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: err.errors }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to update recipe';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const rawBody = await request.json().catch(() => null);
    const deleteSchema = z.object({ id: z.string().uuid() });
    const parseResult = deleteSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return NextResponse.json(
        { success: false, error: parseResult.error.issues.map(i => i.message).join(', ') },
        { status: 400 },
      );
    }
    const { id } = parseResult.data;

    const admin = createAdminSupabase();

    const { error } = await admin
      .from('economy_recipes')
      .delete()
      .eq('id', id)
      .eq('guild_id', ctx.guildId);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    await notifyBot('economy');
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to delete recipe';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
