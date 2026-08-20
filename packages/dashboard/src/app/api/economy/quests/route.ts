/**
 * /api/economy/quests — CRUD for quest templates.
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

const questSchema = z.object({
  id: z.string().uuid().optional(),
  quest_type: z.enum(['daily', 'weekly']),
  title: z.string().min(1).max(200),
  description: z.string().max(500).optional().default(''),
  action_type: z.enum([
    'work', 'crime', 'fish', 'gather', 'craft', 'farm', 'adventure', 'market_trade',
    'shop_buy', 'chat', 'gamble', 'heist', 'lottery', 'poll_vote', 'pet_feed',
    'pet_train', 'trivia',
  ]),
  target_count: z.number().int().min(1),
  reward_currency: z.number().int().min(0),
  reward_xp: z.number().int().min(0),
  required_module: z.string().nullable().optional().default(null),
  active: z.boolean().optional().default(true),
});

export async function GET() {
  try {
    const auth = await requirePermission('dashboard.manage_economy');
    const supabase = createAdminSupabase();
    const { data, error } = await supabase
      .from('economy_quest_templates')
      .select('*')
      .eq('guild_id', auth.guildId)
      .order('created_at', { ascending: true })
      .limit(500);
    if (error) return dbError(error, 'economy/quests');
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
    const parsed = await parseBody(req, questSchema);
    if (!parsed.ok) return parsed.response;

    const supabase = createAdminSupabase();
    const { data, error } = await supabase
      .from('economy_quest_templates')
      .insert({ ...parsed.data, guild_id: auth.guildId })
      .select()
      .single();
    if (error) return dbError(error, 'economy/quests');
    await notifyBot(auth.guildId, 'economy');

    await recordCrudChange({
      guildId: auth.guildId,
      actorId: auth.discordId,
      operation: 'created',
      action: 'economy.quest_created',
      table: 'economy_quest_templates',
      targetType: 'quest',
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
    const parsed = await parseBody(req, questSchema);
    if (!parsed.ok) return parsed.response;
    if (!parsed.data.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const supabase = createAdminSupabase();
    const { id, ...rest } = parsed.data;
    const before = await readRowBefore(supabase, 'economy_quest_templates', { id, guild_id: auth.guildId });

    const { data, error } = await supabase
      .from('economy_quest_templates')
      .update(rest)
      .eq('id', id)
      .eq('guild_id', auth.guildId)
      .select()
      .single();
    if (error) return dbError(error, 'economy/quests');
    await notifyBot(auth.guildId, 'economy');

    await recordCrudChange({
      guildId: auth.guildId,
      actorId: auth.discordId,
      operation: 'updated',
      action: 'economy.quest_updated',
      table: 'economy_quest_templates',
      targetType: 'quest',
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
    const before = await readRowBefore(supabase, 'economy_quest_templates', { id, guild_id: auth.guildId });

    const { error } = await supabase
      .from('economy_quest_templates')
      .delete()
      .eq('id', id)
      .eq('guild_id', auth.guildId);
    if (error) return dbError(error, 'economy/quests');
    await notifyBot(auth.guildId, 'economy');

    await recordCrudChange({
      guildId: auth.guildId,
      actorId: auth.discordId,
      operation: 'deleted',
      action: 'economy.quest_deleted',
      table: 'economy_quest_templates',
      targetType: 'quest',
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
