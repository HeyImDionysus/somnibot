/**
 * POST /api/license/validate — Universal License Validation API.
 *
 * Public endpoint. Called by external apps to verify a license.
 * Architecture doc §30.8.
 *
 * V5 Audit §3.1: Uses composite `license_validate_lookup` RPC to collapse
 * 4 sequential queries (key + entitlement + config + customer) into 1.
 * The atomic `license_validate_device` RPC stays separate (needs FOR UPDATE).
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

// ── Composite lookup result shape ────────────────────────────
interface LookupResult {
  found: boolean;
  key_id?: string;
  key_status?: string;
  key_product_id?: string;
  key_customer_id?: string;
  key_failed_attempts?: number;
  entitlement_id?: string;
  entitlement_status?: string;
  entitlement_expires_at?: string;
  config_max_devices?: number;
  config_device_policy?: string;
  config_feature_flags?: string[];
  config_tier?: string;
  config_heartbeat_interval_seconds?: number;
  customer_discord_username?: string;
  customer_discord_id?: string;
  product_guild_id?: string;
}

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();
  const clientIp = getClientIp(req);

  // ── Rate limit by IP ──
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

  // 1. Hash the key
  const keyHash = sha256(license_key);

  // ── Per-key rate limit ──
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

  // ── V5 Audit §3.1: Composite lookup — 4 queries in 1 RPC ──
  const { data: lookup, error: lookupError } = await supabase.rpc('license_validate_lookup', {
    p_key_hash: keyHash,
    p_product_id: product_id,
  });

  if (lookupError) {
    console.error('[License] license_validate_lookup RPC error:', lookupError.message);
    return NextResponse.json(
      { valid: false, status: 'revoked', error: 'Internal validation error' },
      { status: 500 },
    );
  }

  const result = lookup as LookupResult;

  if (!result.found) {
    // Log invalid key attempt with IP
    const failedLimit = await rateLimits.licenseFailedAttempt(clientIp);

    await supabase.from('license_validations').insert({
      license_key_id: null,
      product_id: product_id,
      device_fingerprint: device_fingerprint ?? null,
      result: 'invalid_key',
      ip_address: clientIp,
      app_version: app_version ?? null,
    }).then(() => {}, () => {});

    if (failedLimit.limited) {
      return NextResponse.json(
        { valid: false, status: 'rate_limited', error: 'Too many failed attempts' },
        { status: 429 },
      );
    }

    return NextResponse.json({ valid: false, status: 'revoked', error: 'Invalid license key' });
  }

  // 2. Check key status
  if (result.key_status !== 'active') {
    await logValidation(supabase, result.key_id!, product_id, device_fingerprint, result.key_status as string, clientIp, app_version);
    return NextResponse.json({
      valid: false,
      status: result.key_status,
      error: `License is ${result.key_status}`,
    });
  }

  // 3. Check product match
  if (result.key_product_id !== product_id) {
    await logValidation(supabase, result.key_id!, product_id, device_fingerprint, 'product_mismatch', clientIp, app_version);
    await incrementFailedAttempts(supabase, result.key_id!);
    return NextResponse.json({
      valid: false,
      status: 'revoked',
      error: 'License is not valid for this product',
    });
  }

  // 4. Check entitlement
  if (!result.entitlement_id || !['active', 'grace_period'].includes(result.entitlement_status ?? '')) {
    await logValidation(supabase, result.key_id!, product_id, device_fingerprint, result.entitlement_status ?? 'revoked', clientIp, app_version);
    return NextResponse.json({
      valid: false,
      status: result.entitlement_status ?? 'revoked',
      error: 'Entitlement not active',
    });
  }

  // 5. Check expiry
  if (result.entitlement_expires_at && new Date(result.entitlement_expires_at) < new Date()) {
    await supabase
      .from('entitlements')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', result.entitlement_id);

    await logValidation(supabase, result.key_id!, product_id, device_fingerprint, 'expired', clientIp, app_version);
    return NextResponse.json({ valid: false, status: 'expired', error: 'License has expired' });
  }

  // 6. Multi-device tracking (atomic RPC stays separate — needs FOR UPDATE)
  let sessionId: string | undefined;

  if (device_fingerprint && result.config_max_devices) {
    const { data: deviceResult, error: deviceError } = await supabase
      .rpc('license_validate_device', {
        p_license_key_id: result.key_id,
        p_device_fingerprint: device_fingerprint,
        p_device_name: device_name ?? null,
        p_app_version: app_version ?? null,
        p_ip_address: clientIp,
        p_max_devices: result.config_max_devices || 3,
        p_device_policy: result.config_device_policy || 'evict_oldest',
      });

    if (deviceError) {
      console.error('[License] Device validation RPC error:', deviceError.message);
    } else if (deviceResult?.status === 'over_device_limit') {
      await logValidation(supabase, result.key_id!, product_id, device_fingerprint, 'over_device_limit', clientIp, app_version);
      return NextResponse.json({
        valid: false,
        status: 'over_device_limit',
        error: `Maximum ${result.config_max_devices || 3} devices reached. Deactivate an existing device first.`,
        active_devices: deviceResult.active_devices,
        max_devices: deviceResult.max_devices,
      });
    } else if (deviceResult?.session_id) {
      sessionId = deviceResult.session_id;
    }
  }

  // Fraud checks (non-blocking — fire-and-forget)
  // V11 Audit M-8: Also check critical fraud signal threshold after device/IP checks
  // so accumulated signals auto-create incidents.
  if (device_fingerprint && result.config_max_devices && result.product_guild_id) {
    const guildId = result.product_guild_id;
    const maxDevices = result.config_max_devices || 3;
    Promise.allSettled([
      checkDeviceAbuse(supabase, guildId, result.key_id!, maxDevices, result.customer_discord_id ?? null),
      checkIPMismatch(supabase, guildId, result.key_id!, result.customer_discord_id ?? null),
    ]).then(() => checkCriticalFraudThreshold(supabase, guildId)).catch(() => {});
  }

  // Log validation
  await logValidation(supabase, result.key_id!, product_id, device_fingerprint, 'valid', clientIp, app_version);

  // Reset failed attempt counter on successful validation
  if ((result.key_failed_attempts ?? 0) > 0) {
    await supabase
      .from('license_keys')
      .update({ failed_attempts: 0 })
      .eq('id', result.key_id);
  }

  return NextResponse.json({
    valid: true,
    status: 'active',
    entitlement_id: result.entitlement_id,
    features: result.config_feature_flags ?? [],
    tier: result.config_tier ?? null,
    customer_discord_id: result.customer_discord_id,
    customer_name: result.customer_discord_username,
    expires_at: result.entitlement_expires_at,
    session_id: sessionId ?? null,
    heartbeat_interval_seconds: result.config_heartbeat_interval_seconds ?? 0,
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
      .eq('license_key_id', licenseKeyId)
      .eq('active', true);

    const activeDevices = count || 0;

    if (activeDevices > maxDevices * 3) {
      await supabase.from('fraud_signals').insert({
        guild_id: guildId,
        signal_type: 'device_abuse',
        severity: activeDevices > maxDevices * 5 ? 'critical' : 'high',
        entity_type: 'license_key',
        entity_id: licenseKeyId,
        discord_id: discordId,
        description: `${activeDevices} active device sessions on a ${maxDevices}-device license`,
        evidence: { active_sessions: activeDevices, max_devices: maxDevices, ratio: activeDevices / maxDevices },
        status: 'open',
      });
    }
  } catch {
    // Non-fatal
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
      .gte('first_seen_at', since)
      .limit(1000);

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
    // Non-fatal
  }
}

/**
 * V11 Audit M-8: Auto-create an incident when ≥ 3 critical fraud signals
 * accumulate within the last hour for a guild.
 *
 * Mirror of the bot's `checkCriticalThreshold` — runs in the dashboard
 * context (no event bus) after license validation fraud checks.
 */
