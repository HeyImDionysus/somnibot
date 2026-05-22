/**
 * POST /api/license/validate — Universal License Validation API.
 *
 * Public endpoint. Called by external apps to verify a license.
 * Architecture doc §30.8.
 *
 * Phase B enhancements:
 * - IP + key rate limiting to prevent brute-force.
 * - Invalid key attempts logged even when key not found.
 * - Failed attempt counter on the key record for abuse detection.
 * - Configurable device policy: 'evict_oldest' or 'reject'.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { rateLimits } from '@/lib/api/rate-limit';
import { parseBody, schemas } from '@/lib/api/validation';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function getClientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? 'unknown';
}

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();
  const clientIp = getClientIp(req);

  // ── B.5: Rate limit by IP ──
  const ipLimit = await rateLimits.licenseValidate(clientIp);
  if (ipLimit.limited) {
    return NextResponse.json(
      { valid: false, status: 'rate_limited', error: 'Too many requests' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(ipLimit.retryAfterMs / 1000)) },
      },
    );
  }

  const parsed = await parseBody(req, schemas.licenseSdk.validate);
  if (!parsed.ok) return parsed.response;
  const { license_key, product_id, device_fingerprint, device_name, app_version } = parsed.data;

  if (!license_key || !product_id) {
    return NextResponse.json(
      { valid: false, status: 'revoked', error: 'license_key and product_id are required' },
      { status: 400 },
    );
  }

  // 1. Hash the key and look up
  const keyHash = sha256(license_key);

  // ── B.5: Per-key rate limit ──
  const keyLimit = await rateLimits.licensePerKey(keyHash);
  if (keyLimit.limited) {
    return NextResponse.json(
      { valid: false, status: 'rate_limited', error: 'Too many requests for this license' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(keyLimit.retryAfterMs / 1000)) },
      },
    );
  }

  const { data: licenseKey } = await supabase
    .from('license_keys')
    .select('*')
    .eq('key_hash', keyHash)
    .single();

  if (!licenseKey) {
    // ── B.5: Log invalid key attempt with IP (even though key not found) ──
    const failedLimit = await rateLimits.licenseFailedAttempt(clientIp);

    // Log the attempt to license_validations with a synthetic reference
    await supabase.from('license_validations').insert({
      license_key_id: null, // FK is nullable — no key found, logged for audit
      product_id: product_id,
      device_fingerprint: device_fingerprint ?? null,
      result: 'invalid_key',
      ip_address: clientIp,
      app_version: app_version ?? null,
    }).then(() => {}, () => {});

    // If too many failed attempts from this IP, return rate limited
    if (failedLimit.limited) {
      return NextResponse.json(
        { valid: false, status: 'rate_limited', error: 'Too many failed attempts' },
        { status: 429 },
      );
    }

    return NextResponse.json({ valid: false, status: 'revoked', error: 'Invalid license key' });
  }

  // 2. Check key status
  if (licenseKey.status !== 'active') {
    await logValidation(supabase, licenseKey.id, product_id, device_fingerprint, licenseKey.status as string, clientIp, app_version);
    return NextResponse.json({
      valid: false,
      status: licenseKey.status,
      error: `License is ${licenseKey.status}`,
    });
  }

  // 3. Check product match
  if (licenseKey.product_id !== product_id) {
    await logValidation(supabase, licenseKey.id, product_id, device_fingerprint, 'product_mismatch', clientIp, app_version);

    // ── B.5: Increment failed attempt counter ──
    await incrementFailedAttempts(supabase, licenseKey.id);

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
    await logValidation(supabase, licenseKey.id, product_id, device_fingerprint, entitlement?.status ?? 'revoked', clientIp, app_version);
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

    await logValidation(supabase, licenseKey.id, product_id, device_fingerprint, 'expired', clientIp, app_version);
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
      // ── B.5: Configurable device policy ──
      const devicePolicy = licenseConfig.device_policy || 'evict_oldest';

      if (devicePolicy === 'reject') {
        await logValidation(supabase, licenseKey.id, product_id, device_fingerprint, 'over_device_limit', clientIp, app_version);
        return NextResponse.json({
          valid: false,
          status: 'over_device_limit',
          error: `Maximum ${licenseConfig.max_devices || 3} devices reached. Deactivate an existing device first.`,
          active_devices: sessions.length,
          max_devices: licenseConfig.max_devices || 3,
        });
      }

      // evict_oldest: invalidate oldest session
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

  // Run fraud checks (non-blocking — don't delay validation response)
  if (device_fingerprint && licenseConfig) {
    // Get guild_id from product for fraud signal tracking
    const { data: product } = await supabase
      .from('products')
      .select('guild_id')
      .eq('id', product_id)
      .single();

    if (product?.guild_id) {
      const guildId = product.guild_id;
      const maxDevices = licenseConfig.max_devices || 3;
      // Fire-and-forget — these write to fraud_signals if thresholds exceeded
      checkDeviceAbuse(supabase, guildId, licenseKey.id, maxDevices, customer?.discord_id ?? null).catch(() => {});
      checkIPMismatch(supabase, guildId, licenseKey.id, customer?.discord_id ?? null).catch(() => {});
    }
  }

  // Log validation
  await logValidation(supabase, licenseKey.id, product_id, device_fingerprint, 'valid', clientIp, app_version);

  // Reset failed attempt counter on successful validation
  if (licenseKey.failed_attempts > 0) {
    await supabase
      .from('license_keys')
      .update({ failed_attempts: 0 })
      .eq('id', licenseKey.id);
  }

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
  clientIp: string,
  appVersion?: string,
): Promise<void> {
  try {
    await supabase.from('license_validations').insert({
      license_key_id: licenseKeyId,
      product_id: productId,
      device_fingerprint: deviceFingerprint ?? null,
      result,
      ip_address: clientIp,
      app_version: appVersion ?? null,
    });
  } catch {
    // Non-critical
  }
}

/**
 * Atomically increment failed attempt counter on a license key.
 * If threshold exceeded (50 failures), auto-suspends the key in the same transaction.
 * Uses an RPC to avoid read-modify-write TOCTOU under concurrent brute-force.
 */
