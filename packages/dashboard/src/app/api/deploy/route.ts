/**
 * POST /api/deploy — Store desired state for bot deployment.
 *
 * The dashboard stores the desired state in Supabase.
 * The bot picks it up via Realtime subscription and deploys.
 *
 * This is the "fire and forget" pattern — dashboard doesn't
 * talk to the bot directly. Everything goes through Supabase.
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

export async function POST(request: NextRequest) {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const admin = createAdminSupabase();

  // Validate required fields
  if (!body.roles || !body.channels || !body.categories) {
    return NextResponse.json({ error: 'Missing roles, channels, or categories' }, { status: 400 });
  }

  // Store desired state
  const { error } = await admin
    .from('guild_desired_state')
    .upsert({
      guild_id: guildId,
      roles: body.roles,
      channels: body.channels,
      permission_map: body.permissionMap ?? {},
      updated_at: new Date().toISOString(),
    });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Insert a deploy request for the bot to pick up
  await admin.from('audit_logs').insert({
    guild_id: guildId,
    actor_type: 'user',
    action: 'deploy.requested',
    entity_type: 'guild',
    entity_id: guildId,
    details: {
      roleCount: body.roles.length,
      channelCount: body.channels.length,
      categoryCount: body.categories.length,
      cleanExisting: body.cleanExisting ?? true,
    },
  });

  // Update guild setup step
  await admin
    .from('guild')
    .update({ setup_step: 5 })
    .eq('id', guildId);

  return NextResponse.json({ success: true, message: 'Deploy request queued' });
}

export async function GET() {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminSupabase();

  // Get deployment status
  const { data: desiredState } = await admin
    .from('guild_desired_state')
    .select('*')
    .eq('guild_id', guildId)
    .single();

  const { data: guild } = await admin
    .from('guild')
    .select('setup_completed, setup_step')
    .eq('id', guildId)
    .single();

  // Get recent deploy actions from audit log
  const { data: recentActions } = await admin
    .from('audit_logs')
    .select('*')
    .eq('guild_id', guildId)
    .in('action', ['server.deployed', 'deploy.requested', 'deploy.action'])
    .order('created_at', { ascending: false })
    .limit(20);

  return NextResponse.json({
    desiredState,
    setupCompleted: guild?.setup_completed ?? false,
    setupStep: guild?.setup_step ?? 0,
    recentActions: recentActions ?? [],
  });
}
