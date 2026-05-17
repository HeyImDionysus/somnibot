/**
 * /api/sync/action — POST repair/accept/ignore actions on drift items.
 *
 * The dashboard sends the action + drift item. For actions that require
 * Discord API calls (repair, delete), the bot picks them up via Supabase
 * Realtime. For accept/ignore, we update Supabase directly.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

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
  const supabase = createAdminSupabase();
  const body: DriftActionRequest = await req.json();

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
      .eq('guild_id', GUILD_ID);

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
      .eq('guild_id', GUILD_ID)
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
      .eq('guild_id', GUILD_ID);

    return NextResponse.json({ success: true });
  }

  // For 'repair' and 'accept' — write a sync action request for the bot to pick up
  const { error } = await supabase.from('sync_actions').insert({
    guild_id: GUILD_ID,
    action: body.action,
    drift_item: body.driftItem,
    status: 'pending',
    created_at: new Date().toISOString(),
  });

  if (error) {
    // If sync_actions table doesn't exist yet, fall back to removing from drift list
    // The bot will pick up the repair on next sync cycle
    if (error.code === '42P01') {
      // Table doesn't exist — handle inline
      if (body.action === 'accept') {
        const { data: current } = await supabase
          .from('guild_desired_state')
          .select('drift_details')
          .eq('guild_id', GUILD_ID)
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
          .eq('guild_id', GUILD_ID);

        return NextResponse.json({ success: true });
      }

      return NextResponse.json({
        success: false,
        error: 'Repair requires the bot to be running. The bot will auto-repair on next sync cycle.',
      }, { status: 503 });
    }

    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, message: 'Action queued for bot execution' });
}
