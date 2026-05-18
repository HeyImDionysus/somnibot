/**
 * Channels API — Live Discord Channel Management
 *
 * GET    /api/channels — Returns actual Discord channels from guild_live_state.
 * POST   /api/channels — Queue a create_channel action for the bot
 * PATCH  /api/channels — Queue an update_channel action for the bot
 * DELETE /api/channels — Queue a delete_channel action for the bot
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
// GET — Read actual Discord channels from live state
// ============================================================

export async function GET() {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminSupabase();

  const { data: liveState } = await admin
    .from('guild_live_state')
    .select('channels, categories, snapshot_at')
    .eq('guild_id', guildId)
    .single();

  if (!liveState) {
    return NextResponse.json({
      success: true,
      channels: [],
      categories: [],
      snapshotAt: null,
      awaitingSnapshot: true,
    });
  }

  return NextResponse.json({
    success: true,
    channels: liveState.channels ?? [],
    categories: liveState.categories ?? [],
    snapshotAt: liveState.snapshot_at,
    awaitingSnapshot: false,
  });
}

// ============================================================
// POST — Create channel via bot action queue
// ============================================================

export async function POST(request: NextRequest) {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();

  const admin = createAdminSupabase();

  // Determine if creating a channel or category
  const action = body.isCategory ? 'create_category' : 'create_channel';
  const payload = body.isCategory
    ? { name: body.name, templateKey: body.templateKey }
    : {
        name: body.name,
        type: body.type ?? 0,
        parentId: body.parentId ?? null,
        topic: body.topic ?? null,
        nsfw: body.nsfw ?? false,
        slowmode: body.slowmode ?? 0,
        templateKey: body.templateKey,
      };

  const { data, error } = await admin
    .from('bot_action_queue')
    .insert({ guild_id: guildId, action, payload })
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    success: true,
    actionId: data.id,
    message: `${body.isCategory ? 'Category' : 'Channel'} creation queued`,
  }, { status: 202 });
}

// ============================================================
// PATCH — Update channel via bot action queue
// ============================================================

export async function PATCH(request: NextRequest) {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  if (!body.channelId) {
    return NextResponse.json({ error: 'Missing channelId' }, { status: 400 });
  }

  const admin = createAdminSupabase();

  const { data, error } = await admin
    .from('bot_action_queue')
    .insert({
      guild_id: guildId,
      action: 'update_channel',
      payload: {
        channelId: body.channelId,
        name: body.name,
        topic: body.topic,
        nsfw: body.nsfw,
        slowmode: body.slowmode,
        parentId: body.parentId,
      },
    })
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    success: true,
    actionId: data.id,
    message: 'Channel update queued',
  });
}

// ============================================================
// DELETE — Delete channel via bot action queue
// ============================================================

export async function DELETE(request: NextRequest) {
  const guildId = await getGuildId();
  if (!guildId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const isCategory = body.isCategory ?? false;
  const id = isCategory ? body.categoryId : body.channelId;

  if (!id) {
    return NextResponse.json(
      { error: `Missing ${isCategory ? 'categoryId' : 'channelId'}` },
      { status: 400 },
    );
  }

  const admin = createAdminSupabase();

  const { data, error } = await admin
    .from('bot_action_queue')
    .insert({
      guild_id: guildId,
      action: isCategory ? 'delete_category' : 'delete_channel',
      payload: isCategory ? { categoryId: id } : { channelId: id },
    })
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    success: true,
    actionId: data.id,
    message: `${isCategory ? 'Category' : 'Channel'} deletion queued`,
  });
}
