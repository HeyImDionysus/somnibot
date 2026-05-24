/**
 * /api/moderation/infractions — List, search, create manual, and pardon infractions.
 *
 * GET: List infractions (with optional member_id filter, pagination)
 * POST: Create a manual infraction (warn from dashboard)
 * PATCH: Pardon an infraction
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';


export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);

  const memberId = searchParams.get('member_id');
  const activeOnly = searchParams.get('active') === 'true';
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 100);
  const offset = parseInt(searchParams.get('offset') ?? '0');

  let query = supabase
    .from('infractions')
    .select('*', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
    .limit(1000);

  if (memberId) {
    query = query.eq('member_id', memberId);
  }

  if (activeOnly) {
    query = query.eq('active', true).eq('pardoned', false);
  }

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    data: data ?? [],
    total: count ?? 0,
    limit,
    offset,
  });
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.infraction.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const { member_id, type, reason, moderator_id, duration_minutes } = body;

  if (!member_id || !type || !reason) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: member_id, type, reason' },
      { status: 400 },
    );
  }

  const validTypes = ['warn', 'mute', 'kick', 'ban'];
  if (!validTypes.includes(type)) {
    return NextResponse.json(
      { success: false, error: `Invalid type. Must be one of: ${validTypes.join(', ')}` },
      { status: 400 },
    );
  }

  // Get infraction expiry config
  const { data: config } = await supabase
    .from('guild_config')
    .select('infraction_expiry_days')
    .eq('guild_id', guildId)
    .maybeSingle();

  const expiryDays = (config?.infraction_expiry_days as number) ?? 30;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiryDays);

  const { data, error } = await supabase
    .from('infractions')
    .insert({
      guild_id: guildId,
      member_id,
      moderator_id: moderator_id ?? 'dashboard',
      type,
      reason,
      duration_minutes: type === 'mute' ? (duration_minutes ?? null) : null,
      active: true,
      pardoned: false,
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}

export async function PATCH(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.infraction.pardon);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.id) {
    return NextResponse.json({ success: false, error: 'Missing infraction id' }, { status: 400 });
  }

  if (body.action === 'pardon') {
    const { data, error } = await supabase
      .from('infractions')
      .update({
        active: false,
        pardoned: true,
        pardoned_by: body.pardoned_by ?? 'dashboard',
        pardoned_at: new Date().toISOString(),
      })
      .eq('id', body.id)
      .eq('guild_id', guildId)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
