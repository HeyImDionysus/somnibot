/**
 * /api/reaction-roles — CRUD for reaction role configurations.
 *
 * GET: List all reaction roles for the guild
 * POST: Create a new reaction role mapping
 * PUT: Update an existing reaction role
 * DELETE: Delete a reaction role by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { parseBody, schemas } from '@/lib/api/validation';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { typedPick } from '@/lib/api/typed-pick';

const snowflake = z.string().regex(/^\d{17,20}$/);
const reactionRoleUpdate = z.object({
  id: z.string().uuid(),
  channel_id: snowflake.optional(),
  message_id: snowflake.optional(),
  emoji: z.string().min(1).max(64).optional(),
  role_id: snowflake.optional(),
  exclusive_group: z.string().max(64).optional().nullable(),
  require_role: snowflake.optional().nullable(),
  require_level: z.number().int().min(0).optional().nullable(),
  max_per_group: z.number().int().min(0).max(100).optional().nullable(),
  remove_on_unreact: z.boolean().optional(),
  log_actions: z.boolean().optional(),
});
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('reaction_roles')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.reactionRole.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const {
    channel_id,
    message_id,
    emoji,
    role_id,
    exclusive_group,
    require_role,
    require_level,
    max_per_group,
    remove_on_unreact,
    log_actions,
  } = body;

  if (!channel_id || !message_id || !emoji || !role_id) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: channel_id, message_id, emoji, role_id' },
      { status: 400 },
    );
  }

  // Check limit (max 50 per guild)
  const { count } = await supabase
    .from('reaction_roles')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guildId);

  if ((count ?? 0) >= 50) {
    return NextResponse.json(
      { success: false, error: 'Maximum reaction role limit reached (50)' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('reaction_roles')
    .insert({
      guild_id: guildId,
      channel_id,
      message_id,
      emoji,
      role_id,
      exclusive_group: exclusive_group ?? null,
      require_role: require_role ?? null,
      require_level: require_level ?? null,
      max_per_group: max_per_group ?? null,
      remove_on_unreact: remove_on_unreact ?? true,
      log_actions: log_actions ?? false,
      active: true,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('reaction-roles');

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, reactionRoleUpdate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const updates = typedPick(body, ['channel_id', 'message_id', 'emoji', 'role_id', 'exclusive_group', 'require_role', 'require_level', 'max_per_group', 'remove_on_unreact', 'log_actions', 'active']);

  const { data, error } = await supabase
    .from('reaction_roles')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('reaction-roles');

  return NextResponse.json({ success: true, data });
}

export async function DELETE(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json(
      { success: false, error: 'Missing reaction role id' },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from('reaction_roles')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('reaction-roles');

  return NextResponse.json({ success: true });
}
