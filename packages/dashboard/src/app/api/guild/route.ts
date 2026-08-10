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
import { notifyBot } from '@/lib/notify-bot';
import { parseBody } from '@/lib/api/validation';
import { dbError } from '@/lib/api/response';
import { readGuildConfigBefore, recordGuildConfigChange } from '@/lib/admin-changes';
import { guildConfigPatchSchema } from '@/lib/guild-config-schema';

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

  const { data: liveState } = await admin
    .from('guild_live_state')
    .select('member_count')
    .eq('guild_id', guildId)
    .maybeSingle();

  return NextResponse.json({
    success: true,
    guild,
    config: guild.guild_config?.[0] ?? null,
    desiredState,
    memberCount: liveState?.member_count ?? 0,
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

  // Validate with Zod via centralized parseBody
  const parsed = await parseBody(request, guildConfigPatchSchema);
  if (!parsed.ok) return parsed.response;

  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  const admin = createAdminSupabase();
  const before = await readGuildConfigBefore(admin, guildId, Object.keys(updates));

  const { error } = await admin
    .from('guild_config')
    .upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' });

  if (error) return dbError(error, 'guild');

  // Notify the bot so it hot-reloads the changed config immediately.
  // Fields in this schema span multiple feature areas — use 'all' to cover them.
  // Carry the captured pre-write values through the bot action queue. The
  // bot's append-only audit rail uses this exact snapshot for the
  // config.updated before/after record; reading after the upsert would make
  // the diff appear unchanged.
  await notifyBot(guildId, 'all', updates, auth.ctx.discordId, undefined, before);

  await recordGuildConfigChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'guild.config_updated',
    area: 'server settings',
    updates,
    before,
  }, admin);

  return NextResponse.json({ success: true });
}
