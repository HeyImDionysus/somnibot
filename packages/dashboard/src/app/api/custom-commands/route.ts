/**
 * /api/custom-commands — CRUD for custom slash commands.
 *
 * GET: List all custom commands for the guild
 * POST: Create a new custom command
 * PUT: Update an existing custom command
 * DELETE: Delete a custom command by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { parseBody, schemas } from '@/lib/api/validation';
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('custom_commands')
    .select('*')
    .eq('guild_id', guildId)
    .order('name', { ascending: true });

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
  const parsed = await parseBody(req, schemas.customCommand.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const {
    name,
    description,
    actions,
    allowed_roles,
    allowed_channels,
    denied_roles,
    denied_channels,
    cooldown_seconds,
    ephemeral,
  } = body;

  if (!name) {
    return NextResponse.json(
      { success: false, error: 'Missing required field: name' },
      { status: 400 },
    );
  }

  // Validate command name (Discord requirements: lowercase, no spaces, 1-32 chars)
  const cleanName = name.toLowerCase().replace(/\s+/g, '-');
  if (!/^[\w-]{1,32}$/.test(cleanName)) {
    return NextResponse.json(
      { success: false, error: 'Invalid command name. Use lowercase letters, numbers, and hyphens (1-32 chars).' },
      { status: 400 },
    );
  }

  // Check limit (max 25 custom commands)
  const { count } = await supabase
    .from('custom_commands')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guildId);

  if ((count ?? 0) >= 25) {
    return NextResponse.json(
      { success: false, error: 'Maximum custom commands limit reached (25)' },
      { status: 400 },
    );
  }

  // Check for duplicate name
  const { data: existing } = await supabase
    .from('custom_commands')
    .select('id')
    .eq('guild_id', guildId)
    .eq('name', cleanName)
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      { success: false, error: `A command named "/${cleanName}" already exists.` },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('custom_commands')
    .insert({
      guild_id: guildId,
      name: cleanName,
      description: description ?? `Custom command: ${cleanName}`,
      actions: actions ?? [],
      allowed_roles: allowed_roles ?? [],
      allowed_channels: allowed_channels ?? [],
      denied_roles: denied_roles ?? [],
      denied_channels: denied_channels ?? [],
      cooldown_seconds: cooldown_seconds ?? 0,
      ephemeral: ephemeral ?? false,
      enabled: true,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('custom-commands');

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.customCommand.update);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.id) {
    return NextResponse.json(
      { success: false, error: 'Missing command id' },
      { status: 400 },
    );
  }

  const allowedFields = [
    'name',
    'description',
    'actions',
    'allowed_roles',
    'allowed_channels',
    'denied_roles',
    'denied_channels',
    'cooldown_seconds',
    'ephemeral',
    'enabled',
  ];

  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('custom_commands')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('custom-commands');

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
    return NextResponse.json(
      { success: false, error: 'Missing command id' },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from('custom_commands')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('custom-commands');

  return NextResponse.json({ success: true });
}
