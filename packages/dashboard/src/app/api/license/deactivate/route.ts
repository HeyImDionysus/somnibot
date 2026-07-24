/**
 * POST /api/license/deactivate — Device cleanup (app uninstall).
 *
 * Architecture doc §30.10.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { parseBody, schemas } from '@/lib/api/validation';
import { rateLimits } from '@/lib/api/rate-limit';
import { dbError } from '@/lib/api/response';
import { writeCommerceAudit } from '@/lib/commerce-audit';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();

  // ── B.5: Rate limit ──
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const ipLimit = await rateLimits.licenseDeactivate(clientIp);
  if (ipLimit.limited) {
    return NextResponse.json(
      { success: false, error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(ipLimit.retryAfterMs / 1000)) } },
    );
  }

  const parsed = await parseBody(req, schemas.licenseSdk.deactivate);
  if (!parsed.ok) return parsed.response;
  const { session_id, license_key } = parsed.data;

  if (!session_id || !license_key) {
    return NextResponse.json(
      { success: false, error: 'session_id and license_key are required' },
      { status: 400 },
    );
  }

  // Verify key ownership
  const keyHash = sha256(license_key);
  const { data: licenseKey } = await supabase
    .from('license_keys')
    .select('id, guild_id, bound_discord_id')
    .eq('key_hash', keyHash)
    .single();

  if (!licenseKey) {
    return NextResponse.json({ success: false, error: 'Invalid license key' }, { status: 400 });
  }

  // Deactivate the session
  const { data: deactivated, error } = await supabase
    .from('license_sessions')
    .update({
      active: false,
      deactivated_at: new Date().toISOString(),
      deactivation_reason: 'user_deactivated',
    })
    .eq('id', session_id)
    .eq('license_key_id', licenseKey.id)
    .select('id');

  if (error) {
    return dbError(error, 'license/deactivate');
  }

  // Append-only audit: buyer deactivated a device (app uninstall / cleanup).
  // Only write when a session actually flipped, so a no-op replay is not logged.
  if (deactivated && deactivated.length > 0) {
    await writeCommerceAudit(supabase, {
      guildId: licenseKey.guild_id,
      actorType: 'user',
      actorId: (licenseKey.bound_discord_id as string | null) ?? 'license-sdk',
      action: 'license.session_deactivated',
      targetType: 'license_session',
      targetId: session_id,
      details: { reason: 'user_deactivated', licenseKeyId: licenseKey.id },
    });
  }

  return NextResponse.json({ success: true });
}
