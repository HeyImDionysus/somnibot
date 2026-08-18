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
import { licenseUnavailable } from '@/lib/api/license-status';
import { getClientIp } from '@/lib/api/client-ip';
import { writeCommerceAudit } from '@/lib/commerce-audit';
import type { SupabaseClient } from '@supabase/supabase-js';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

type LicenseUnavailableAudit = {
  readonly productId: string;
  readonly keyHash: string;
  readonly cause:
    | 'authoritative_lookup_failed'
    | 'membership_lookup_failed'
    | 'device_session_failed';
  readonly guildId?: string;
};

async function auditLicenseUnavailable(
  supabase: SupabaseClient,
  outage: LicenseUnavailableAudit,
): Promise<void> {
  let guildId = outage.guildId;
  if (!guildId) {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('guild_id')
        .eq('id', outage.productId)
        .maybeSingle();
      if (error || !data?.guild_id) return;
      guildId = data.guild_id;
    } catch (error) {
      console.error(
        '[License] Failed to resolve guild for unavailable validation audit:',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
  }
  if (!guildId) return;

  const outageWindow = Math.floor(Date.now() / 60_000);
  const occurrence = sha256(`${outage.cause}:${outage.keyHash}:${outageWindow}`).slice(0, 24);
  await writeCommerceAudit(supabase, {
    guildId,
    actorType: 'system',
    actorId: 'license-validator',
    action: 'license.validate_unavailable',
    targetType: 'product',
    targetId: outage.productId,
    details: { cause: outage.cause },
    occurrenceKey: `license.validate_unavailable:${outage.cause}:${occurrence}`,
    success: false,
  });
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
  entitlement_grace_period_ends_at?: string | null;
  config_max_devices?: number;
  config_device_policy?: string;
  config_feature_flags?: string[];
  config_tier?: string;
  config_heartbeat_interval_seconds?: number;
  config_sdk_cache_ttl_ms?: number;
  config_offline_grace_period_seconds?: number;
  config_require_discord_guild_membership?: boolean;
  config_license_mode?: string;
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
    // The lookup FAILED — we learned nothing about this key. Reporting
    // 'revoked' here (the old behaviour) told a paying customer their licence
    // was cancelled because our database blinked, and the SDK treated that as
    // terminal. Report it as undetermined instead: HTTP 503 +
    // status 'service_unavailable', which the SDK handles non-terminally.
    await logValidation(supabase, null, product_id, device_fingerprint, 'unavailable', clientIp, app_version);
    await auditLicenseUnavailable(supabase, {
      productId: product_id,
      keyHash,
      cause: 'authoritative_lookup_failed',
    });
    return licenseUnavailable('License/validate license_validate_lookup', lookupError);
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

  // Membership is a live entitlement prerequisite when the owner enables it.
  // The members table is the bot's durable Discord roster snapshot; only an
  // active row satisfies the check, so a departed member cannot keep a key
  // alive indefinitely.
  if (
    result.config_require_discord_guild_membership === true
    && result.product_guild_id
    && result.customer_discord_id
  ) {
    const { data: member, error: memberError } = await supabase
      .from('members')
      .select('discord_id')
      .eq('guild_id', result.product_guild_id)
      .eq('discord_id', result.customer_discord_id)
      .is('left_at', null)
      .maybeSingle();
    if (memberError) {
      await logValidation(supabase, result.key_id!, product_id, device_fingerprint, 'unavailable', clientIp, app_version);
      await auditLicenseUnavailable(supabase, {
        productId: product_id,
        keyHash,
        cause: 'membership_lookup_failed',
        guildId: result.product_guild_id,
      });
      return licenseUnavailable('License/validate guild membership', memberError);
    }
    if (!member) {
      await logValidation(supabase, result.key_id!, product_id, device_fingerprint, 'guild_membership_required', clientIp, app_version);
      return NextResponse.json({
        valid: false,
        status: 'guild_membership_required',
        error: 'Join the product Discord server before using this license.',
      });
    }
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

  // 4.5. Grace-period lifecycle (W2): compute the grace window at validation
  // time — never trust a stale `grace_period` status. Reconciliation runs
  // every 6 hours, so a lapsed-but-unreconciled row would otherwise keep
  // validating (and keep a churned customer's app running) until the next
  // sweep. The route only REJECTS: the reconciliation job owns the status
  // transition (audit trail + role revocation), so the row is left in
  // grace_period for it to find.
  const inGracePeriod = result.entitlement_status === 'grace_period';
  const graceEndsAt = result.entitlement_grace_period_ends_at ?? null;
  if (inGracePeriod && graceEndsAt && new Date(graceEndsAt) < new Date()) {
    await logValidation(supabase, result.key_id!, product_id, device_fingerprint, 'expired', clientIp, app_version);
    return NextResponse.json({
      valid: false,
      status: 'expired',
      error: 'Payment grace period has ended',
      grace_period_ends_at: graceEndsAt,
    });
  }

  // 5. Check expiry
  if (result.entitlement_expires_at && new Date(result.entitlement_expires_at) < new Date()) {
    const expiredAt = new Date().toISOString();
    await supabase
      .from('entitlements')
      .update({ status: 'expired', updated_at: expiredAt })
      .eq('id', result.entitlement_id);

    // W2 codex round 2: an entitlement can natural-expire (expires_at past)
    // while still in a payment-failure grace window whose deadline has NOT yet
    // lapsed (so the grace check above did not fire) — this terminal 'expired'
    // write strands the open 'entitlement_grace_period' operator alert that
    // revoke()/reconciliation would otherwise resolve. Resolve it with the same
    // entitlement-scoped filter (a no-op when none is open). Non-fatal: the
    // expiry write above has already committed.
    if (result.entitlement_status === 'grace_period' && result.product_guild_id) {
      const { error: graceAlertError } = await supabase
        .from('alerts')
        .update({ resolved: true, resolved_at: expiredAt, updated_at: expiredAt })
        .eq('guild_id', result.product_guild_id)
        .eq('alert_type', 'entitlement_grace_period')
        .eq('metadata->>entitlement_id', result.entitlement_id)
        .eq('resolved', false);
      if (graceAlertError) {
        console.error('[License] Failed to resolve grace-period alert on validation expiry:', graceAlertError.message);
      }
    }

    await logValidation(supabase, result.key_id!, product_id, device_fingerprint, 'expired', clientIp, app_version);
    return NextResponse.json({ valid: false, status: 'expired', error: 'License has expired' });
  }

  // 6. Multi-device tracking (atomic RPC stays separate — needs FOR UPDATE)
  //
  // On the `evict_oldest` default (product_license_config.device_policy, set in
  // 20260518000101): it does not REFUSE anyone, so a share group is never told
  // "no" — each validation evicts the least-recently-seen session and takes its
  // place. It is kept as the default deliberately:
  //
  //   * `reject` hard-blocks a customer who reimaged their machine or replaced
  //     a laptop until they find the portal and free a seat by hand. Breaking a
  //     paying customer's working install is worse than the leak.
  //   * Since the seat layer actually works again (Finding 3), eviction is real
  //     friction on sharers rather than a no-op: every extra person kicks
  //     someone else off mid-session, and it is self-limiting in a way that
  //     costs an honest customer nothing.
  //   * The leak is no longer invisible — the device-abuse signal below now
  //     fires under this policy — so the owner can flip individual products to
  //     `reject` from the licence config with evidence in hand.
  //
  // Changing the column default would apply to new products only, but the
  // recommendation is to keep it: switch specific products to `reject` when a
  // signal says so.
  let sessionId: string | undefined;
  const seatTrackingEnabled =
    typeof result.config_max_devices === 'number' && result.config_max_devices > 0;

  // Seat enforcement cannot be optional at the caller's discretion. Products
  // with tracking disabled remain compatible with fingerprint-less clients,
  // but a tracked product must fail closed instead of granting a seatless,
  // heartbeat-less validation.
  if (seatTrackingEnabled && !device_fingerprint) {
    await logValidation(
      supabase,
      result.key_id!,
      product_id,
      device_fingerprint,
      'device_fingerprint_required',
      clientIp,
      app_version,
    );
    return NextResponse.json(
      {
        valid: false,
        status: 'device_fingerprint_required',
        error: 'A non-empty device fingerprint is required for this product.',
      },
      { status: 400 },
    );
  }

  if (device_fingerprint && seatTrackingEnabled) {
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

    // A device fingerprint was supplied and the product is seat-limited, so a
    // session is REQUIRED for this validation to mean anything. Failing to
    // establish one used to be logged and swallowed, and execution fell
    // through to `valid: true, session_id: null` — a machine that validated as
    // healthy while consuming zero seats and never heartbeating again.
    //
    // We cannot answer `valid: true` (we did not grant a seat) and we must not
    // answer with a verdict (the licence itself is fine). Report it as
    // undetermined, which the SDK handles non-terminally: an install with a
    // cached validation keeps working on offline grace while we recover.
    if (deviceError) {
      await logValidation(supabase, result.key_id!, product_id, device_fingerprint, 'unavailable', clientIp, app_version);
      await auditLicenseUnavailable(supabase, {
        productId: product_id,
        keyHash,
        cause: 'device_session_failed',
        guildId: result.product_guild_id,
      });
      return licenseUnavailable('License/validate license_validate_device', deviceError);
    }

    // A remotely revoked fingerprint is a real terminal device verdict, not a
    // service fault and not a revocation of the licence key itself. Handle it
    // before the generic no-session guard so the SDK stops this device instead
    // of retrying a 503 forever.
    if (deviceResult?.status === 'session_invalidated') {
      await logValidation(
        supabase,
        result.key_id!,
        product_id,
        device_fingerprint,
        'session_invalidated',
        clientIp,
        app_version,
      );
      return NextResponse.json({
        valid: false,
        status: 'session_invalidated',
        error: 'This device was revoked by an administrator. Contact the server owner if you need it restored.',
      });
    }

    // Defence in depth against the same class of bug: the RPC answered, but
    // with no session id and no recognised status. Treat "no seat granted" as
    // a failure to validate rather than silently issuing a seatless success.
    if (!deviceResult?.session_id && deviceResult?.status !== 'over_device_limit') {
      await logValidation(supabase, result.key_id!, product_id, device_fingerprint, 'unavailable', clientIp, app_version);
      await auditLicenseUnavailable(supabase, {
        productId: product_id,
        keyHash,
        cause: 'device_session_failed',
        guildId: result.product_guild_id,
      });
      return licenseUnavailable(
        'License/validate license_validate_device',
        { message: `RPC returned no session (status=${String(deviceResult?.status ?? 'null')})` },
      );
    }

    if (deviceResult?.status === 'over_device_limit') {
      await logValidation(supabase, result.key_id!, product_id, device_fingerprint, 'over_device_limit', clientIp, app_version);
      return NextResponse.json({
        valid: false,
        status: 'over_device_limit',
        error: `Maximum ${result.config_max_devices || 3} devices reached. Deactivate an existing device first.`,
        active_devices: deviceResult.active_devices,
        max_devices: deviceResult.max_devices,
      });
    }

    // Guaranteed non-null by the guard above.
    sessionId = deviceResult.session_id;
  }

  // Fraud checks (non-blocking — fire-and-forget)
  // V11 Audit M-8: Also check critical fraud signal threshold after device/IP checks
  // so accumulated signals auto-create incidents.
  if (device_fingerprint && seatTrackingEnabled && result.product_guild_id) {
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
    // W2: surface a decaying entitlement instead of masking it as healthy —
    // the SDK (and the paying customer's app) can warn that payment failed
    // and access ends at grace_period_ends_at.
    status: inGracePeriod ? 'grace_period' : 'active',
    entitlement_id: result.entitlement_id,
    features: result.config_feature_flags ?? [],
    tier: result.config_tier ?? null,
    customer_discord_id: result.customer_discord_id,
    customer_name: result.customer_discord_username,
    expires_at: result.entitlement_expires_at,
    grace_period_ends_at: inGracePeriod ? graceEndsAt : null,
    session_id: sessionId ?? null,
    heartbeat_interval_seconds: result.config_heartbeat_interval_seconds ?? 0,
    sdk_cache_ttl_ms: result.config_sdk_cache_ttl_ms ?? 60000,
    offline_grace_period_seconds: result.config_offline_grace_period_seconds ?? 86400,
    require_discord_guild_membership: result.config_require_discord_guild_membership ?? true,
    license_mode: result.config_license_mode ?? 'portal_only',
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
 * The alert row itself is deduped atomically in the DB (partial unique
 * index: one unresolved row per guild); this throttle only keeps a
 * sustained outage from adding alert-write DB load on every validation.
 */
const FRAUD_ALERT_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Bounded per-instance throttle: guild_id → last alert write attempt (epoch ms). */
const FRAUD_ALERT_THROTTLE_MAX_ENTRIES = 1000;
const fraudAlertLastAttempt = new Map<string, number>();

interface FraudCheckFailure {
  check: string;
  error: string;
}

const LICENSE_FRAUD_DEFAULTS = {
  deviceAbuseMultiplier: 3,
  ipMismatchThreshold: 5,
  criticalIncidentThreshold: 3,
};

async function loadLicenseFraudThresholds(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
): Promise<typeof LICENSE_FRAUD_DEFAULTS> {
  const result = { ...LICENSE_FRAUD_DEFAULTS };
  try {
    const { data } = await supabase
      .from('fraud_rules')
      .select('rule_type, config, enabled')
      .eq('guild_id', guildId)
      .eq('enabled', true)
      .limit(100);
    for (const rule of data ?? []) {
      const value = Number((rule.config as Record<string, unknown> | null)?.threshold);
      if (!Number.isInteger(value) || value <= 0) continue;
      if (rule.rule_type === 'device_limit' && value >= 2 && value <= 10) result.deviceAbuseMultiplier = value;
      if (rule.rule_type === 'ip_mismatch' && value >= 2 && value <= 100) result.ipMismatchThreshold = value;
      if (rule.rule_type === 'critical_incident' && value >= 1 && value <= 50) result.criticalIncidentThreshold = value;
    }
  } catch {
    // Fraud checks are advisory and never block license validation.
  }
  return result;
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
  const thresholds = await loadLicenseFraudThresholds(supabase, guildId);
  const checks = [
    { name: 'device_abuse', run: () => checkDeviceAbuse(supabase, guildId, licenseKeyId, maxDevices, discordId, thresholds.deviceAbuseMultiplier) },
    { name: 'ip_mismatch', run: () => checkIPMismatch(supabase, guildId, licenseKeyId, discordId, thresholds.ipMismatchThreshold) },
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
    await checkCriticalFraudThreshold(supabase, guildId, thresholds.criticalIncidentThreshold);
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
 * At most one unresolved `fraud_check_failure` alert per guild. The dedupe
 * is atomic at the database via the partial unique index
 * `uniq_alerts_unresolved_fraud_check_failure` (guild_id WHERE alert_type =
 * 'fraud_check_failure' AND resolved = false): an existing alert is
 * refreshed in place with a single UPDATE, otherwise we INSERT and treat a
 * 23505 unique violation as "another instance already raised it" — so
 * concurrent instances during the same outage cannot create duplicates.
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
    // Refresh the existing unresolved alert in place — a single atomic
    // UPDATE, no read-then-write window.
    const { data: refreshed, error: updateError } = await supabase
      .from('alerts')
      .update({ message, metadata, updated_at: new Date().toISOString() })
      .eq('guild_id', guildId)
      .eq('alert_type', FRAUD_ALERT_TYPE)
      .eq('resolved', false)
      .select('id');

    if (updateError) {
      console.error('[License] Failed to refresh fraud check alert:', updateError.message);
      return;
    }
    if (refreshed && refreshed.length > 0) return;

    // No unresolved alert yet — insert one. The partial unique index
    // `uniq_alerts_unresolved_fraud_check_failure` makes the dedupe atomic
    // across instances: if another instance raced us past the UPDATE above,
    // exactly one INSERT commits and the loser sees a 23505 unique
    // violation, which means the alert exists — success, not an error.
    const { error: insertError } = await supabase.from('alerts').insert({
      guild_id: guildId,
      alert_type: FRAUD_ALERT_TYPE,
      severity: 'critical',
      title: 'Fraud detection checks failing',
      message,
      metadata,
    });
    if (insertError && insertError.code !== '23505') {
      console.error('[License] Failed to insert fraud check alert:', insertError.message);
    }
  } catch (err) {
    console.error('[License] Failed to write fraud check alert:', err instanceof Error ? err.message : err);
  }
}

/**
 * Rolling window for the device-abuse signal.
 *
 * A week, not a day: a sharing group does not have to be online on the same
 * day for the key to be serving all of them, and "how many distinct machines
 * does this key serve" is naturally a weekly question. The IP check below uses
 * 24h because a burst of IPs in one day is itself the anomaly there.
 */
const DEVICE_ABUSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Distinct devices in the window, as a multiple of max_devices, that trips the signal. */
const DEVICE_ABUSE_HIGH_RATIO = 3;
const DEVICE_ABUSE_CRITICAL_RATIO = 5;

/** Bound on rows read per check. A key over this is far past any threshold. */
const DEVICE_ABUSE_ROW_CAP = 1000;

interface OpenFraudSignal {
  guildId: string;
  signalType: 'device_abuse' | 'ip_mismatch';
  severity: 'medium' | 'high' | 'critical';
  entityType: 'license_key';
  entityId: string;
  discordId: string | null;
  description: string;
  evidence: Record<string, unknown>;
}

/**
 * Persist one open signal per entity through the partial-index-aware RPC.
 *
 * PostgREST's column-only `upsert` cannot express
 * `ON CONFLICT (...) WHERE status = 'open'`; the database function is the
 * atomic boundary that refreshes evidence and preserves monotonic severity.
 */
async function upsertOpenFraudSignal(
  supabase: ReturnType<typeof createAdminSupabase>,
  signal: OpenFraudSignal,
): Promise<void> {
  const { error } = await supabase.rpc('fraud_upsert_open_signal', {
    p_guild_id: signal.guildId,
    p_signal_type: signal.signalType,
    p_severity: signal.severity,
    p_entity_type: signal.entityType,
    p_entity_id: signal.entityId,
    p_discord_id: signal.discordId,
    p_description: signal.description,
    p_evidence: signal.evidence,
    p_auto_action: null,
  });

  if (error) {
    throw new Error(`fraud signal upsert failed: ${error.message}`);
  }
}

/**
 * Device-sharing signal.
 *
 * ## Why this does not count active sessions
 *
 * It used to fire on `activeDevices > maxDevices * 3` — which is mathematically
 * unreachable in the default configuration. Under `evict_oldest` (the schema
 * default) every new device evicts the least-recently-seen one, so the active
 * count is *pinned at* `max_devices` by construction; it can never reach three
 * times it. Under `reject` the RPC refuses past the limit, so it is pinned
 * there too. The signal could only ever have fired on legacy or
 * hand-inserted rows. Ten people sharing one 3-seat key produced exactly the
 * same active count as one honest customer with three machines.
 *
 * ## What it counts instead
 *
 * Distinct DEVICES that used the key inside the window, whether or not they
 * currently hold a seat. Eviction pins the seat count; it does not pin the
 * number of machines, which is the thing we actually care about. A row in
 * `license_sessions` is one device — `UNIQUE(license_key_id,
 * device_fingerprint)` guarantees it — so the row count in the window *is* the
 * distinct-device count, with no DISTINCT and no aggregation.
 *
 * (Eviction *rate* was the other candidate. It is worse here: a device's
 * `deactivation_reason` is cleared when it reclaims its row, so churn
 * systematically undercounts exactly the keys that churn hardest. It is
 * reported as supporting evidence, not used as the trigger.)
 *
 * ## Thresholds
 *
 * `> max_devices * 3` distinct machines in seven days. Honest churn — a
 * reinstall, a new laptop, a re-imaged machine — moves this by one or two, so
 * a 3-seat licence has to reach ten distinct machines before it trips. The
 * cost of a false positive is low by design: fraud signals are advisory, they
 * open an operator alert and never refuse a validation, so a customer with an
 * unstable fingerprint is reviewed, not locked out.
 */
async function checkDeviceAbuse(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  licenseKeyId: string,
  maxDevices: number,
  discordId: string | null,
  multiplier = DEVICE_ABUSE_HIGH_RATIO,
): Promise<void> {
  const since = new Date(Date.now() - DEVICE_ABUSE_WINDOW_MS).toISOString();

  // One read serves every number below — cheaper than the head-count it
  // replaces plus the counts the evidence needs.
  const { data: sessions, error: sessionsError } = await supabase
    .from('license_sessions')
    .select('active, last_seen_at, deactivation_reason')
    .eq('license_key_id', licenseKeyId)
    .gte('last_seen_at', since)
    .limit(DEVICE_ABUSE_ROW_CAP);

  if (sessionsError) {
    throw new Error(`session window query failed: ${sessionsError.message}`);
  }

  const rows = sessions ?? [];
  const devicesInWindow = rows.length;
  const activeDevices = rows.filter((s) => s.active).length;
  const evictedInWindow = rows.filter((s) => s.deactivation_reason === 'device_limit').length;

  if (devicesInWindow <= maxDevices * multiplier) return;

  const windowDays = Math.round(DEVICE_ABUSE_WINDOW_MS / (24 * 60 * 60 * 1000));
  await upsertOpenFraudSignal(supabase, {
    guildId,
    signalType: 'device_abuse',
    severity: devicesInWindow > maxDevices * (multiplier + 2) ? 'critical' : 'high',
    entityType: 'license_key',
    entityId: licenseKeyId,
    discordId,
    description:
      `${devicesInWindow} distinct devices used a ${maxDevices}-device license in the last ${windowDays} days`,
    evidence: {
      devices_in_window: devicesInWindow,
      window_days: windowDays,
      max_devices: maxDevices,
      multiplier,
      ratio: devicesInWindow / maxDevices,
      // Context for the operator: under evict_oldest `active_sessions` is
      // pinned at max_devices, so a high device count with a pinned seat count
      // and a non-zero eviction count is the signature of seat thrashing.
      active_sessions: activeDevices,
      evicted_for_device_limit: evictedInWindow,
      truncated: devicesInWindow >= DEVICE_ABUSE_ROW_CAP,
    },
  });
}

async function checkIPMismatch(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  licenseKeyId: string,
  discordId: string | null,
  threshold = 5,
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

  if (uniqueIPs.size >= threshold) {
    await upsertOpenFraudSignal(supabase, {
      guildId,
      signalType: 'ip_mismatch',
      severity: uniqueIPs.size >= threshold * 2 ? 'critical' : 'medium',
      entityType: 'license_key',
      entityId: licenseKeyId,
      discordId,
      description: `${uniqueIPs.size} unique IPs in the last 24 hours`,
      evidence: { unique_ips: uniqueIPs.size, threshold, window_hours: 24 },
    });
  }
}

/**
 * V11 Audit M-8: Auto-create an incident when ≥ 3 critical fraud signals were
 * observed or refreshed within the last hour for a guild.
 *
 * Mirror of the bot's `checkCriticalThreshold` — runs in the dashboard
 * context (no event bus) after license validation fraud checks.
 */
async function checkCriticalFraudThreshold(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  threshold = 3,
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
    .gte('last_observed_at', since);

  if (countError) {
    throw new Error(`fraud signal count query failed: ${countError.message}`);
  }

  if (!count || count < threshold) return;

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
