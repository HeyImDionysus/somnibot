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

const HEARTBEAT_ENTITLEMENT_STATUSES = new Set([
  'active',
  'grace_period',
  'pending_activation',
  'expired',
  'suspended',
  'cancelled',
  'pending',
  'revoked',
  'session_invalidated',
]);

type HeartbeatEntitlementDecision = {
  status: string;
  grace_period_ends_at: string | null;
  decided_at: string;
  candidate_count: number;
  session_touched: boolean;
  next_heartbeat_seconds: number;
};

function isHeartbeatEntitlementDecision(
  value: unknown,
): value is HeartbeatEntitlementDecision {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.status === 'string'
    && HEARTBEAT_ENTITLEMENT_STATUSES.has(candidate.status)
    && (
      candidate.grace_period_ends_at === null
      || typeof candidate.grace_period_ends_at === 'string'
    )
    && typeof candidate.decided_at === 'string'
    && typeof candidate.candidate_count === 'number'
    && Number.isInteger(candidate.candidate_count)
    && candidate.candidate_count >= 0
    && typeof candidate.session_touched === 'boolean'
    && typeof candidate.next_heartbeat_seconds === 'number'
    && Number.isInteger(candidate.next_heartbeat_seconds)
    && candidate.next_heartbeat_seconds >= 0
  );
}

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

  // Authenticate the presented hash inside the same statement that makes the
  // entitlement/session decision. Resolving an id first would let key rotation
  // change key_hash between statements while the stale presented key remained
  // authenticated by that id.
  const keyHash = sha256(license_key);
  // Decide key + entitlement precedence and conditionally touch the session in
  // one database statement.
  // Separate active/grace/fallback reads can tear when payment recovery changes
  // a row from grace_period to active between requests. Likewise, a separate
  // session SELECT then UPDATE can touch a row deactivated in between. The RPC
  // locks the decision rows, conditionally updates only an active session, and
  // owns the decision clock.
  const {
    data: entitlementDecision,
    error: entitlementDecisionError,
  } = await supabase.rpc('license_heartbeat_decision', {
    p_key_hash: keyHash,
    p_session_id: session_id,
  });

  if (entitlementDecisionError) {
    return licenseUnavailable(
      'License/heartbeat entitlement decision',
      entitlementDecisionError,
      HEARTBEAT_EXTRA,
    );
  }

  // A successful PostgREST call with an unexpected payload is still not a
  // licence verdict. Fail soft instead of turning malformed/missing RPC output
  // into a terminal revocation.
  if (!isHeartbeatEntitlementDecision(entitlementDecision)) {
    return licenseUnavailable(
      'License/heartbeat entitlement decision',
      { message: 'RPC returned an invalid entitlement decision payload' },
      HEARTBEAT_EXTRA,
    );
  }

  const liveDecision = (
    entitlementDecision.status === 'active'
    || entitlementDecision.status === 'grace_period'
  );
  if (
    liveDecision !== entitlementDecision.session_touched
    || (
      entitlementDecision.status === 'grace_period'
      && entitlementDecision.grace_period_ends_at === null
    )
  ) {
    return licenseUnavailable(
      'License/heartbeat entitlement decision',
      { message: 'RPC returned an inconsistent entitlement/session decision' },
      HEARTBEAT_EXTRA,
    );
  }

  if (
    !liveDecision
  ) {
    return NextResponse.json({
      valid: false,
      status: entitlementDecision.status,
      next_heartbeat_seconds: 0,
    });
  }

  // An entitlement can enter grace after initial validation. The RPC already
  // rejected a strictly lapsed window and atomically touched this active
  // session; surface the still-live grace state instead of masking it as active.
  const inGracePeriod = entitlementDecision.status === 'grace_period';
  return NextResponse.json({
    valid: true,
    status: inGracePeriod ? 'grace_period' : 'active',
    grace_period_ends_at: inGracePeriod
      ? entitlementDecision.grace_period_ends_at
      : null,
    next_heartbeat_seconds: entitlementDecision.next_heartbeat_seconds,
  });
}
