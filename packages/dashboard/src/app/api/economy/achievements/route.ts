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
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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
    const body = await req.json();
    const parsed = achSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

    const supabase = createAdminSupabase();
    const { data, error } = await supabase
      .from('economy_achievement_defs')
      .insert({ ...parsed.data, guild_id: auth.guildId })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await notifyBot('economy');
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
    const body = await req.json();
    const parsed = achSchema.safeParse(body);
    if (!parsed.success || !parsed.data.id) return NextResponse.json({ error: 'Invalid data' }, { status: 400 });

    const supabase = createAdminSupabase();
    const { id, ...rest } = parsed.data;
    const { data, error } = await supabase
      .from('economy_achievement_defs')
      .update(rest)
      .eq('id', id)
      .eq('guild_id', auth.guildId)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await notifyBot('economy');
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
    const { error } = await supabase
      .from('economy_achievement_defs')
      .delete()
      .eq('id', id)
      .eq('guild_id', auth.guildId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await notifyBot('economy');
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
