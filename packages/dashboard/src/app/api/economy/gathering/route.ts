/**
 * /api/economy/gathering — CRUD for loot table entries.
 *
 * GET    — List all loot table entries for the guild
 * POST   — Create a new loot entry
 * PUT    — Update an existing loot entry
 * DELETE — Delete a loot entry (by { id } in body)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';

const SOURCE_TYPES = ['hunt', 'dig', 'mine'] as const;
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;

const lootEntrySchema = z.object({
  source_type: z.enum(SOURCE_TYPES),
  item_name: z.string().min(1).max(64),
  emoji: z.string().min(1).max(64).optional(),
  rarity: z.enum(RARITIES).optional(),
  min_qty: z.number().int().min(1).max(999).optional(),
  max_qty: z.number().int().min(1).max(999).optional(),
  weight: z.number().int().min(1).max(10000).optional(),
  tool_tier: z.number().int().min(0).max(10).optional(),
  sell_value: z.number().int().min(0).max(1000000).optional(),
  gives_item_id: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
}).refine(
  // FIX #11: Cross-validate min_qty ≤ max_qty to prevent random(10, 5)
  // which may return 0 or error depending on the implementation.
  (data) => {
    if (data.min_qty !== undefined && data.max_qty !== undefined) {
      return data.min_qty <= data.max_qty;
    }
    return true;
  },
  { message: 'min_qty must be less than or equal to max_qty', path: ['min_qty'] },
);

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('economy_loot_tables')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .order('source_type')
      .order('rarity')
      .order('item_name')
      .limit(500);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, entries: data ?? [] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to load loot tables';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const body = await request.json();
    const parsed = lootEntrySchema.parse(body);

    const admin = createAdminSupabase();

    // Limit: max 200 loot entries per guild
    const { count } = await admin
      .from('economy_loot_tables')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId);

    if ((count ?? 0) >= 200) {
      return NextResponse.json({ success: false, error: 'Maximum 200 loot entries reached.' }, { status: 400 });
    }

    const { data, error } = await admin
      .from('economy_loot_tables')
      .insert({
        ...parsed,
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
    const message = err instanceof Error ? err.message : 'Failed to create loot entry';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const body = await request.json();

    const { id, ...fields } = body;
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ success: false, error: 'Missing entry id' }, { status: 400 });
    }

    const parsed = lootEntrySchema.partial().parse(fields);
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('economy_loot_tables')
      .update({
        ...parsed,
      })
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
    const message = err instanceof Error ? err.message : 'Failed to update loot entry';
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
      .from('economy_loot_tables')
      .delete()
      .eq('id', id)
      .eq('guild_id', ctx.guildId);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    await notifyBot('economy');
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to delete loot entry';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
