/**
 * POST /api/license/heartbeat — Session keepalive.
 *
 * Architecture doc §30.9. Phase B: rate-limited.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { rateLimits } from '@/lib/api/rate-limit';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();

  // ── B.5: Rate limit ──
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const ipLimit = rateLimits.licenseHeartbeat(clientIp);
  if (ipLimit.limited) {
    return NextResponse.json(
      { valid: false, status: 'rate_limited', error: 'Too many requests' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(ipLimit.retryAfterMs / 1000)) },
      },
    );
  }

  let body: { session_id: string; license_key: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { valid: false, status: 'session_invalidated', error: 'Invalid request body' },
      { status: 400 },
    );
  }

  const { session_id, license_key } = body;

  if (!session_id || !license_key) {
    return NextResponse.json(
      { valid: false, status: 'session_invalidated', error: 'session_id and license_key are required' },
      { status: 400 },
    );
  }

  // Verify key
  const keyHash = sha256(license_key);
  const { data: licenseKey } = await supabase
    .from('license_keys')
    .select('id, status, product_id')
    .eq('key_hash', keyHash)
    .single();

  if (!licenseKey || licenseKey.status !== 'active') {
    return NextResponse.json({
      valid: false,
      status: licenseKey?.status ?? 'revoked',
      next_heartbeat_seconds: 0,
    });
  }

  // Check entitlement
  const { data: entitlement } = await supabase
    .from('entitlements')
    .select('status')
    .eq('license_key_id', licenseKey.id)
    .single();

  if (!entitlement || !['active', 'grace_period'].includes(entitlement.status)) {
    return NextResponse.json({
      valid: false,
      status: entitlement?.status ?? 'revoked',
      next_heartbeat_seconds: 0,
    });
  }

  // Update session last_seen_at
  const { data: session } = await supabase
    .from('license_sessions')
    .select('id, active')
    .eq('id', session_id)
    .eq('license_key_id', licenseKey.id)
    .single();

  if (!session || !session.active) {
    return NextResponse.json({
      valid: false,
      status: 'session_invalidated',
      next_heartbeat_seconds: 0,
    });
  }

  await supabase
    .from('license_sessions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', session_id);

  // Get heartbeat interval from config
  const { data: config } = await supabase
    .from('product_license_config')
    .select('heartbeat_interval_seconds')
    .eq('product_id', licenseKey.product_id)
    .maybeSingle();

  return NextResponse.json({
    valid: true,
    status: 'active',
    next_heartbeat_seconds: config?.heartbeat_interval_seconds ?? 300,
  });
}
