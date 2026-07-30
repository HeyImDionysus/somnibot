/**
 * Data Retention API — V5 Audit §5.2
 *
 * GET  → Read current retention setting for the active guild
 * POST → Update retention days (minimum 30, default 180)
 *
 * Important: New retention periods start from the moment the setting
 * is changed. There is no retroactive rewind — data already past the
 * previous retention window has already been purged.
 *
 * Audit-log floor: audit rows are anonymized (never deleted) on the
 * per-guild window via scrub_expired_audit_logs_all_guilds(). As of migration
 * 20260724190000 the scrub floors at 30 days — matching this route's
 * z.number().min(30) and the catalog retention-days minimum — so a 30–59 day
 * setting anonymizes audit rows on that exact window.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { getClientIp } from '@/lib/api/client-ip';
import { parseBody } from '@/lib/api/validation';
import { z } from 'zod';
import { readGuildConfigBefore, recordGuildConfigChange } from '@/lib/admin-changes';

const updateSchema = z.object({
  retention_days: z.number().int().min(30).max(3650),
});

export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  const clientIp = getClientIp(req);
  const rl = await checkRateLimit(`retention:read:${clientIp}`, 30, 60_000);
  if (rl.limited) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const admin = createAdminSupabase();
  const { data } = await admin
    .from('guild_config')
    .select('data_retention_days')
    .eq('guild_id', auth.ctx.guildId)
    .maybeSingle();

  return NextResponse.json({
    success: true,
    retention_days: data?.data_retention_days ?? 180,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  const clientIp = getClientIp(req);
  const rl = await checkRateLimit(`retention:write:${clientIp}`, 5, 60_000);
  if (rl.limited) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const parsed = await parseBody(req, updateSchema);
  if (!parsed.ok) return parsed.response;

  const admin = createAdminSupabase();
  const before = await readGuildConfigBefore(admin, auth.ctx.guildId, ['data_retention_days']);

  const { error } = await admin
    .from('guild_config')
    .update({ data_retention_days: parsed.data.retention_days })
    .eq('guild_id', auth.ctx.guildId);

  if (error) {
    console.error('[Retention] Update failed:', error.message);
    return NextResponse.json({ error: 'Failed to update retention setting' }, { status: 500 });
  }

  // Shortening retention causes irreversible purges, so this is high blast
  // radius. Restoring the number is still offered — it stops FUTURE purges —
  // but it cannot bring back rows an earlier sweep already deleted.
  await recordGuildConfigChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    action: 'retention.updated',
    area: 'data retention',
    updates: { data_retention_days: parsed.data.retention_days },
    before,
    blastRadius: 'high',
  }, admin);

  return NextResponse.json({
    success: true,
    retention_days: parsed.data.retention_days,
    note: 'New retention period starts now. Previously purged data cannot be recovered.',
  });
}
