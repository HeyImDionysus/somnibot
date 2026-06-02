/**
 * CSRF Protection — Per-session token generation and verification.
 *
 * V53 Phase 1.8
 *
 * Architecture:
 * 1. GET /api/csrf → returns a fresh CSRF token (also set as HttpOnly cookie)
 * 2. All mutating requests (POST, PUT, PATCH, DELETE) must include
 *    the token in the `X-CSRF-Token` header
 * 3. The middleware verifies the header matches the cookie
 *
 * The token is derived from the session + a server secret using HMAC,
 * so it's tied to the user's session and can't be forged.
 *
 * Local-mode (Electron launcher) is exempt since it's bound to localhost.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const CSRF_COOKIE_NAME = 'somnibot-csrf-token';
/**
 * V10 Audit §5: Previous CSRF nonce cookie for grace-period acceptance.
 * When the token rotates, the client's in-memory header still holds the old
 * token for 1-2 seconds. This cookie allows the old token to remain valid
 * for up to CSRF_GRACE_PERIOD_MS after rotation.
 */
const CSRF_PREV_COOKIE_NAME = 'somnibot-csrf-prev';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_GRACE_PERIOD_MS = 60_000; // 60 seconds

/**
 * V7 Audit §1.P3a — Centralized CSRF exempt route prefixes.
 *
 * Routes listed here skip CSRF verification on mutating requests because
 * they use an alternative authentication mechanism:
 * - paypal/webhook  → PayPal API signature verification
 * - license/*       → API-key + per-key rate limiting
 * - portal/*        → Portal session token auth
 * - auth/*          → OAuth provider callback (state param)
 * - downloads/*     → HMAC-signed URL + single-use nonce
 * - csrf            → GET-only token issuance
 *
 * V6 Audit §1.1: /api/setup intentionally NOT exempt (uses parseBody + Supabase auth).
 */
const CSRF_EXEMPT_PREFIXES: readonly string[] = [
  '/api/paypal/webhook',
  '/api/license/',
  '/api/portal/',
  '/api/auth/',
  '/api/downloads/',
  '/api/csrf',
] as const;

/** Secret used to sign CSRF tokens. Fails closed — refuses to serve without an explicit secret. */
let _csrfSecret: string | undefined;
function getCsrfSecret(): string {
  if (_csrfSecret) return _csrfSecret;
  const secret = process.env.CSRF_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      'Missing CSRF_SECRET (or NEXTAUTH_SECRET fallback). ' +
      'Refusing to operate with unpredictable per-process CSRF keys that break across restarts/replicas.',
    );
  }
  _csrfSecret = secret;
  return secret;
}

/**
 * Generate a CSRF token tied to a session identifier.
 * The token is an HMAC of a random nonce + the session ID.
 */
export function generateCsrfToken(sessionId: string): { token: string; nonce: string } {
  const nonce = randomBytes(16).toString('hex');
  const token = createHmac('sha256', getCsrfSecret())
    .update(`${nonce}:${sessionId}`)
    .digest('hex');
  return { token, nonce };
}

/**
 * Verify a CSRF token against the stored nonce and session.
 */
