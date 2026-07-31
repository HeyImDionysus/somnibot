import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { recordCrudChange } from '@/lib/admin-changes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const supabase = createAdminSupabase();

  const [pendingResult, failedResult, configResult] = await Promise.all([
    supabase
      .from('automation_mass_action_holds')
      .select('*')
      .eq('guild_id', auth.ctx.guildId)
      .in('status', ['held', 'approved', 'executing'])
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('automation_mass_action_holds')
      .select('*')
      .eq('guild_id', auth.ctx.guildId)
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('guild_config')
      .select('automation_mass_action_threshold')
      .eq('guild_id', auth.ctx.guildId)
      .maybeSingle(),
  ]);
  if (pendingResult.error) return dbError(pendingResult.error, 'automations/holds/pending');
  if (failedResult.error) return dbError(failedResult.error, 'automations/holds/failed');
  if (configResult.error) return dbError(configResult.error, 'automations/holds/config');
  return NextResponse.json({
    success: true,
    data: [...(pendingResult.data ?? []), ...(failedResult.data ?? [])],
    threshold: configResult.data?.automation_mass_action_threshold ?? 25,
  });
}

export async function PATCH(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }
  const { id, decision } = body as { id?: unknown; decision?: unknown };
  if (typeof id !== 'string' || !UUID.test(id)) {
    return NextResponse.json({ success: false, error: 'Invalid hold id' }, { status: 400 });
  }
  if (decision !== 'approve' && decision !== 'reject') {
    return NextResponse.json({ success: false, error: 'Decision must be approve or reject' }, { status: 400 });
  }

  const supabase = createAdminSupabase();
  const now = new Date().toISOString();
  const updates = decision === 'approve'
    ? {
      status: 'approved',
      approved_by: auth.ctx.discordId,
      approved_at: now,
      last_error: null,
    }
    : {
      status: 'rejected',
      rejected_by: auth.ctx.discordId,
      rejected_at: now,
      last_error: null,
    };
  const { data, error } = await supabase
    .from('automation_mass_action_holds')
    .update(updates)
    .eq('id', id)
    .eq('guild_id', auth.ctx.guildId)
    .eq('status', 'held')
    .select('*')
    .maybeSingle();
  if (error) return dbError(error, 'automations/holds/decision');
  if (!data) {
    return NextResponse.json(
      { success: false, error: 'This hold was already decided or no longer exists' },
      { status: 409 },
    );
  }

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'updated',
    action: `automations.mass_action_${decision}d`,
    table: 'automation_mass_action_holds',
    targetType: 'automation_mass_action_hold',
    targetId: id,
    before: { status: 'held' },
    after: updates,
    match: { id, guild_id: auth.ctx.guildId },
    blastRadius: decision === 'approve' ? 'high' : 'low',
  }, supabase);

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  let threshold: unknown;
  try {
    ({ threshold } = await req.json() as { threshold?: unknown });
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!Number.isInteger(threshold) || (threshold as number) < 1 || (threshold as number) > 500) {
    return NextResponse.json(
      { success: false, error: 'Threshold must be an integer from 1 to 500' },
      { status: 400 },
    );
  }

  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from('guild_config')
    .update({ automation_mass_action_threshold: threshold })
    .eq('guild_id', auth.ctx.guildId)
    .select('automation_mass_action_threshold')
    .single();
  if (error) return dbError(error, 'automations/holds/config');

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'updated',
    action: 'automations.mass_action_threshold_updated',
    table: 'guild_config',
    targetType: 'guild_config',
    targetId: auth.ctx.guildId,
    after: { automation_mass_action_threshold: threshold },
    match: { guild_id: auth.ctx.guildId },
    blastRadius: 'medium',
  }, supabase);

  return NextResponse.json({ success: true, data });
}