async function incrementFailedAttempts(
  supabase: ReturnType<typeof createAdminSupabase>,
  licenseKeyId: string,
): Promise<void> {
  const SUSPEND_THRESHOLD = 50;

  try {
    const { data: newCount, error } = await supabase.rpc('license_increment_failed_attempts', {
      p_license_key_id: licenseKeyId,
      p_suspend_threshold: SUSPEND_THRESHOLD,
    });

    if (error) {
      console.error(`[License] license_increment_failed_attempts RPC failed:`, error.message);
      return;
    }

    if (newCount >= SUSPEND_THRESHOLD) {
      console.warn(`[License] Key ${licenseKeyId} auto-suspended after ${newCount} failed attempts`);
    }
  } catch {
    // Non-critical
  }
}


// ── Fraud Signal Checks ────────────────────────────────────
// Inline checks run during validation. These insert fraud_signals records
// directly — the bot-side checkCriticalThreshold picks up the cumulative
// count and triggers incidents / owner DMs.

async function checkDeviceAbuse(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  licenseKeyId: string,
  maxDevices: number,
  discordId: string | null,
): Promise<void> {
  try {
    const { count } = await supabase
      .from('license_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('license_key_id', licenseKeyId);

    const totalDevices = count || 0;

    if (totalDevices > maxDevices * 3) {
      await supabase.from('fraud_signals').insert({
        guild_id: guildId,
        signal_type: 'device_abuse',
        severity: totalDevices > maxDevices * 5 ? 'critical' : 'high',
        entity_type: 'license_key',
        entity_id: licenseKeyId,
        discord_id: discordId,
        description: `${totalDevices} total device sessions on a ${maxDevices}-device license`,
        evidence: { total_sessions: totalDevices, max_devices: maxDevices, ratio: totalDevices / maxDevices },
        status: 'open',
      });
    }
  } catch {
    // Non-fatal — don't break validation
  }
}

async function checkIPMismatch(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  licenseKeyId: string,
  discordId: string | null,
): Promise<void> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: sessions } = await supabase
      .from('license_sessions')
      .select('ip_address')
      .eq('license_key_id', licenseKeyId)
      .gte('first_seen_at', since);

    const uniqueIPs = new Set((sessions || []).map(s => s.ip_address).filter(Boolean));

    if (uniqueIPs.size >= 5) {
      await supabase.from('fraud_signals').insert({
        guild_id: guildId,
        signal_type: 'ip_mismatch',
        severity: uniqueIPs.size >= 10 ? 'critical' : 'medium',
        entity_type: 'license_key',
        entity_id: licenseKeyId,
        discord_id: discordId,
        description: `${uniqueIPs.size} unique IPs in the last 24 hours`,
        evidence: { unique_ips: uniqueIPs.size, window_hours: 24 },
        status: 'open',
      });
    }
  } catch {
    // Non-fatal — don't break validation
  }
}