export function verifyCsrfToken(
  token: string,
  nonce: string,
  sessionId: string,
): boolean {
  const expected = createHmac('sha256', getCsrfSecret())
    .update(`${nonce}:${sessionId}`)
    .digest('hex');

  // Constant-time comparison — V6 Audit §9.8: direct import, no try/catch fallback
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

/**
 * Check CSRF token on a mutating request.
 * Returns null if valid, or a NextResponse error if invalid.
 *
 * Exemptions:
 * - Local-mode (SESSION_TOKEN env is set + localhost)
 * - Webhook routes (/api/paypal/webhook, /api/license/*)
 * - Portal routes (use their own token auth)
 * - GET/HEAD/OPTIONS requests
 */
export function checkCsrf(request: NextRequest): NextResponse | null {
  const method = request.method.toUpperCase();

  // Only check mutating methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;

  // Skip local-mode (Electron launcher — bound to localhost)
  const sessionToken = process.env.SESSION_TOKEN;
  if (sessionToken) {
    const host = request.headers.get('host') ?? '';
    const isLocalhost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(host);
    if (isLocalhost) return null;
  }

  // Skip exempt routes — centralized list for easy auditing.
  // V7 Audit §1.P3a: Moved from inline array to module-level constant.
  const path = request.nextUrl.pathname;
  if (CSRF_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;

  // Get token from header
  const headerToken = request.headers.get(CSRF_HEADER_NAME);
  if (!headerToken) {
    return NextResponse.json(
      { error: 'Missing CSRF token' },
      { status: 403 },
    );
  }

  // Get nonce + session from cookie
  const csrfCookie = request.cookies.get(CSRF_COOKIE_NAME)?.value;
  if (!csrfCookie) {
    return NextResponse.json(
      { error: 'CSRF session expired — please refresh the page' },
      { status: 403 },
    );
  }

  // Cookie format: nonce:sessionId or nonce:sessionId!timestamp (V5 Audit §1.P3b)
  const colonIdx = csrfCookie.indexOf(':');
  if (colonIdx === -1) {
    return NextResponse.json(
      { error: 'Invalid CSRF cookie' },
      { status: 403 },
    );
  }

  const nonce = csrfCookie.slice(0, colonIdx);
  // Strip optional !timestamp suffix added by V5 Audit §1.P3b rotation
  const rest = csrfCookie.slice(colonIdx + 1);
  const bangIdx = rest.lastIndexOf('!');
  const sessionId = bangIdx === -1 ? rest : rest.slice(0, bangIdx);

  if (!verifyCsrfToken(headerToken, nonce, sessionId)) {
    // V10 Audit §5: Try previous token during rotation grace period.
    // When the middleware rotates the CSRF cookie, the client's in-memory
    // X-CSRF-Token header still holds the old token. Accept the old nonce
    // for CSRF_GRACE_PERIOD_MS after rotation.
    const prevCookie = request.cookies.get(CSRF_PREV_COOKIE_NAME)?.value;
    if (prevCookie) {
      const prevColonIdx = prevCookie.indexOf(':');
      const prevBangIdx = prevCookie.lastIndexOf('!');
      if (prevColonIdx !== -1 && prevBangIdx > prevColonIdx) {
        const prevNonce = prevCookie.slice(0, prevColonIdx);
        const prevRest = prevCookie.slice(prevColonIdx + 1, prevBangIdx);
        const prevTimestamp = parseInt(prevCookie.slice(prevBangIdx + 1), 10);

        if (!Number.isNaN(prevTimestamp) && Date.now() - prevTimestamp < CSRF_GRACE_PERIOD_MS) {
          if (verifyCsrfToken(headerToken, prevNonce, prevRest)) {
            return null; // Previous token still valid within grace period
          }
        }
      }
    }

    return NextResponse.json(
      { error: 'Invalid CSRF token' },
      { status: 403 },
    );
  }

  return null;
}

/**
 * V5 Audit §1.P3b — Check whether the CSRF cookie should be rotated.
 *
 * The cookie stores `nonce:sessionId`. We add an optional `!timestamp` suffix
 * so the middleware can tell when the token was issued. If the cookie is older
 * than CSRF_ROTATION_MAX_AGE_MS, `shouldRotateCsrf` returns true and the
 * middleware reissues a fresh token.
 */
const CSRF_ROTATION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

export function shouldRotateCsrf(request: NextRequest): boolean {
  const csrfCookie = request.cookies.get(CSRF_COOKIE_NAME)?.value;
  if (!csrfCookie) return false;

  const bangIdx = csrfCookie.lastIndexOf('!');
  if (bangIdx === -1) {
    // Legacy cookie without timestamp — rotate to add one
    return true;
  }

  const issuedAt = parseInt(csrfCookie.slice(bangIdx + 1), 10);
  if (Number.isNaN(issuedAt)) return true;

  return Date.now() - issuedAt > CSRF_ROTATION_MAX_AGE_MS;
}

/**
 * Cookie name and header name exports for the /api/csrf route.
 */
export { CSRF_COOKIE_NAME, CSRF_PREV_COOKIE_NAME, CSRF_HEADER_NAME };
