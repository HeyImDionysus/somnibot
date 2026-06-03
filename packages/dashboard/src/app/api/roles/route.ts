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
import { requireGuildOwner } from '@/lib/api/require-owner';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

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

  return NextResponse.json({
    success: true,
    actionId: data.id,
    message: 'Role deletion queued',
  });
}
