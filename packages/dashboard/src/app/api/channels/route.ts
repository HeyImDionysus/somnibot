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
import { requireGuildOwner } from '@/lib/api/require-owner';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

const snowflake = z.string().regex(/^\d{17,20}$/);

const channelCreate = z.object({
  name: z.string().min(1).max(100).trim(),
  isCategory: z.boolean().default(false),
  type: z.number().int().min(0).max(15).default(0),
  parentId: snowflake.optional().nullable(),
  topic: z.string().max(1024).optional().nullable(),
  nsfw: z.boolean().default(false),
  slowmode: z.number().int().min(0).max(21600).default(0),
  templateKey: z.string().max(128).optional(),
});

const channelUpdate = z.object({
  channelId: snowflake,
  name: z.string().min(1).max(100).trim().optional(),
  topic: z.string().max(1024).optional().nullable(),
  nsfw: z.boolean().optional(),
  slowmode: z.number().int().min(0).max(21600).optional(),
  parentId: snowflake.optional().nullable(),
});

const channelDelete = z.object({
  isCategory: z.boolean().default(false),
  channelId: snowflake.optional(),
  categoryId: snowflake.optional(),
}).refine(
  (d) => d.isCategory ? !!d.categoryId : !!d.channelId,
  { message: 'channelId or categoryId is required' },
);


// ============================================================
// GET — Read actual Discord channels from live state
// ============================================================

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

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
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const parsed = await parseBody(request, channelCreate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

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

  if (error) return dbError(error, 'channels');

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
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const parsed = await parseBody(request, channelUpdate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

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

  if (error) return dbError(error, 'channels');

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
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const parsed = await parseBody(request, channelDelete);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const isCategory = body.isCategory;
  const id = isCategory ? body.categoryId : body.channelId;

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

  if (error) return dbError(error, 'channels');

  return NextResponse.json({
    success: true,
    actionId: data.id,
    message: `${isCategory ? 'Category' : 'Channel'} deletion queued`,
  });
}
