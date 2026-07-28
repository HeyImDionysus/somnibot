/**
 * POST /api/license/heartbeat — Session keepalive.
 *
 * Architecture doc §30.9. Phase B: rate-limited.
 *
 * Every query below captures its `error`. A heartbeat that says
 * `valid: false` is TERMINAL for the SDK (it clears the cache and stops the
 * timer), so it may only ever be returned for a state we actually read. A
 * failed read returns 503 / `service_unavailable` instead — see
 * `@/lib/api/license-status` for the reasoning.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { rateLimits } from '@/lib/api/rate-limit';
import { parseBody, schemas } from '@/lib/api/validation';
import { licenseUnavailable } from '@/lib/api/license-status';
import { getClientIp } from '@/lib/api/client-ip';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Heartbeat responses always carry this field, so 503s must too. */
const HEARTBEAT_EXTRA = { next_heartbeat_seconds: 0 };

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();

  // ── B.5: Rate limit ──
  const clientIp = getClientIp(req);
  const ipLimit = await rateLimits.licenseHeartbeat(clientIp);
  if (ipLimit.limited) {
    return NextResponse.json(
      { valid: false, status: 'rate_limited', error: 'Too many requests' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(ipLimit.retryAfterMs / 1000)) },
      },
    );
  }

  const parsed = await parseBody(req, schemas.licenseSdk.heartbeat);
  if (!parsed.ok) return parsed.response;
  const { session_id, license_key } = parsed.data;

  if (!session_id || !license_key) {
    return NextResponse.json(
      { valid: false, status: 'session_invalidated', error: 'session_id and license_key are required' },
      { status: 400 },
    );
  }

  // Verify key. `maybeSingle` so "no such key" is data-null rather than an
  // error — which leaves `keyError` meaning exactly one thing: the read failed.
  const keyHash = sha256(license_key);
  const { data: licenseKey, error: keyError } = await supabase
    .from('license_keys')
    .select('id, status, product_id')
    .eq('key_hash', keyHash)
    .maybeSingle();

  if (keyError) {
    return licenseUnavailable('License/heartbeat key lookup', keyError, HEARTBEAT_EXTRA);
  }

  if (!licenseKey || licenseKey.status !== 'active') {
    return NextResponse.json({
      valid: false,
      status: licenseKey?.status ?? 'revoked',
      next_heartbeat_seconds: 0,
    });
  }

  // Check entitlement with bounded server-side selection. Fetching the whole
  // candidate set is unsafe even without an explicit `.limit()`: PostgREST can
  // cap response rows, which lets enough dead rows hide a valid one. An active
  // row always wins; otherwise choose the unexpired grace row with the latest
  // deadline. Every query returns at most one deterministic row.
  const { data: activeEntitlement, error: activeEntitlementError } = await supabase
    .from('entitlements')
    .select('id, status, grace_period_ends_at')
    .eq('license_key_id', licenseKey.id)
    .eq('status', 'active')
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (activeEntitlementError) {
    return licenseUnavailable(
      'License/heartbeat active entitlement lookup',
      activeEntitlementError,
      HEARTBEAT_EXTRA,
    );
  }

  let live = activeEntitlement;
  const heartbeatAt = new Date().toISOString();

  if (!live) {
    const { data: graceEntitlement, error: graceEntitlementError } = await supabase
      .from('entitlements')
      .select('id, status, grace_period_ends_at')
      .eq('license_key_id', licenseKey.id)
      .eq('status', 'grace_period')
      .gt('grace_period_ends_at', heartbeatAt)
      .order('grace_period_ends_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (graceEntitlementError) {
      return licenseUnavailable(
        'License/heartbeat grace entitlement lookup',
        graceEntitlementError,
        HEARTBEAT_EXTRA,
      );
    }
    live = graceEntitlement;
  }

  if (!live) {
    // No live row exists. A bounded grace lookup distinguishes a lapsed
    // payment window from other recorded states; otherwise report the most
    // recently updated non-live status with an id tie-breaker.
    const { data: lapsedGrace, error: lapsedGraceError } = await supabase
      .from('entitlements')
      .select('id, status')
      .eq('license_key_id', licenseKey.id)
      .eq('status', 'grace_period')
      .order('grace_period_ends_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (lapsedGraceError) {
      return licenseUnavailable(
        'License/heartbeat lapsed grace lookup',
        lapsedGraceError,
        HEARTBEAT_EXTRA,
      );
    }

    let recordedStatus: string | null = null;
    if (!lapsedGrace) {
      const { data: recordedEntitlement, error: recordedEntitlementError } = await supabase
        .from('entitlements')
        .select('id, status')
        .eq('license_key_id', licenseKey.id)
        .neq('status', 'active')
        .neq('status', 'grace_period')
        .order('updated_at', { ascending: false })
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (recordedEntitlementError) {
        return licenseUnavailable(
          'License/heartbeat recorded entitlement lookup',
          recordedEntitlementError,
          HEARTBEAT_EXTRA,
        );
      }
      recordedStatus = recordedEntitlement?.status ?? null;
    }

    return NextResponse.json({
      valid: false,
      status: lapsedGrace ? 'expired' : (recordedStatus ?? 'revoked'),
      next_heartbeat_seconds: 0,
    });
  }

  // Update session last_seen_at
  const { data: session, error: sessionError } = await supabase
    .from('license_sessions')
    .select('id, active')
    .eq('id', session_id)
    .eq('license_key_id', licenseKey.id)
    .maybeSingle();

  if (sessionError) {
    return licenseUnavailable('License/heartbeat session lookup', sessionError, HEARTBEAT_EXTRA);
  }

  if (!session || !session.active) {
    return NextResponse.json({
      valid: false,
      status: 'session_invalidated',
      next_heartbeat_seconds: 0,
    });
  }

  // The whole point of a heartbeat is to record liveness. If the write fails
  // the session did NOT stay alive — the reaper will time it out — so report
  // the fault rather than a false "all good" the client would trust.
  const { error: touchError } = await supabase
    .from('license_sessions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', session_id);

  if (touchError) {
    return licenseUnavailable('License/heartbeat session touch', touchError, HEARTBEAT_EXTRA);
  }

  // Get heartbeat interval from config. Non-fatal: a missing/unreadable config
  // only costs us the tuned interval, and the 300s default is safe.
  const { data: config, error: configError } = await supabase
    .from('product_license_config')
    .select('heartbeat_interval_seconds')
    .eq('product_id', licenseKey.product_id)
    .maybeSingle();

  if (configError) {
    console.error('[License/heartbeat] config lookup failed (using default interval):', configError.message);
  }

  // W2 codex round 3: an entitlement can enter grace AFTER the initial
  // validation (payment fails mid-session). The lapsed-deadline branch above
  // already rejects an EXPIRED grace window; here the window is still open, so
  // the session stays valid — but surface `grace_period` (and the deadline)
  // instead of masking it as 'active'. Apps that monitor license health via
  // heartbeats would otherwise never see the payment-failure warning until a
  // separate validation happened.
  const inGracePeriod = live.status === 'grace_period';
  return NextResponse.json({
    valid: true,
    status: inGracePeriod ? 'grace_period' : 'active',
    grace_period_ends_at: inGracePeriod ? live.grace_period_ends_at : null,
    next_heartbeat_seconds: config?.heartbeat_interval_seconds ?? 300,
  });
}
