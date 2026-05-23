/**
 * /api/economy/adventures — CRUD for adventure types.
 *
 * GET    — List all adventures
 * POST   — Create a new adventure
 * PUT    — Update an existing adventure
 * DELETE — Delete an adventure (by ?id= query param)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';

const adventureSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(64),
  emoji: z.string().min(1).max(64).optional(),
  description: z.string().max(256).nullable().optional(),
  adventure_type: z.enum(['dungeon', 'forest', 'ocean', 'space', 'mountain']).optional(),
  difficulty: z.enum(['easy', 'normal', 'hard', 'legendary']).optional(),
  min_scenes: z.number().int().min(1).max(30).optional(),
  max_scenes: z.number().int().min(1).max(30).optional(),
  active: z.boolean().optional(),
});

export async function GET() {
  const ctx = await requirePermission('dashboard.manage_economy');
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('economy_adventures')
    .select('*')
    .eq('guild_id', ctx.guildId)
    .order('adventure_type')
    .order('name')
    .limit(500);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const ctx = await requirePermission('dashboard.manage_economy');
  const body = await request.json();
  const parsed = adventureSchema.parse(body);

  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from('economy_adventures')
    .insert({
      guild_id: ctx.guildId,
      name: parsed.name,
      emoji: parsed.emoji ?? '⚔️',
      description: parsed.description ?? null,
      adventure_type: parsed.adventure_type ?? 'dungeon',
      difficulty: parsed.difficulty ?? 'normal',
      min_scenes: parsed.min_scenes ?? 5,
      max_scenes: parsed.max_scenes ?? 10,
      active: parsed.active ?? true,
    })
    .select('*')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await notifyBot('economy');
  return NextResponse.json({ data }, { status: 201 });
}

export async function PUT(request: NextRequest) {
  const ctx = await requirePermission('dashboard.manage_economy');
  const body = await request.json();
  const parsed = adventureSchema.parse(body);

  if (!parsed.id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const supabase = createAdminSupabase();
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.name !== undefined) updateData.name = parsed.name;
  if (parsed.emoji !== undefined) updateData.emoji = parsed.emoji;
  if (parsed.description !== undefined) updateData.description = parsed.description;
  if (parsed.adventure_type !== undefined) updateData.adventure_type = parsed.adventure_type;
  if (parsed.difficulty !== undefined) updateData.difficulty = parsed.difficulty;
  if (parsed.min_scenes !== undefined) updateData.min_scenes = parsed.min_scenes;
  if (parsed.max_scenes !== undefined) updateData.max_scenes = parsed.max_scenes;
  if (parsed.active !== undefined) updateData.active = parsed.active;

  const { data, error } = await supabase
    .from('economy_adventures')
    .update(updateData)
    .eq('id', parsed.id)
    .eq('guild_id', ctx.guildId)
    .select('*')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await notifyBot('economy');
  return NextResponse.json({ data });
}

export async function DELETE(request: NextRequest) {
  const ctx = await requirePermission('dashboard.manage_economy');
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const supabase = createAdminSupabase();
  const { error } = await supabase
    .from('economy_adventures')
    .delete()
    .eq('id', id)
    .eq('guild_id', ctx.guildId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await notifyBot('economy');
  return NextResponse.json({ success: true });
}
