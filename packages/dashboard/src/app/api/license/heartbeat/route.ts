/**
 * POST /api/license/heartbeat — Session keepalive.
 *
 * Architecture doc §30.9.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { parseBody, schemas } from '@/lib/api/validation';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();

  const parsed = await parseBody(req, schemas.licenseSdk.heartbeat);
  if (!parsed.ok) return parsed.response;
  const { session_id, license_key } = parsed.data;

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
