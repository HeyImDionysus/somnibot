/**
 * Roles API — Live Discord Role Management
 *
 * GET    /api/roles — Returns actual Discord roles from guild_live_state,
 *                     enriched with tier/template data from guild_desired_state.
 *                     Includes managed roles (bot, booster, integration) as read-only.
 * POST   /api/roles — Queue a create_role action for the bot
 * PATCH  /api/roles — Queue an update_role action for the bot
 * DELETE /api/roles — Queue a delete_role action for the bot
 *
 * ── Why every mutation here also writes an admin_changes row ──────────────
 * These handlers do not touch Discord themselves; they enqueue work the bot
 * performs seconds later. Nothing else records that. The bot's action-queue
 * runner has no admin-change recording of its own (only deploy-listener and
 * sync repair-actions do), so before this an owner could rename or delete a
 * role from the dashboard and the Admin Changes page — the page whose whole
 * job is explaining what changed in their server — stayed blank.
 *
 * The verbs say "Queued" on purpose. At the moment the row is written the
 * Discord role has not changed yet; claiming otherwise would be the same kind
 * of lie the undo rules exist to prevent.
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

const roleCreate = z.object({
  name: z.string().min(1).max(100).trim(),
  tier: z.string().min(1).max(64),
  color: z.number().int().min(0).max(16777215).default(0),
  hoist: z.boolean().default(false),
  mentionable: z.boolean().default(false),
  permissions: z.string().optional(),
  position: z.number().int().min(0).max(250).optional(),
  templateKey: z.string().max(128).optional(),
});

const roleUpdate = z.object({
  roleId: snowflake,
  name: z.string().min(1).max(100).trim().optional(),
  tier: z.string().max(64).optional(),
  color: z.number().int().min(0).max(16777215).optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  permissions: z.string().optional(),
  position: z.number().int().min(0).max(250).optional(),
  templateKey: z.string().max(128).optional(),
});

const roleDelete = z.object({
  roleId: snowflake,
  templateKey: z.string().max(128).optional(),
});

/**
 * Role properties the bot's `update_role` queue handler accepts AND the undo
 * allowlist permits in an undo payload (see DISCORD_UNDO_ACTIONS in
 * lib/api/undo-allowlist). `position` is handled by the bot but is NOT
 * undoable, and `tier`/`templateKey` write guild_desired_state rather than
 * Discord — both are why a change touching them is recorded as not undoable.
 */
const REVERSIBLE_ROLE_FIELDS = ['name', 'color', 'hoist', 'mentionable', 'permissions'] as const;

/** One role as the bot snapshots it into `guild_live_state.roles`. */
type LiveRoleSnapshot = Record<string, unknown> & { id?: string; name?: string };

/**
 * Read a role's current Discord properties from the bot's live snapshot.
 *
 * This is the only "before" available to the dashboard: the roles themselves
 * live in Discord, and the snapshot is the same data the Roles page renders.
 * Best-effort by design — a missing or unreadable snapshot downgrades the
 * recorded change to "not undoable" (with that reason stated) instead of
 * offering a restore button with nothing to restore.
 */
async function readLiveRole(
  admin: SupabaseClient,
  guildId: string,
  roleId: string,
): Promise<LiveRoleSnapshot | undefined> {
  try {
    const { data, error } = await admin
      .from('guild_live_state')
      .select('roles')
      .eq('guild_id', guildId)
      .maybeSingle();
    if (error || !data) return undefined;
    const roles = (data as { roles?: unknown }).roles;
    if (!Array.isArray(roles)) return undefined;
    return (roles as LiveRoleSnapshot[]).find((r) => r?.id === roleId);
  } catch {
    return undefined;
  }
}

/** `"Moderator"` when the snapshot knows the role, else the raw id. */
function roleLabel(before: LiveRoleSnapshot | undefined, roleId: string): string {
  return typeof before?.name === 'string' ? `"${before.name}"` : `role ${roleId}`;
}


