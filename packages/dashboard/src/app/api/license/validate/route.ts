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
    runFraudChecks(supabase, guildId, result.key_id!, maxDevices, result.customer_discord_id ?? null)
      .catch((err) => {
        console.error('[License] Fraud check pipeline crashed:', err instanceof Error ? err.message : err);
      });
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

/** Operator-visible alert type for fraud check outages (see `alerts` table). */
const FRAUD_ALERT_TYPE = 'fraud_check_failure';

/**
 * Minimum time between alert write attempts per guild (per instance).
 * The alert row itself is deduped in the DB (one unresolved row per guild,
 * mirroring the bot's AlertManager pattern); this throttle keeps a sustained
 * outage from adding alert-write DB load on every validation.
 */
const FRAUD_ALERT_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Bounded per-instance throttle: guild_id → last alert write attempt (epoch ms). */
const FRAUD_ALERT_THROTTLE_MAX_ENTRIES = 1000;
const fraudAlertLastAttempt = new Map<string, number>();

interface FraudCheckFailure {
  check: string;
  error: string;
}

/**
 * Run all fraud checks and surface any failures.
 *
 * Fire-and-forget from the caller's perspective — validation latency is
 * unaffected — but failures are no longer invisible: each failed check is
 * logged and an operator-visible `alerts` row is written (deduped/throttled)
 * so a fraud-detection outage is detectable.
 */
