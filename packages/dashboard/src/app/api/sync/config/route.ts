/**
 * /api/sync/config — PUT sync engine configuration.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { notifyBot } from '@/lib/notify-bot';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { readGuildConfigBefore, recordGuildConfigChange } from '@/lib/admin-changes';


export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.sync.config);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data as Record<string, unknown>;

  const allowed: Record<string, unknown> = {};
  const fields = [
    'sync_enabled', 'sync_interval_minutes',
    'sync_auto_repair', 'sync_auto_repair_everyone',
  ];

  for (const key of fields) {
    if (key in body) allowed[key] = body[key];
  }

  // sync_interval_minutes range (5..1440) is enforced by schemas.sync.config,
  // which rejects out-of-range values with a 400 before this point — matching
  // the /api/sync update_config route (reject, never silently clamp/partial-write).

  const before = await readGuildConfigBefore(supabase, guildId, Object.keys(allowed));

  const { error } = await supabase
    .from('guild_config')
    .upsert({ guild_id: guildId, ...allowed }, { onConflict: 'guild_id' });

  if (error) {
    return dbError(error, 'sync/config');
  }

  // Notify the bot so it hot-reloads sync configuration.
  await notifyBot('settings', allowed);

  // Auto-repair rewrites roles/channels to match the dashboard, so a change
  // here can move real Discord objects on the next sync tick.
  await recordGuildConfigChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'sync.config_updated',
    area: 'server sync',
    updates: allowed,
    before,
    blastRadius: 'high',
  }, supabase);

  return NextResponse.json({ success: true });
}
