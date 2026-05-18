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

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();

  // ── B.5: Rate limit ──
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const ipLimit = rateLimits.licenseDeactivate(clientIp);
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
    .select('id')
    .eq('key_hash', keyHash)
    .single();

  if (!licenseKey) {
    return NextResponse.json({ success: false, error: 'Invalid license key' }, { status: 400 });
  }

  // Deactivate the session
  const { error } = await supabase
    .from('license_sessions')
    .update({
      active: false,
      deactivated_at: new Date().toISOString(),
      deactivation_reason: 'user_deactivated',
    })
    .eq('id', session_id)
    .eq('license_key_id', licenseKey.id);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
