/**
 * /api/moderation/rules — CRUD for auto-mod rules.
 *
 * GET: List all rules for the guild
 * POST: Create a new rule
 * PUT: Update an existing rule
 * DELETE: Delete a rule by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';


export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('automod_rules')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.moderation.rule);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const { name, type, config, action, mute_duration_minutes, exempt_roles, exempt_channels, log_to_mod_channel } = body;

  if (!name || !type || !action) {
    return NextResponse.json({ success: false, error: 'Missing required fields: name, type, action' }, { status: 400 });
  }

  const validTypes = ['word_filter', 'link_filter', 'invite_filter', 'spam_filter', 'duplicate_filter', 'caps_filter', 'mention_spam', 'newline_spam'];
  if (!validTypes.includes(type)) {
    return NextResponse.json({ success: false, error: `Invalid type. Must be one of: ${validTypes.join(', ')}` }, { status: 400 });
  }

  const validActions = ['delete', 'warn', 'mute', 'kick', 'ban'];
  if (!validActions.includes(action)) {
    return NextResponse.json({ success: false, error: `Invalid action. Must be one of: ${validActions.join(', ')}` }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('automod_rules')
    .insert({
      guild_id: guildId,
      name,
      type,
      enabled: true,
      config: config ?? {},
      action,
      mute_duration_minutes: action === 'mute' ? (mute_duration_minutes ?? 5) : null,
      exempt_roles: exempt_roles ?? [],
      exempt_channels: exempt_channels ?? [],
      log_to_mod_channel: log_to_mod_channel ?? true,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.moderation.ruleUpdate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.id) {
    return NextResponse.json({ success: false, error: 'Missing rule id' }, { status: 400 });
  }

  // Only allow updating specific fields
  const updates: Record<string, unknown> = {};
  const allowedFields = ['name', 'type', 'enabled', 'config', 'action', 'mute_duration_minutes', 'exempt_roles', 'exempt_channels', 'log_to_mod_channel'];

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('automod_rules')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing rule id' }, { status: 400 });
  }

  const { error } = await supabase
    .from('automod_rules')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
