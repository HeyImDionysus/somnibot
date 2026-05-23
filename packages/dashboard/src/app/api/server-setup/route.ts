/**
 * Setup API — Manages the setup wizard state.
 *
 * GET  /api/setup — Returns setup status (completed, confirmed, guild info)
 * POST /api/setup — Confirm setup completion (Step 7: owner clicks "Confirm")
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';

const serverSetupSchema = z.object({
  action: z.literal('confirm'),
});


export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const admin = createAdminSupabase();

  // Get guild info
  const { data: guild } = await admin
    .from('guild')
    .select('*')
    .eq('id', guildId)
    .single();

  // Get desired state
  const { data: desiredState } = await admin
    .from('guild_desired_state')
    .select('applied_at, roles, channels, updated_at')
    .eq('guild_id', guildId)
    .single();

  // Get discord ID mappings (populated after deploy)
  const { data: idMappings } = await admin
    .from('discord_id_map')
    .select('entity_type, template_key, discord_id')
    .eq('guild_id', guildId);

  // Get role templates
  const { data: roleTemplates } = await admin
    .from('role_templates')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true });
    .limit(500)

  // Get channel templates
  const { data: channelTemplates } = await admin
    .from('channel_templates')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true });
    .limit(500)

  const isDeployed = desiredState?.applied_at !== null && desiredState?.applied_at !== undefined;
  const hasDesiredState = desiredState?.roles && desiredState.roles.length > 0;

  return NextResponse.json({
    guild: guild
      ? {
          id: guild.id,
          name: guild.name,
          setupCompleted: guild.setup_completed,
          setupConfirmedAt: guild.setup_confirmed_at,
          botRolePosition: guild.bot_role_position,
        }
      : null,
    isDeployed,
    hasDesiredState,
    desiredState: desiredState ?? null,
    idMappings: idMappings ?? [],
    roleTemplates: roleTemplates ?? [],
    channelTemplates: channelTemplates ?? [],
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const parsed = await parseBody(request, serverSetupSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const admin = createAdminSupabase();

  // Step 7: Confirm setup complete
  {
    // Check that deployment actually happened
    const { data: desiredState } = await admin
      .from('guild_desired_state')
      .select('applied_at')
      .eq('guild_id', guildId)
      .single();

    if (!desiredState?.applied_at) {
      return NextResponse.json(
        { error: 'Cannot confirm — deployment not completed yet' },
        { status: 400 },
      );
    }

    // Mark setup as completed
    const { error } = await admin
      .from('guild')
      .update({
        setup_completed: true,
        setup_confirmed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', guildId);

    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 });

    // Audit log
    await admin.from('audit_logs').insert({
      guild_id: guildId,
      actor_type: 'dashboard',
      actor_id: 'setup-wizard',
      action: 'setup.confirmed',
      target_type: 'guild',
      target_id: guildId,
      details: { confirmedAt: new Date().toISOString() },
      success: true,
    });

    return NextResponse.json({
      success: true,
      message: 'Setup confirmed — all features are now unlocked',
    });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
