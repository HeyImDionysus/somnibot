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

  // Validate interval
  if ('sync_interval_minutes' in allowed && typeof allowed.sync_interval_minutes === 'number') {
    const val = allowed.sync_interval_minutes as number;
    if (val < 5) allowed.sync_interval_minutes = 5;
    if (val > 1440) allowed.sync_interval_minutes = 1440;
  }

  const { error } = await supabase
    .from('guild_config')
    .upsert({ guild_id: guildId, ...allowed }, { onConflict: 'guild_id' });

  if (error) {
    return dbError(error, 'sync/config');
  }

  // Notify the bot so it hot-reloads sync configuration.
  await notifyBot('settings', allowed);

  return NextResponse.json({ success: true });
}
