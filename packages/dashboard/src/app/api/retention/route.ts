/**
 * Data Retention API — V5 Audit §5.2
 *
 * GET  → Read current retention setting for the active guild
 * POST → Update retention days (minimum 30, default 180)
 *
 * Important: New retention periods start from the moment the setting
 * is changed. There is no retroactive rewind — data already past the
 * previous retention window has already been purged.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { z } from 'zod';

const updateSchema = z.object({
  retention_days: z.number().int().min(30).max(3650),
});

export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? '127.0.0.1';
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

  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? '127.0.0.1';
  const rl = await checkRateLimit(`retention:write:${clientIp}`, 5, 60_000);
  if (rl.limited) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid retention_days', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = createAdminSupabase();
  const { error } = await admin
    .from('guild_config')
    .update({ data_retention_days: parsed.data.retention_days })
    .eq('guild_id', auth.ctx.guildId);

  if (error) {
    console.error('[Retention] Update failed:', error.message);
    return NextResponse.json({ error: 'Failed to update retention setting' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    retention_days: parsed.data.retention_days,
    note: 'New retention period starts now. Previously purged data cannot be recovered.',
  });
}
