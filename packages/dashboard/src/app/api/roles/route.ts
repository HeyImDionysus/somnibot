/**
 * Roles API — Live Discord Role Management
 *
 * GET    /api/roles — Returns actual Discord roles from guild_live_state,
 *                     enriched with tier/template data from guild_desired_state.
 *                     Includes managed roles (bot, booster, integration) as read-only.
 * POST   /api/roles — Queue a create_role action for the bot
 * PATCH  /api/roles — Queue an update_role action for the bot
 * DELETE /api/roles — Queue a delete_role action for the bot
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

// ============================================================
// GET — Read actual Discord roles from live state
// ============================================================

export async function GET() {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminSupabase();

  // Get live state (written by the bot)
  const { data: liveState } = await admin
    .from('guild_live_state')
    .select('roles, bot_role_id, snapshot_at')
    .eq('guild_id', guildId)
    .single();

  if (!liveState || !liveState.roles) {
    // No snapshot yet — bot hasn't written one. Return empty with a flag.
    return NextResponse.json({
      success: true,
      data: [],
      snapshotAt: null,
      awaitingSnapshot: true,
    });
  }

  return NextResponse.json({
    success: true,
    data: liveState.roles,
    botRoleId: liveState.bot_role_id,
    snapshotAt: liveState.snapshot_at,
    awaitingSnapshot: false,
  });
}

// ============================================================
// POST — Create a new role via bot action queue
// ============================================================

export async function POST(request: NextRequest) {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  if (!body.name || !body.tier) {
    return NextResponse.json({ error: 'Missing required fields: name, tier' }, { status: 400 });
  }

  const admin = createAdminSupabase();

  // Queue the action for the bot
  const { data, error } = await admin
    .from('bot_action_queue')
    .insert({
      guild_id: guildId,
      action: 'create_role',
      payload: {
        name: body.name,
        tier: body.tier,
        color: body.color ?? 0,
        hoist: body.hoist ?? false,
        mentionable: body.mentionable ?? false,
        permissions: body.permissions,
        position: body.position,
        templateKey: body.templateKey,
      },
    })
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    success: true,
    actionId: data.id,
    message: 'Role creation queued — bot will execute and update live state',
  }, { status: 202 });
}

// ============================================================
// PATCH — Update an existing role via bot action queue
// ============================================================

export async function PATCH(request: NextRequest) {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  if (!body.roleId) {
    return NextResponse.json({ error: 'Missing roleId' }, { status: 400 });
  }

  const admin = createAdminSupabase();

  const { data, error } = await admin
    .from('bot_action_queue')
    .insert({
      guild_id: guildId,
      action: 'update_role',
      payload: {
        roleId: body.roleId,
        name: body.name,
        tier: body.tier,
        color: body.color,
        hoist: body.hoist,
        mentionable: body.mentionable,
        permissions: body.permissions,
        position: body.position,
        templateKey: body.templateKey,
      },
    })
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    success: true,
    actionId: data.id,
    message: 'Role update queued',
  });
}

// ============================================================
// DELETE — Delete a role via bot action queue
// ============================================================

export async function DELETE(request: NextRequest) {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  if (!body.roleId) {
    return NextResponse.json({ error: 'Missing roleId' }, { status: 400 });
  }

  const admin = createAdminSupabase();

  const { data, error } = await admin
    .from('bot_action_queue')
    .insert({
      guild_id: guildId,
      action: 'delete_role',
      payload: {
        roleId: body.roleId,
        templateKey: body.templateKey,
      },
    })
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    success: true,
    actionId: data.id,
    message: 'Role deletion queued',
  });
}
