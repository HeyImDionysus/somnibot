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
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody } from '@/lib/api/validation';
import { dbError, dbConflictOr500 } from '@/lib/api/response';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';

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
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const supabase = createAdminSupabase();

    const { data, error } = await supabase
      .from('economy_adventures')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .order('adventure_type')
      .order('name')
      .limit(500);

    if (error) return dbError(error, 'economy/adventures');
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
    const result = await parseBody(request, adventureSchema);
    if (!result.ok) return result.response;
    const parsed = result.data;

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

    if (error) return dbConflictOr500(error, 'economy/adventures', 'uq_economy_adventures_guild_lname',
        'An adventure with that name already exists (names are case-insensitive).');
    await notifyBot('economy');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'created',
      action: 'economy.adventure_created',
      table: 'economy_adventures',
      targetType: 'adventure',
      targetId: (data as { id?: string } | null)?.id ?? null,
      label: undefined,
      after: data as Record<string, unknown> | null,
    }, supabase);
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
    const result = await parseBody(request, adventureSchema);
    if (!result.ok) return result.response;
    const parsed = result.data;

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

    const before = await readRowBefore(supabase, 'economy_adventures', { id: parsed.id, guild_id: ctx.guildId });

    const { data, error } = await supabase
      .from('economy_adventures')
      .update(updateData)
      .eq('id', parsed.id)
      .eq('guild_id', ctx.guildId)
      .select('*')
      .single();

    if (error) return dbConflictOr500(error, 'economy/adventures', 'uq_economy_adventures_guild_lname',
        'An adventure with that name already exists (names are case-insensitive).');
    await notifyBot('economy');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'updated',
      action: 'economy.adventure_updated',
      table: 'economy_adventures',
      targetType: 'adventure',
      targetId: parsed.id,
      label: (before?.name as string | undefined),
      before,
      after: (updateData ?? {}) as Record<string, unknown>,
      match: { id: parsed.id, guild_id: ctx.guildId },
    }, supabase);
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
    const before = await readRowBefore(supabase, 'economy_adventures', { id: id, guild_id: ctx.guildId });

    const { error } = await supabase
      .from('economy_adventures')
      .delete()
      .eq('id', id)
      .eq('guild_id', ctx.guildId);

    if (error) return dbError(error, 'economy/adventures');
    await notifyBot('economy');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'deleted',
      action: 'economy.adventure_deleted',
      table: 'economy_adventures',
      targetType: 'adventure',
      targetId: id,
      label: (before?.name as string | undefined),
      before,
      blastRadius: 'medium',
    }, supabase);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
