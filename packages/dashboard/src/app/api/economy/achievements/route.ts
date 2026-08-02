/**
 * /api/economy/achievements — CRUD for achievement definitions.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';

const achSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional().default(''),
  badge_emoji: z.string().max(10).optional().default('🏆'),
  condition_type: z.string().min(1).max(100),
  condition_value: z.number().int().min(1),
  reward_currency: z.number().int().min(0).optional().default(0),
  reward_xp: z.number().int().min(0).optional().default(0),
  hidden: z.boolean().optional().default(false),
});

export async function GET() {
  try {
    const auth = await requirePermission('dashboard.manage_economy');
    const supabase = createAdminSupabase();
    const { data, error } = await supabase
      .from('economy_achievement_defs')
      .select('*')
      .eq('guild_id', auth.guildId)
      .order('created_at', { ascending: true })
      .limit(500);
    if (error) return dbError(error, 'economy/achievements');
    return NextResponse.json({ data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const rateLimited = await checkAdminRateLimit(req, 'write');
    if (rateLimited) return rateLimited;

    const auth = await requirePermission('dashboard.manage_economy');
    const parsed = await parseBody(req, achSchema);
    if (!parsed.ok) return parsed.response;

    const supabase = createAdminSupabase();
    const { data, error } = await supabase
      .from('economy_achievement_defs')
      .insert({ ...parsed.data, guild_id: auth.guildId })
      .select()
      .single();
    if (error) return dbError(error, 'economy/achievements');
    await notifyBot(auth.guildId, 'economy');

    await recordCrudChange({
      guildId: auth.guildId,
      actorId: auth.discordId,
      operation: 'created',
      action: 'economy.achievement_created',
      table: 'economy_achievement_defs',
      targetType: 'achievement',
      targetId: (data as { id?: string } | null)?.id ?? null,
      label: (parsed.data as { name?: string }).name,
      after: data as Record<string, unknown> | null,
    }, supabase);
    return NextResponse.json({ data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const rateLimited = await checkAdminRateLimit(req, 'write');
    if (rateLimited) return rateLimited;

    const auth = await requirePermission('dashboard.manage_economy');
    const parsed = await parseBody(req, achSchema);
    if (!parsed.ok) return parsed.response;
    if (!parsed.data.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const supabase = createAdminSupabase();
    const { id, ...rest } = parsed.data;
    const before = await readRowBefore(supabase, 'economy_achievement_defs', { id, guild_id: auth.guildId });

    const { data, error } = await supabase
      .from('economy_achievement_defs')
      .update(rest)
      .eq('id', id)
      .eq('guild_id', auth.guildId)
      .select()
      .single();
    if (error) return dbError(error, 'economy/achievements');
    await notifyBot(auth.guildId, 'economy');

    await recordCrudChange({
      guildId: auth.guildId,
      actorId: auth.discordId,
      operation: 'updated',
      action: 'economy.achievement_updated',
      table: 'economy_achievement_defs',
      targetType: 'achievement',
      targetId: id,
      label: (before?.name as string | undefined) ?? (rest as { name?: string }).name,
      before,
      after: rest as Record<string, unknown>,
      match: { id, guild_id: auth.guildId },
    }, supabase);
    return NextResponse.json({ data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const rateLimited = await checkAdminRateLimit(req, 'write');
    if (rateLimited) return rateLimited;

    const auth = await requirePermission('dashboard.manage_economy');
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const supabase = createAdminSupabase();
    // Captured first: the row is hard-deleted, so this is the only copy left.
    const before = await readRowBefore(supabase, 'economy_achievement_defs', { id, guild_id: auth.guildId });

    const { error } = await supabase
      .from('economy_achievement_defs')
      .delete()
      .eq('id', id)
      .eq('guild_id', auth.guildId);
    if (error) return dbError(error, 'economy/achievements');
    await notifyBot(auth.guildId, 'economy');

    await recordCrudChange({
      guildId: auth.guildId,
      actorId: auth.discordId,
      operation: 'deleted',
      action: 'economy.achievement_deleted',
      table: 'economy_achievement_defs',
      targetType: 'achievement',
      targetId: id,
      label: before?.name as string | undefined,
      before,
      blastRadius: 'medium',
    }, supabase);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