async function runFraudChecks(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  licenseKeyId: string,
  maxDevices: number,
  discordId: string | null,
): Promise<void> {
  const checks = [
    { name: 'device_abuse', run: () => checkDeviceAbuse(supabase, guildId, licenseKeyId, maxDevices, discordId) },
    { name: 'ip_mismatch', run: () => checkIPMismatch(supabase, guildId, licenseKeyId, discordId) },
  ];

  const settled = await Promise.allSettled(checks.map((c) => c.run()));

  const failures: FraudCheckFailure[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'rejected') {
      failures.push({
        check: checks[i].name,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
    }
  });

  try {
    await checkCriticalFraudThreshold(supabase, guildId);
  } catch (err) {
    failures.push({
      check: 'critical_fraud_threshold',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (failures.length === 0) return;

  for (const failure of failures) {
    console.error('[License] Fraud check failed:', {
      guild_id: guildId,
      check: failure.check,
      error: failure.error,
    });
  }

  await raiseFraudCheckAlert(supabase, guildId, failures);
}

/**
 * Persist an operator-visible alert for fraud check failures.
 *
 * Mirrors the bot AlertManager dedupe pattern: at most one unresolved
 * `fraud_check_failure` alert per guild (refresh it if it already exists).
 * Additionally throttled in-memory so a sustained outage attempts at most
 * one alert write per guild per FRAUD_ALERT_MIN_INTERVAL_MS per instance.
 */
async function raiseFraudCheckAlert(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  failures: FraudCheckFailure[],
): Promise<void> {
  const now = Date.now();
  const last = fraudAlertLastAttempt.get(guildId);
  if (last !== undefined && now - last < FRAUD_ALERT_MIN_INTERVAL_MS) return;

  // Record the attempt up front so a failing alert write is throttled too,
  // and bound the map so it cannot grow without limit.
  if (fraudAlertLastAttempt.size >= FRAUD_ALERT_THROTTLE_MAX_ENTRIES && !fraudAlertLastAttempt.has(guildId)) {
    fraudAlertLastAttempt.clear();
  }
  fraudAlertLastAttempt.set(guildId, now);

  const failedChecks = failures.map((f) => f.check).join(', ');
  const message =
    `License validation fraud checks are failing (${failedChecks}). ` +
    'Fraud signals may not be recorded until this is resolved.';
  const metadata = { failures, source: 'license_validate' };

  try {
    // DB-side dedupe (same pattern as the bot's AlertManager): reuse the
    // existing unresolved alert for this guild instead of inserting a new row.
    const { data: existing, error: selectError } = await supabase
      .from('alerts')
      .select('id')
      .eq('guild_id', guildId)
      .eq('alert_type', FRAUD_ALERT_TYPE)
      .eq('resolved', false)
      .maybeSingle();

    if (selectError) {
      console.error('[License] Failed to look up existing fraud check alert:', selectError.message);
      return;
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('alerts')
        .update({ message, metadata, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (updateError) {
        console.error('[License] Failed to update fraud check alert:', updateError.message);
      }
      return;
    }

    const { error: insertError } = await supabase.from('alerts').insert({
      guild_id: guildId,
      alert_type: FRAUD_ALERT_TYPE,
      severity: 'critical',
      title: 'Fraud detection checks failing',
      message,
      metadata,
    });
    if (insertError) {
      console.error('[License] Failed to insert fraud check alert:', insertError.message);
    }
  } catch (err) {
    console.error('[License] Failed to write fraud check alert:', err instanceof Error ? err.message : err);
  }
}

async function checkDeviceAbuse(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  licenseKeyId: string,
  maxDevices: number,
  discordId: string | null,
): Promise<void> {
  const { count, error: countError } = await supabase
    .from('license_sessions')
    .select('*', { count: 'exact', head: true })
    .eq('license_key_id', licenseKeyId)
    .eq('active', true);

  if (countError) {
    throw new Error(`session count query failed: ${countError.message}`);
  }

  const activeDevices = count || 0;

  if (activeDevices > maxDevices * 3) {
    const { error: insertError } = await supabase.from('fraud_signals').insert({
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

    if (insertError) {
      throw new Error(`fraud signal insert failed: ${insertError.message}`);
    }
  }
}

async function checkIPMismatch(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  licenseKeyId: string,
  discordId: string | null,
): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: sessions, error: sessionsError } = await supabase
    .from('license_sessions')
    .select('ip_address')
    .eq('license_key_id', licenseKeyId)
    .gte('first_seen_at', since)
    .limit(1000);

  if (sessionsError) {
    throw new Error(`session IP query failed: ${sessionsError.message}`);
  }

  const uniqueIPs = new Set((sessions || []).map(s => s.ip_address).filter(Boolean));

  if (uniqueIPs.size >= 5) {
    const { error: insertError } = await supabase.from('fraud_signals').insert({
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

    if (insertError) {
      throw new Error(`fraud signal insert failed: ${insertError.message}`);
    }
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
  // Errors are thrown to the caller (runFraudChecks), which logs and alerts —
  // still fire-and-forget, so incident creation cannot break license validation.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { count, error: countError } = await supabase
    .from('fraud_signals')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildId)
    .eq('status', 'open')
    .eq('severity', 'critical')
    .gte('created_at', since);

  if (countError) {
    throw new Error(`fraud signal count query failed: ${countError.message}`);
  }

  if (!count || count < 3) return;

  // Check if we already created an incident for this burst
  const { data: existing, error: existingError } = await supabase
    .from('incidents')
    .select('id')
    .eq('guild_id', guildId)
    .eq('source', 'fraud_auto')
    .not('status', 'eq', 'resolved')
    .gte('created_at', since)
    .limit(1);

  if (existingError) {
    throw new Error(`incident lookup failed: ${existingError.message}`);
  }

  if (existing && existing.length > 0) return;

  const { data: seqVal, error: seqError } = await supabase.rpc('nextval_incident');
  if (seqError) {
    throw new Error(`nextval_incident RPC failed: ${seqError.message}`);
  }
  const nextNumber = typeof seqVal === 'number' ? seqVal : 1;

  const { data: incident, error: incidentError } = await supabase
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

  if (incidentError) {
    throw new Error(`incident insert failed: ${incidentError.message}`);
  }

  if (incident) {
    const { error: eventError } = await supabase.from('incident_events').insert({
      incident_id: incident.id,
      event_type: 'auto_created',
      actor_id: 'system:fraud',
      message: `${count} critical fraud signals detected in the last hour. Automatic incident created.`,
      metadata: { signal_count: count },
    });

    if (eventError) {
      throw new Error(`incident event insert failed: ${eventError.message}`);
    }
  }
}
