/**
 * POST /api/license/validate — Universal License Validation API.
 *
 * Public endpoint (rate-limited). Called by external apps to verify a license.
 * Architecture doc §30.8.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { parseBody, schemas } from '@/lib/api/validation';

interface ValidateRequest {
  license_key: string;
  product_id: string;
  device_fingerprint?: string;
  device_name?: string;
  app_version?: string;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();

  let body: ValidateRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { valid: false, status: 'revoked', error: 'Invalid request body' },
      { status: 400 },
    );
  }

  const { license_key, product_id, device_fingerprint, device_name, app_version } = body;

  if (!license_key || !product_id) {
    return NextResponse.json(
      { valid: false, status: 'revoked', error: 'license_key and product_id are required' },
      { status: 400 },
    );
  }

  // 1. Hash the key and look up
  const keyHash = sha256(license_key);
  const { data: licenseKey } = await supabase
    .from('license_keys')
    .select('*')
    .eq('key_hash', keyHash)
    .single();

  if (!licenseKey) {
    await logValidation(supabase, null, product_id, device_fingerprint, 'invalid_key', req);
    return NextResponse.json({ valid: false, status: 'revoked', error: 'Invalid license key' });
  }

  // 2. Check key status
  if (licenseKey.status !== 'active') {
    await logValidation(supabase, licenseKey.id, product_id, device_fingerprint, licenseKey.status as string, req);
    return NextResponse.json({
      valid: false,
      status: licenseKey.status,
      error: `License is ${licenseKey.status}`,
    });
  }

  // 3. Check product match
  if (licenseKey.product_id !== product_id) {
    await logValidation(supabase, licenseKey.id, product_id, device_fingerprint, 'product_mismatch', req);
    return NextResponse.json({
      valid: false,
      status: 'revoked',
      error: 'License is not valid for this product',
    });
  }

  // 4. Check entitlement
  const { data: entitlement } = await supabase
    .from('entitlements')
    .select('*')
    .eq('license_key_id', licenseKey.id)
    .single();

  if (!entitlement || !['active', 'grace_period'].includes(entitlement.status)) {
    await logValidation(supabase, licenseKey.id, product_id, device_fingerprint, entitlement?.status ?? 'revoked', req);
    return NextResponse.json({
      valid: false,
      status: entitlement?.status ?? 'revoked',
      error: 'Entitlement not active',
    });
  }

  // 5. Check expiry
  if (entitlement.expires_at && new Date(entitlement.expires_at) < new Date()) {
    await supabase
      .from('entitlements')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', entitlement.id);

    await logValidation(supabase, licenseKey.id, product_id, device_fingerprint, 'expired', req);
    return NextResponse.json({ valid: false, status: 'expired', error: 'License has expired' });
  }

  // 6. Get license config
  const { data: licenseConfig } = await supabase
    .from('product_license_config')
    .select('*')
    .eq('product_id', product_id)
    .maybeSingle();

  // 7. Get customer info
  const { data: customer } = await supabase
    .from('customers')
    .select('discord_username, discord_id')
    .eq('id', licenseKey.customer_id)
    .single();

  // 8. Multi-device tracking
  let sessionId: string | undefined;

  if (device_fingerprint && licenseConfig) {
    const { data: activeSessions } = await supabase
      .from('license_sessions')
      .select('*')
      .eq('license_key_id', licenseKey.id)
      .eq('active', true);

    const sessions = activeSessions ?? [];
    const existingSession = sessions.find(
      (s) => s.device_fingerprint === device_fingerprint,
    );

    if (!existingSession && sessions.length >= (licenseConfig.max_devices || 3)) {
      // Over device limit — invalidate oldest session
      const oldest = [...sessions].sort(
        (a, b) => new Date(a.last_seen_at).getTime() - new Date(b.last_seen_at).getTime(),
      )[0];

      if (oldest) {
        await supabase
          .from('license_sessions')
          .update({
            active: false,
            deactivated_at: new Date().toISOString(),
            deactivation_reason: 'device_limit',
          })
          .eq('id', oldest.id);
      }
    }

    const now = new Date().toISOString();
    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

    if (existingSession) {
      const { data: updated } = await supabase
        .from('license_sessions')
        .update({
          last_seen_at: now,
          device_name: device_name ?? existingSession.device_name,
          app_version: app_version ?? existingSession.app_version,
          ip_address: clientIp ?? existingSession.ip_address,
        })
        .eq('id', existingSession.id)
        .select('id')
        .single();

      sessionId = updated?.id;
    } else {
      const { data: inserted } = await supabase
        .from('license_sessions')
        .insert({
          license_key_id: licenseKey.id,
          device_fingerprint,
          device_name: device_name ?? null,
          app_version: app_version ?? null,
          ip_address: clientIp,
          active: true,
        })
        .select('id')
        .single();

      sessionId = inserted?.id;
    }
  }

  // Log validation
  await logValidation(supabase, licenseKey.id, product_id, device_fingerprint, 'valid', req);

  return NextResponse.json({
    valid: true,
    status: 'active',
    entitlement_id: entitlement.id,
    features: licenseConfig?.feature_flags ?? [],
    tier: licenseConfig?.tier ?? null,
    customer_discord_id: customer?.discord_id,
    customer_name: customer?.discord_username,
    expires_at: entitlement.expires_at,
    session_id: sessionId ?? null,
    heartbeat_interval_seconds: licenseConfig?.heartbeat_interval_seconds ?? 0,
  });
}

async function logValidation(
  supabase: ReturnType<typeof createAdminSupabase>,
  licenseKeyId: string | null,
  productId: string,
  deviceFingerprint: string | undefined,
  result: string,
  req: NextRequest,
): Promise<void> {
  if (!licenseKeyId) return;
  try {
    await supabase.from('license_validations').insert({
      license_key_id: licenseKeyId,
      product_id: productId,
      device_fingerprint: deviceFingerprint ?? null,
      result,
      ip_address: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    });
  } catch {
    // Non-critical — don't fail the validation
  }
}
