/**
 * GET  /api/sync — Get current drift status
 * POST /api/sync — Trigger actions on drift items (repair/accept/ignore)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createServerSupabase } from '@/lib/supabase/server';

async function getGuildId(): Promise<string | null> {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createAdminSupabase();
  const { data: dbUser } = await admin
    .from('users')
    .select('discord_id')
    .eq('id', user.id)
    .single();
  if (!dbUser) return null;

  const { data: guild } = await admin
    .from('guild')
    .select('id')
    .eq('owner_discord_id', dbUser.discord_id)
    .single();

  return guild?.id ?? null;
}

export async function GET() {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminSupabase();

  // Get drift status
  const { data: desiredState } = await admin
    .from('guild_desired_state')
    .select('drift_detected, drift_details, last_sync_at')
    .eq('guild_id', guildId)
    .single();

  // Get sync config
  const { data: config } = await admin
    .from('guild_config')
    .select('sync_enabled, sync_interval_minutes, sync_auto_repair, sync_auto_repair_everyone')
    .eq('guild_id', guildId)
    .single();

  // Get recent sync events
  const { data: recentEvents } = await admin
    .from('audit_logs')
    .select('*')
    .eq('guild_id', guildId)
    .in('action', ['drift.detected', 'sync.completed', 'drift.repaired', 'drift.accepted'])
    .order('created_at', { ascending: false })
    .limit(20);

  return NextResponse.json({
    driftDetected: desiredState?.drift_detected ?? false,
    driftItems: desiredState?.drift_details ?? [],
    lastSyncAt: desiredState?.last_sync_at ?? null,
    config: {
      syncEnabled: config?.sync_enabled ?? true,
      syncIntervalMinutes: config?.sync_interval_minutes ?? 15,
      autoRepair: config?.sync_auto_repair ?? false,
      autoRepairEveryone: config?.sync_auto_repair_everyone ?? true,
    },
    recentEvents: recentEvents ?? [],
  });
}

export async function POST(request: NextRequest) {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const admin = createAdminSupabase();

  if (body.action === 'update_config') {
    const { error } = await admin
      .from('guild_config')
      .update({
        sync_enabled: body.syncEnabled,
        sync_interval_minutes: body.syncIntervalMinutes,
        sync_auto_repair: body.autoRepair,
        sync_auto_repair_everyone: body.autoRepairEveryone,
      })
      .eq('guild_id', guildId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  if (body.action === 'repair' || body.action === 'accept' || body.action === 'ignore') {
    // Log the action — the bot picks it up and executes
    await admin.from('audit_logs').insert({
      guild_id: guildId,
      actor_type: 'user',
      action: `drift.${body.action}`,
      entity_type: body.entityType ?? 'unknown',
      entity_id: body.entityId ?? null,
      details: {
        driftType: body.driftType,
        entityName: body.entityName,
      },
    });

    return NextResponse.json({ success: true, message: `${body.action} queued` });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
