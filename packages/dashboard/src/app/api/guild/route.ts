/**
 * GET /api/guild — Fetch guild info, bot status, and config.
 * PATCH /api/guild — Update guild config.
 *
 * SECURITY (Phase A):
 * - Uses requireGuildOwner() — no fallback to "any guild".
 * - PATCH validates fields against a Zod schema + allowlist.
 * - Rate-limited (V17 Behavioral Audit — Item 8).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { z } from 'zod';

const guildConfigPatchSchema = z.object({
  mod_log_channel_id: z.string().nullable().optional(),
  welcome_channel_id: z.string().nullable().optional(),
  goodbye_channel_id: z.string().nullable().optional(),
  level_up_channel_id: z.string().nullable().optional(),
  store_channel_id: z.string().nullable().optional(),
  music_enabled: z.boolean().optional(),
  music_default_volume: z.number().int().min(0).max(150).optional(),
  dj_role_id: z.string().nullable().optional(),
  stats_enabled: z.boolean().optional(),
  temp_channels_enabled: z.boolean().optional(),
  scheduled_messages_enabled: z.boolean().optional(),
  giveaways_enabled: z.boolean().optional(),
  // V17: New fields
  no_xp_role_id: z.string().nullable().optional(),
  anti_raid_enabled: z.boolean().optional(),
  anti_raid_join_threshold: z.number().int().min(2).max(100).optional(),
  anti_raid_join_window_seconds: z.number().int().min(5).max(120).optional(),
  anti_raid_account_age_days: z.number().int().min(0).max(365).optional(),
  anti_raid_action: z.enum(['kick', 'ban', 'lockdown']).optional(),
  anti_raid_log_channel_id: z.string().nullable().optional(),
  starboard_enabled: z.boolean().optional(),
  starboard_channel_id: z.string().nullable().optional(),
  starboard_threshold: z.number().int().min(1).max(100).optional(),
  starboard_emoji: z.string().max(64).optional(),
  starboard_self_star: z.boolean().optional(),
  message_log_enabled: z.boolean().optional(),
  message_log_channel_id: z.string().nullable().optional(),
}).strict();

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const admin = createAdminSupabase();

  const { data: guild } = await admin
    .from('guild')
    .select('*, guild_config(*)')
    .eq('id', guildId)
    .single();

  if (!guild) {
    return NextResponse.json({ error: 'Guild not found' }, { status: 404 });
  }

  // Get desired state
  const { data: desiredState } = await admin
    .from('guild_desired_state')
    .select('*')
    .eq('guild_id', guildId)
    .single();

  return NextResponse.json({
    guild,
    config: guild.guild_config?.[0] ?? null,
    desiredState,
    totalRoles: guild.total_roles ?? null,
  });
}

export async function PATCH(request: NextRequest) {
  // Rate limit: write preset (30 req/min)
  const limited = await checkAdminRateLimit(request, 'write');
  if (limited) return limited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  // Validate with Zod
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = guildConfigPatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  const admin = createAdminSupabase();
  const { error } = await admin
    .from('guild_config')
    .upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
