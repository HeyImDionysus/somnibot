/**
 * /api/sync/action — POST repair/accept/ignore actions on drift items.
 *
 * The dashboard sends the action + drift item. For actions that require
 * Discord API calls (repair, delete), the bot picks them up via Supabase
 * Realtime. For accept/ignore, we update Supabase directly.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';


interface DriftActionRequest {
  action: 'repair' | 'accept' | 'ignore' | 'clear_all';
  driftItem?: {
    entityType: string;
    entityName: string;
    entityDiscordId?: string;
    type: string;
  };
}

export async function POST(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.sync.action);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data as DriftActionRequest;

  if (!body.action) {
    return NextResponse.json(
      { success: false, error: 'Missing action' },
      { status: 400 },
    );
  }

  // Clear all drift
  if (body.action === 'clear_all') {
    const { error } = await supabase
      .from('guild_desired_state')
      .update({
        drift_detected: false,
        drift_details: [],
        last_sync_at: new Date().toISOString(),
      })
      .eq('guild_id', guildId);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  }

  if (!body.driftItem) {
    return NextResponse.json(
      { success: false, error: 'Missing driftItem' },
      { status: 400 },
    );
  }

  // For 'ignore' — just remove from drift list
  if (body.action === 'ignore') {
    const { data: current } = await supabase
      .from('guild_desired_state')
      .select('drift_details')
      .eq('guild_id', guildId)
      .maybeSingle();

    const items = Array.isArray(current?.drift_details) ? current.drift_details : [];
    const filtered = items.filter(
      (i: Record<string, unknown>) =>
        !(
          i.entityType === body.driftItem!.entityType &&
          i.entityName === body.driftItem!.entityName
        ),
    );

    await supabase
      .from('guild_desired_state')
      .update({
        drift_detected: filtered.length > 0,
        drift_details: filtered,
      })
      .eq('guild_id', guildId);

    return NextResponse.json({ success: true });
  }

  // For 'accept' — clear from drift list directly, then optionally queue for bot
  if (body.action === 'accept') {
    const { data: current } = await supabase
      .from('guild_desired_state')
      .select('drift_details')
      .eq('guild_id', guildId)
      .maybeSingle();

    const items = Array.isArray(current?.drift_details) ? current.drift_details : [];
    const filtered = items.filter(
      (i: Record<string, unknown>) =>
        !(
          i.entityType === body.driftItem!.entityType &&
          i.entityName === body.driftItem!.entityName
        ),
    );

    await supabase
      .from('guild_desired_state')
      .update({
        drift_detected: filtered.length > 0,
        drift_details: filtered,
      })
      .eq('guild_id', guildId);

    // Also queue for bot to update its id_map (best-effort)
    await supabase.from('sync_actions').insert({
      guild_id: guildId,
      action_type: body.action,
      action: body.action,
      target_type: body.driftItem?.entityType ?? 'unknown',
      target_id: body.driftItem?.entityDiscordId ?? null,
      details: body.driftItem,
      drift_item: body.driftItem,
      status: 'pending',
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {}); // Ignore insert errors

    return NextResponse.json({ success: true });
  }

  // For 'repair' — queue action for the bot to execute via Realtime
  const { error } = await supabase.from('sync_actions').insert({
    guild_id: guildId,
    action_type: body.action,
    action: body.action,
    target_type: body.driftItem?.entityType ?? 'unknown',
    target_id: body.driftItem?.entityDiscordId ?? null,
    details: body.driftItem,
    drift_item: body.driftItem,
    status: 'pending',
    created_at: new Date().toISOString(),
  });

  if (error) {
    return NextResponse.json({
      success: false,
      error: 'Repair requires the bot to be running. The bot will auto-repair on next sync cycle.',
    }, { status: 503 });
  }

  return NextResponse.json({ success: true, message: 'Repair action queued for bot execution' });
}