async function checkCriticalFraudThreshold(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
): Promise<void> {
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const { count } = await supabase
      .from('fraud_signals')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', guildId)
      .eq('status', 'open')
      .eq('severity', 'critical')
      .gte('created_at', since);

    if (!count || count < 3) return;

    // Check if we already created an incident for this burst
    const { data: existing } = await supabase
      .from('incidents')
      .select('id')
      .eq('guild_id', guildId)
      .eq('source', 'fraud_auto')
      .not('status', 'eq', 'resolved')
      .gte('created_at', since)
      .limit(1);

    if (existing && existing.length > 0) return;

    const { data: seqVal } = await supabase.rpc('nextval_incident');
    const nextNumber = typeof seqVal === 'number' ? seqVal : 1;

    const { data: incident } = await supabase
      .from('incidents')
      .insert({
        guild_id: guildId,
        incident_number: nextNumber,
        title: `Fraud alert: ${count} critical signals in the last hour`,
        description: 'Auto-created incident due to elevated critical fraud signals during license validation.',
        severity: 'critical',
        status: 'open',
        source: 'fraud_auto',
        created_by: 'system:fraud',
      })
      .select()
      .single();

    if (incident) {
      await supabase.from('incident_events').insert({
        incident_id: incident.id,
        event_type: 'auto_created',
        actor_id: 'system:fraud',
        message: `${count} critical fraud signals detected in the last hour. Automatic incident created.`,
        metadata: { signal_count: count },
      });
    }
  } catch {
    // Non-fatal — don't let incident creation break license validation
  }
}
