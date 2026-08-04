/**
 * /api/moderation/escalation — GET/PUT escalation chain + moderation settings.
 *
 * GET: Returns escalation chain, mod_log_channel_id, infraction_expiry_days
 * PUT: Updates escalation chain, mod_log_channel_id, infraction_expiry_days
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { notifyBot } from '@/lib/notify-bot';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { readGuildConfigBefore, recordGuildConfigChange } from '@/lib/admin-changes';


export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('guild_config')
    .select('escalation_chain, mod_log_channel_id, infraction_expiry_days, appeals_enabled, appeal_cooldown_hours, appeal_review_channel_id, dm_on_action')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    return dbError(error, 'moderation/escalation');
  }

  return NextResponse.json({
    success: true,
    data: {
      escalation_chain: data?.escalation_chain ?? [],
      mod_log_channel_id: data?.mod_log_channel_id ?? null,
      infraction_expiry_days: data?.infraction_expiry_days ?? 30,
      appeals_enabled: data?.appeals_enabled ?? true,
      appeal_cooldown_hours: data?.appeal_cooldown_hours ?? 24,
      appeal_review_channel_id: data?.appeal_review_channel_id ?? null,
      dm_on_action: data?.dm_on_action ?? true,
    },
  });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.moderation.escalation);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const updates: Record<string, unknown> = {};

  if (body.escalation_chain !== undefined) {
    // Validate escalation chain structure
    if (!Array.isArray(body.escalation_chain)) {
      return NextResponse.json(
        { success: false, error: 'escalation_chain must be an array' },
        { status: 400 },
      );
    }

    for (const step of body.escalation_chain as Record<string, unknown>[]) {
      if (typeof step.threshold !== 'number' || step.threshold < 1) {
        return NextResponse.json(
          { success: false, error: 'Each step must have a threshold >= 1' },
          { status: 400 },
        );
      }
      if (!['warn', 'mute', 'kick', 'ban'].includes(step.action as string)) {
        return NextResponse.json(
          { success: false, error: 'Invalid action in escalation step' },
          { status: 400 },
        );
      }
    }

    updates.escalation_chain = body.escalation_chain;
  }

  if (body.mod_log_channel_id !== undefined) {
    updates.mod_log_channel_id = body.mod_log_channel_id || null;
  }

  if (body.infraction_expiry_days !== undefined) {
    const days = Number(body.infraction_expiry_days);
    if (isNaN(days) || days < 1 || days > 365) {
      return NextResponse.json(
        { success: false, error: 'infraction_expiry_days must be between 1 and 365' },
        { status: 400 },
      );
    }
    updates.infraction_expiry_days = days;
  }
  if (body.appeals_enabled !== undefined) updates.appeals_enabled = body.appeals_enabled;
  if (body.appeal_cooldown_hours !== undefined) updates.appeal_cooldown_hours = body.appeal_cooldown_hours;
  if (body.appeal_review_channel_id !== undefined) updates.appeal_review_channel_id = body.appeal_review_channel_id || null;
  if (body.dm_on_action !== undefined) updates.dm_on_action = body.dm_on_action;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: false, error: 'No valid fields to update' }, { status: 400 });
  }

  updates.updated_at = new Date().toISOString();

  const before = await readGuildConfigBefore(supabase, guildId, Object.keys(updates));

  const { error } = await supabase
    .from('guild_config')
    .upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' });

  if (error) {
    return dbError(error, 'moderation/escalation');
  }

  // Notify the bot so it hot-reloads moderation config (escalation chain, mod log, expiry).
  await notifyBot(guildId, 'moderation', updates);

  // Escalation drives automatic punishments — worth a confirmation on undo.
  await recordGuildConfigChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'moderation.escalation_updated',
    area: 'moderation escalation',
    updates,
    before,
    blastRadius: 'high',
  }, supabase);

  return NextResponse.json({ success: true });
}
