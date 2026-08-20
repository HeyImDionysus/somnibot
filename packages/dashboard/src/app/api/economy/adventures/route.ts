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

const adventureLootSchema = z.object({
  item_name: z.string().min(1).max(64),
  qty: z.number().int().min(1).max(999),
  chance_pct: z.number().int().min(0).max(100),
});

const adventureChoiceSchema = z.object({
  label: z.string().min(1).max(80),
  emoji: z.string().max(64).optional().default('➡️'),
  next_scene_index: z.number().int().min(0).max(29).nullable(),
  loot: z.array(adventureLootSchema).max(10).optional().default([]),
  currency: z.number().int().min(0).max(1_000_000).optional().default(0),
  damage_pct: z.number().int().min(0).max(100).optional().default(0),
  requires_item: z.string().max(64).nullable().optional().default(null),
});

const adventureSceneSchema = z.object({
  text: z.string().min(1).max(2000),
  image_url: z.string().url().max(2048).nullable().optional().default(null),
  choices: z.array(adventureChoiceSchema).max(5).optional().default([]),
  loot: z.array(adventureLootSchema).max(10).optional().default([]),
  is_ending: z.boolean().optional().default(false),
  ending_type: z.enum(['success', 'death', 'partial']).nullable().optional().default(null),
});

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
  scenes: z.array(adventureSceneSchema).min(2).max(30),
}).superRefine((adventure, ctx) => {
  const finalIndex = adventure.scenes.length - 1;
  if (!adventure.scenes[finalIndex]?.is_ending) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', finalIndex, 'is_ending'], message: 'The final scene must end the adventure' });
  }
  adventure.scenes.forEach((scene, sceneIndex) => {
    if (!scene.is_ending && scene.choices.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', sceneIndex, 'choices'], message: 'Non-ending scenes need at least one choice' });
    }
    scene.choices.forEach((choice, choiceIndex) => {
      if (choice.next_scene_index !== null && choice.next_scene_index >= adventure.scenes.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', sceneIndex, 'choices', choiceIndex, 'next_scene_index'], message: 'Choice points to a missing scene' });
      }
    });
  });
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
    const adventureIds = (data ?? []).map((adventure) => adventure.id);
    const { data: scenes, error: scenesError } = adventureIds.length > 0
      ? await supabase
          .from('economy_adventure_scenes')
          .select('*')
          .in('adventure_id', adventureIds)
          .order('scene_index')
          .limit(15_000)
      : { data: [], error: null };
    if (scenesError) return dbError(scenesError, 'economy/adventures/scenes');
    const sceneRows = (scenes ?? []) as Array<Record<string, unknown> & { adventure_id: string }>;
    const scenesByAdventure = new Map<string, Array<Record<string, unknown> & { adventure_id: string }>>();
    for (const scene of sceneRows) {
      const list = scenesByAdventure.get(scene.adventure_id) ?? [];
      list.push(scene);
      scenesByAdventure.set(scene.adventure_id, list);
    }
    return NextResponse.json({
      data: (data ?? []).map((adventure) => ({
        ...adventure,
        scenes: scenesByAdventure.get(adventure.id) ?? [],
      })),
    });
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
    const { data: adventureId, error: writeError } = await supabase.rpc('upsert_economy_adventure_graph', {
      p_guild_id: ctx.guildId,
      p_adventure: parsed,
    });
    if (writeError) return dbConflictOr500(writeError, 'economy/adventures', 'uq_economy_adventures_guild_lname',
        'An adventure with that name already exists (names are case-insensitive).');
    const { data, error } = await supabase
      .from('economy_adventures')
      .select('*')
      .eq('id', adventureId)
      .eq('guild_id', ctx.guildId)
      .single();

    if (error) return dbConflictOr500(error, 'economy/adventures', 'uq_economy_adventures_guild_lname',
        'An adventure with that name already exists (names are case-insensitive).');
    await notifyBot(ctx.guildId, 'economy');

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
    const before = await readRowBefore(supabase, 'economy_adventures', { id: parsed.id, guild_id: ctx.guildId });
    const { error: writeError } = await supabase.rpc('upsert_economy_adventure_graph', {
      p_guild_id: ctx.guildId,
      p_adventure: parsed,
    });
    if (writeError?.code === '55006' && writeError.message.includes('adventure_has_active_sessions')) {
      return NextResponse.json({ error: 'This adventure cannot be edited while a member is actively playing it.' }, { status: 409 });
    }
    if (writeError) return dbConflictOr500(writeError, 'economy/adventures', 'uq_economy_adventures_guild_lname',
        'An adventure with that name already exists (names are case-insensitive).');
    const { data, error } = await supabase
      .from('economy_adventures')
      .select('*')
      .eq('id', parsed.id)
      .eq('guild_id', ctx.guildId)
      .single();

    if (error) return dbConflictOr500(error, 'economy/adventures', 'uq_economy_adventures_guild_lname',
        'An adventure with that name already exists (names are case-insensitive).');
    await notifyBot(ctx.guildId, 'economy');

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
      after: data as Record<string, unknown> | null,
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
    await notifyBot(ctx.guildId, 'economy');

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
