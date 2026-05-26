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
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const CSRF_COOKIE_NAME = 'somnibot-csrf-token';
const CSRF_HEADER_NAME = 'x-csrf-token';

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

  // Skip exempt routes
  const path = request.nextUrl.pathname;
  // V6 Audit §1.1: Removed /api/setup — setup route uses parseBody() which
    // needs CSRF protection. Setup is POST-only with Supabase auth.
  const exemptPrefixes = [
    '/api/paypal/webhook',
    '/api/license/',
    '/api/portal/',
    '/api/auth/',
    '/api/downloads/',
    '/api/csrf',
  ];
  if (exemptPrefixes.some((prefix) => path.startsWith(prefix))) return null;

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

  // Cookie format: nonce:sessionId
  const colonIdx = csrfCookie.indexOf(':');
  if (colonIdx === -1) {
    return NextResponse.json(
      { error: 'Invalid CSRF cookie' },
      { status: 403 },
    );
  }

  const nonce = csrfCookie.slice(0, colonIdx);
  const sessionId = csrfCookie.slice(colonIdx + 1);

  if (!verifyCsrfToken(headerToken, nonce, sessionId)) {
    return NextResponse.json(
      { error: 'Invalid CSRF token' },
      { status: 403 },
    );
  }

  return null;
}

/**
 * Cookie name and header name exports for the /api/csrf route.
 */
export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME };
