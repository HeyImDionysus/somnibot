/**
 * Licence API failure semantics — "we could not determine your licence status"
 * is a DIFFERENT outcome from "this licence is revoked".
 *
 * ## Why this file exists
 *
 * The licence endpoints used to collapse both cases into the same response
 * shape. `POST /api/license/validate` returned `{ valid: false, status:
 * 'revoked' }` when an RPC failed; `POST /api/license/heartbeat` destructured
 * only `{ data }` and reported `status: 'revoked'` whenever a query came back
 * empty — including when it came back empty *because it errored*. A one-second
 * database hiccup therefore told a paying customer their licence was revoked,
 * and (because the SDK treats `valid: false` as terminal) permanently stopped
 * their heartbeats until the app was restarted.
 *
 * ## The rule
 *
 * A response may only carry a *verdict* status (`revoked`, `expired`,
 * `suspended`, `over_device_limit`, `session_invalidated`, …) when the server
 * actually determined that verdict from data it successfully read.
 *
 * Anything else — a query error, an RPC error, a dependency being down — is a
 * SERVICE FAULT and must be reported with {@link LICENSE_STATUS_UNAVAILABLE}
 * and HTTP 503. The self-contained generated SDK protocol contract classifies
 * that status (plus `rate_limited`, any 5xx, and 429) as indeterminate: clients
 * keep a prior valid cache, continue heartbeats, and use the bounded offline
 * grace window. Keep server responses aligned with that generated contract.
 *
 * ## Fail-open vs fail-closed
 *
 * This makes the split explicit and chosen rather than accidental. A service
 * fault is fail-SOFT: we refuse to assert `valid: true` (we genuinely don't
 * know, and asserting validity would be a licence bypass), but we also refuse
 * to assert a revocation. The client's own 24h offline grace decides how long
 * a customer keeps working while we are broken — which is exactly the policy
 * already chosen for a network outage. The alternative, fail-closed, means our
 * downtime becomes our paying customers' downtime; breaking a paying
 * customer's working install is worse than the licence leak it would prevent.
 */
import { NextResponse } from 'next/server';

/**
 * Status reported when the licence state could not be determined.
 * NOT a verdict — the client must not treat it as a revocation.
 */
export const LICENSE_STATUS_UNAVAILABLE = 'service_unavailable';

/** Seconds a client should wait before retrying a service-fault response. */
export const LICENSE_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

/**
 * Standard 503 for "we could not determine the licence status".
 *
 * The real error message is logged server-side and never returned — Supabase
 * errors leak table/constraint/RPC names (V11 Re-Audit N-1).
 *
 * @param context  Route/operation identifier for the log line.
 * @param error    The underlying failure (anything with a `message`).
 * @param extra    Extra body fields, e.g. `next_heartbeat_seconds` for the
 *                 heartbeat endpoint's response shape.
 */
export function licenseUnavailable(
  context: string,
  error: { message: string } | null,
  extra: Record<string, unknown> = {},
): NextResponse {
  console.error(`[${context}] licence status undetermined:`, error?.message ?? 'unknown error');
  return NextResponse.json(
    {
      valid: false,
      status: LICENSE_STATUS_UNAVAILABLE,
      // Explicit machine-readable signal so clients that do not know the
      // status vocabulary still know not to degrade the customer.
      retryable: true,
      error:
        'License status could not be verified right now. This is a temporary server fault, '
        + 'not a problem with your license — please retry.',
      ...extra,
    },
    {
      status: 503,
      headers: { 'Retry-After': String(LICENSE_UNAVAILABLE_RETRY_AFTER_SECONDS) },
    },
  );
}
