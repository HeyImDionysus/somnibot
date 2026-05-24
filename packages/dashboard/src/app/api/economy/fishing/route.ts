/**
 * /api/economy/fishing — CRUD for fish species.
 *
 * GET    — List all species
 * POST   — Create a new species
 * PUT    — Update an existing species
 * DELETE — Delete a species (by ?id= query param)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody } from '@/lib/api/validation';

const speciesSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(64),
  emoji: z.string().min(1).max(64).optional(),
  rarity: z.enum(['common', 'uncommon', 'rare', 'epic', 'legendary']).optional(),
  min_weight: z.number().min(0.01).max(10000).optional(),
  max_weight: z.number().min(0.01).max(10000).optional(),
  base_price: z.number().int().min(1).max(1000000).optional(),
  active: z.boolean().optional(),
});

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const supabase = createAdminSupabase();

    const { data, error } = await supabase
      .from('economy_fish_species')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .order('rarity')
      .order('name')
      .limit(500);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const rateLimited = await checkAdminRateLimit(request, 'write');
    if (rateLimited) return rateLimited;

    const ctx = await requirePermission('dashboard.manage_economy');
    const result = await parseBody(request, speciesSchema);
    if (!result.ok) return result.response;
    const parsed = result.data;

    const supabase = createAdminSupabase();
    const { data, error } = await supabase
      .from('economy_fish_species')
      .insert({
        guild_id: ctx.guildId,
        name: parsed.name,
        emoji: parsed.emoji ?? '🐟',
        rarity: parsed.rarity ?? 'common',
        min_weight: parsed.min_weight ?? 0.5,
        max_weight: parsed.max_weight ?? 5.0,
        base_price: parsed.base_price ?? 10,
        active: parsed.active ?? true,
      })
      .select('*')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await notifyBot('economy');
    return NextResponse.json({ data }, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const rateLimited = await checkAdminRateLimit(request, 'write');
    if (rateLimited) return rateLimited;

    const ctx = await requirePermission('dashboard.manage_economy');
    const result = await parseBody(request, speciesSchema);
    if (!result.ok) return result.response;
    const parsed = result.data;

    if (!parsed.id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const supabase = createAdminSupabase();
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.name !== undefined) updateData.name = parsed.name;
    if (parsed.emoji !== undefined) updateData.emoji = parsed.emoji;
    if (parsed.rarity !== undefined) updateData.rarity = parsed.rarity;
    if (parsed.min_weight !== undefined) updateData.min_weight = parsed.min_weight;
    if (parsed.max_weight !== undefined) updateData.max_weight = parsed.max_weight;
    if (parsed.base_price !== undefined) updateData.base_price = parsed.base_price;
    if (parsed.active !== undefined) updateData.active = parsed.active;

    const { data, error } = await supabase
      .from('economy_fish_species')
      .update(updateData)
      .eq('id', parsed.id)
      .eq('guild_id', ctx.guildId)
      .select('*')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await notifyBot('economy');
    return NextResponse.json({ data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const rateLimited = await checkAdminRateLimit(request, 'write');
    if (rateLimited) return rateLimited;

    const ctx = await requirePermission('dashboard.manage_economy');
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const supabase = createAdminSupabase();
    const { error } = await supabase
      .from('economy_fish_species')
      .delete()
      .eq('id', id)
      .eq('guild_id', ctx.guildId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await notifyBot('economy');
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
