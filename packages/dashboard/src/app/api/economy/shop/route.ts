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
import { requirePermission } from '@/lib/rbac';
import { z } from 'zod';

const itemSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(256).nullable().optional(),
  emoji: z.string().min(1).max(64).optional(),
  category: z.enum(['Tools', 'Bait', 'Seeds', 'Materials', 'Consumables', 'Roles', 'Cosmetics', 'Lootboxes']).optional(),
  price: z.number().int().min(0).optional(),
  sell_price: z.number().int().min(0).optional(),
  stock: z.number().int().min(0).nullable().optional(),
  max_per_user: z.number().int().min(1).nullable().optional(),
  require_role_id: z.string().nullable().optional(),
  grant_role_id: z.string().nullable().optional(),
  usable: z.boolean().optional(),
  use_effect: z.object({
    type: z.string(),
    duration_minutes: z.number().optional(),
    multiplier: z.number().optional(),
    role_id: z.string().optional(),
    custom_data: z.record(z.unknown()).optional(),
  }).nullable().optional(),
  durability: z.number().int().min(1).nullable().optional(),
  tradeable: z.boolean().optional(),
  active: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('economy_items')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: data ?? [] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to load shop items';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const body = await request.json();
    const parsed = itemSchema.parse(body);

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
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: err.errors }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to create item';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const body = await request.json();

    const { id, ...fields } = body;
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ success: false, error: 'Missing item id' }, { status: 400 });
    }

    const parsed = itemSchema.partial().parse(fields);
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('economy_items')
      .update({ ...parsed, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('guild_id', ctx.guildId)
      .select('*')
      .single();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: err.errors }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Failed to update item';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ success: false, error: 'Missing item id' }, { status: 400 });
    }

    const admin = createAdminSupabase();

    const { error } = await admin
      .from('economy_items')
      .delete()
      .eq('id', id)
      .eq('guild_id', ctx.guildId);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to delete item';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
