/**
 * /api/giveaways/settings — guild-level giveaway defaults (guild_config).
 *
 * GET: Load the giveaway config controls.
 * PUT: Update them.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { parseBody, schemas } from '@/lib/api/validation';
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
    .select('giveaway_default_winner_count, giveaway_dm_winners, giveaway_entry_button_label, giveaway_winner_announcement_style')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) return dbError(error, 'giveaways/settings');

  const config = {
    giveaway_default_winner_count: data?.giveaway_default_winner_count ?? 1,
    giveaway_dm_winners: data?.giveaway_dm_winners ?? true,
    giveaway_entry_button_label: data?.giveaway_entry_button_label ?? 'Count me in!',
    giveaway_winner_announcement_style: data?.giveaway_winner_announcement_style ?? 'embed',
  };

  return NextResponse.json({ success: true, data: config });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.giveaway.settings);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const updates: Record<string, unknown> = {};
  if (typeof body.giveaway_default_winner_count === 'number') {
    updates.giveaway_default_winner_count = Math.max(1, Math.min(100, Math.round(body.giveaway_default_winner_count)));
  }
  if (typeof body.giveaway_dm_winners === 'boolean') {
    updates.giveaway_dm_winners = body.giveaway_dm_winners;
  }
  if (typeof body.giveaway_entry_button_label === 'string') {
    updates.giveaway_entry_button_label = body.giveaway_entry_button_label.slice(0, 80);
  }
  if (body.giveaway_winner_announcement_style === 'embed' || body.giveaway_winner_announcement_style === 'plain') {
    updates.giveaway_winner_announcement_style = body.giveaway_winner_announcement_style;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: false, error: 'No valid fields to update' }, { status: 400 });
  }

  updates.updated_at = new Date().toISOString();

  const before = await readGuildConfigBefore(supabase, guildId, Object.keys(updates));

  const { error } = await supabase
    .from('guild_config')
    .upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' });

  if (error) return dbError(error, 'giveaways/settings');

  await notifyBot('giveaways');

  await recordGuildConfigChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'giveaways.settings_updated',
    area: 'giveaway defaults',
    updates,
    before,
  }, supabase);

  return NextResponse.json({ success: true });
}
