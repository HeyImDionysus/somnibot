/**
 * Channels API — Live Discord Channel Management
 *
 * GET    /api/channels — Returns actual Discord channels from guild_live_state.
 * POST   /api/channels — Queue a create_channel action for the bot
 * PATCH  /api/channels — Queue an update_channel action for the bot
 * DELETE /api/channels — Queue a delete_channel action for the bot
 *
 * Every mutation also writes an `admin_changes` row — see the note at the top
 * of api/roles/route.ts for why (same shape, same reason: the bot's queue
 * runner records nothing, so these changes were invisible on the page built to
 * explain them). Verbs say "Queued" because at write time the bot has not
 * touched Discord yet.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { recordAdminChange } from '@/lib/admin-changes';

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

/**
 * Channel properties the bot's `update_channel` handler applies. Every one is
 * also permitted in an `update_channel` undo payload (DISCORD_UNDO_ACTIONS in
 * lib/api/undo-allowlist), so a channel edit is fully reversible whenever the
 * prior values are known — unlike a role edit, which has unreversible extras.
 */
const REVERSIBLE_CHANNEL_FIELDS = ['name', 'topic', 'nsfw', 'slowmode', 'parentId'] as const;

/** One channel or category as the bot snapshots it into `guild_live_state`. */
type LiveChannelSnapshot = Record<string, unknown> & { id?: string; name?: string };

/**
 * Read a channel's (or category's) current properties from the bot's live
 * snapshot — the same data the Channels page renders, and the only "before"
 * the dashboard has for an object that lives in Discord.
 *
 * Best-effort: an unreadable snapshot downgrades the change to "not undoable"
 * with that reason stated, rather than offering an empty restore.
 */
async function readLiveChannel(
  admin: SupabaseClient,
  guildId: string,
  id: string,
): Promise<LiveChannelSnapshot | undefined> {
  try {
    const { data, error } = await admin
      .from('guild_live_state')
      .select('channels, categories')
      .eq('guild_id', guildId)
      .maybeSingle();
    if (error || !data) return undefined;
    const state = data as { channels?: unknown; categories?: unknown };
    for (const list of [state.channels, state.categories]) {
      if (!Array.isArray(list)) continue;
      const found = (list as LiveChannelSnapshot[]).find((c) => c?.id === id);
      if (found) return found;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** `#general` / `"STAFF"` when the snapshot knows it, else the raw id. */
function channelLabel(
  before: LiveChannelSnapshot | undefined,
  id: string,
  isCategory: boolean,
): string {
  if (typeof before?.name !== 'string') return `${isCategory ? 'category' : 'channel'} ${id}`;
  return isCategory ? `"${before.name}"` : `#${before.name}`;
}


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

  // Undo would be `delete_channel`/`delete_category`, both of which need the id
  // Discord has not issued yet — the bot assigns it when it drains the queue.
  await recordAdminChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: body.isCategory ? 'channels.category_create_queued' : 'channels.create_queued',
    targetType: body.isCategory ? 'category' : 'channel',
    targetId: null,
    description: `Queued creation of the ${
      body.isCategory ? `"${body.name}" category` : `#${body.name} channel`
    }`,
    after: payload,
    blastRadius: 'low',
    undoReason: `the ${
      body.isCategory ? 'category' : 'channel'
    } has not been created yet, so there is nothing to delete — remove it from the Channels page once the bot has made it`,
  }, admin);

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

  // Read the channel's current properties BEFORE queueing the edit; once the
  // bot applies it and re-snapshots, this read would return the new values.
  const before = await readLiveChannel(admin, guildId, body.channelId);

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

  const changed = REVERSIBLE_CHANNEL_FIELDS.filter((f) => body[f] !== undefined);

  // Every field this route can change is re-appliable by `update_channel`, so
  // undo is real as soon as the snapshot holds a prior value for each of them.
  const undoReason = !before
    ? 'the bot has not published a snapshot of this channel yet, so its previous settings are unknown'
    : changed.length === 0
      ? 'no channel property was changed, so there is nothing to put back'
      : changed.some((f) => !(f in before))
        ? 'the snapshot of this channel is missing some of the settings that changed, so they cannot be put back'
        : null;

  await recordAdminChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'channels.update_queued',
    targetType: 'channel',
    targetId: body.channelId,
    description: `Queued an update to the ${channelLabel(before, body.channelId, false)} channel (${
      changed.length > 0 ? changed.join(', ') : 'no properties'
    })`,
    before: before ?? undefined,
    after: Object.fromEntries(changed.map((f) => [f, body[f]])),
    blastRadius: 'low',
    ...(undoReason === null
      ? {
          undo: {
            kind: 'discord' as const,
            action: 'update_channel',
            payload: {
              channelId: body.channelId,
              ...Object.fromEntries(changed.map((f) => [f, before![f]])),
            },
          },
        }
      : { undoReason }),
  }, admin);

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
  // `.default(false)` makes this a boolean at runtime; parseBody's generic
  // widens it back to `boolean | undefined`, and every use below is a plain
  // boolean decision, so normalise once here.
  const isCategory = body.isCategory ?? false;
  const id = isCategory ? body.categoryId : body.channelId;

  const admin = createAdminSupabase();

  // Capture it before it is gone — after the bot runs this, the snapshot is the
  // only remaining description of what was deleted.
  const before = id ? await readLiveChannel(admin, guildId, id) : undefined;

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

  // `create_channel` is a permitted undo action but would not undo anything:
  // Discord cannot restore a deleted channel, so it would make an empty new one
  // with a new id, and every message in the old channel stays destroyed.
  await recordAdminChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: isCategory ? 'channels.category_delete_queued' : 'channels.delete_queued',
    targetType: isCategory ? 'category' : 'channel',
    targetId: id ?? null,
    description: `Queued deletion of the ${channelLabel(before, id ?? '', isCategory)} ${
      isCategory ? 'category' : 'channel'
    }`,
    before: before ?? undefined,
    blastRadius: 'high',
    undoReason: isCategory
      ? 'a deleted category cannot be brought back, and the channels inside it lose their grouping'
      : 'a deleted channel takes all of its messages with it, and Discord cannot bring either back',
  }, admin);

  return NextResponse.json({
    success: true,
    actionId: data.id,
    message: `${isCategory ? 'Category' : 'Channel'} deletion queued`,
  });
}