// ============================================================
// GET — Read actual Discord roles from live state
// ============================================================

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

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
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const parsed = await parseBody(request, roleCreate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

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

  if (error) return dbError(error, 'roles');

  // Undo would have to be `delete_role`, which needs the new role's id — and
  // that id does not exist yet: the bot assigns it when it processes this
  // queue row. There is nothing honest to point a delete at, so the row says
  // so rather than shipping a button that would fail.
  await recordAdminChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'roles.create_queued',
    targetType: 'role',
    targetId: null,
    description: `Queued creation of the "${body.name}" role in the ${body.tier} tier`,
    after: {
      name: body.name,
      tier: body.tier,
      color: body.color,
      hoist: body.hoist,
      mentionable: body.mentionable,
      permissions: body.permissions,
      position: body.position,
      templateKey: body.templateKey,
    },
    blastRadius: 'medium',
    undoReason:
      'the role has not been created yet, so there is no role to delete — remove it from the Roles page once the bot has made it',
  }, admin);

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
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const parsed = await parseBody(request, roleUpdate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const admin = createAdminSupabase();

  // Read the role's current Discord properties BEFORE queueing the edit —
  // afterwards the snapshot still shows the old values for a while and then
  // silently becomes the NEW ones, so a "before" captured later is just the
  // "after" wearing a different label.
  const before = await readLiveRole(admin, guildId, body.roleId);

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

  if (error) return dbError(error, 'roles');

  const changed = REVERSIBLE_ROLE_FIELDS.filter((f) => body[f] !== undefined);

  // Undo re-applies the previous values through the same `update_role` handler.
  // It is only offered when the reversal would be COMPLETE:
  //   · the live snapshot holds a prior value for every field being changed,
  //   · nothing outside the reversible set changed — `position` is applied by
  //     the bot but rejected by the undo allowlist, and `templateKey` also
  //     rewrites guild_desired_state, which a queued Discord undo cannot touch
  //     (sync auto-repair would then drag the role back to the new values).
  const undoReason = !before
    ? 'the bot has not published a snapshot of this role yet, so its previous settings are unknown'
    : body.position !== undefined
      ? "a role's position in the hierarchy cannot be put back automatically"
      : body.templateKey !== undefined
        ? 'this role belongs to your saved server template, and reversing only the Discord side would leave the template out of step'
        : changed.length === 0
          ? 'no Discord role property was changed, so there is nothing to put back'
          : changed.some((f) => !(f in before))
            ? 'the snapshot of this role is missing some of the settings that changed, so they cannot be put back'
            : null;

  await recordAdminChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'roles.update_queued',
    targetType: 'role',
    targetId: body.roleId,
    description: `Queued an update to the ${roleLabel(before, body.roleId)} role (${
      changed.length > 0 ? changed.join(', ') : 'template details'
    })`,
    before: before ?? undefined,
    after: Object.fromEntries(changed.map((f) => [f, body[f]])),
    blastRadius: 'medium',
    ...(undoReason === null
      ? {
          undo: {
            kind: 'discord' as const,
            action: 'update_role',
            payload: {
              roleId: body.roleId,
              ...Object.fromEntries(changed.map((f) => [f, before![f]])),
            },
          },
        }
      : { undoReason }),
  }, admin);

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
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const parsed = await parseBody(request, roleDelete);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const admin = createAdminSupabase();

  // Capture the role before it is gone — once the bot deletes it, this snapshot
  // is the only remaining description of what the role was.
  const before = await readLiveRole(admin, guildId, body.roleId);

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

  if (error) return dbError(error, 'roles');

  // `create_role` IS a permitted undo action, but using it here would be a lie:
  // Discord would mint a NEW role id, so no member who held the old role gets
  // it back and every setting that points at the old id (level rewards,
  // reaction roles, product grants) would still be dangling.
  await recordAdminChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'roles.delete_queued',
    targetType: 'role',
    targetId: body.roleId,
    description: `Queued deletion of the ${roleLabel(before, body.roleId)} role`,
    before: before ?? undefined,
    blastRadius: 'high',
    undoReason:
      'deleting a role takes it away from every member who had it, and re-creating it would make a different role that nobody holds',
  }, admin);

  return NextResponse.json({
    success: true,
    actionId: data.id,
    message: 'Role deletion queued',
  });
}
