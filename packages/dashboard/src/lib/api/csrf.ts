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
import { type NextRequest, NextResponse } from 'next/server';

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

let _csrfKey: CryptoKey | undefined;
const encoder = new TextEncoder();

function getWebCrypto(): Crypto {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new Error('Web Crypto API is required for CSRF protection');
  }
  return crypto;
}

export function generateRandomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  getWebCrypto().getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getCsrfKey(): Promise<CryptoKey> {
  if (_csrfKey) return _csrfKey;
  _csrfKey = await getWebCrypto().subtle.importKey(
    'raw',
    encoder.encode(getCsrfSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return _csrfKey;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function signCsrfValue(nonce: string, sessionId: string): Promise<string> {
  const signature = await getWebCrypto().subtle.sign(
    'HMAC',
    await getCsrfKey(),
    encoder.encode(`${nonce}:${sessionId}`),
  );
  return toHex(signature);
}

/**
 * Generate a CSRF token tied to a session identifier.
 * The token is an HMAC of a random nonce + the session ID.
 */
export async function generateCsrfToken(sessionId: string): Promise<{ token: string; nonce: string }> {
  const nonce = generateRandomHex(16);
  const token = await signCsrfValue(nonce, sessionId);
  return { token, nonce };
}

/**
 * WAVE 2B [security] — Deterministic CSRF rotation to eliminate the rotation race.
 *
 * Background: the middleware reissues the CSRF cookie once it is older than
 * CSRF_ROTATION_MAX_AGE_MS. Under concurrency (many dashboard tabs), several
 * requests observe the *same* stale cookie and each rotate independently. If
 * every rotation picks a fresh random nonce (as `generateCsrfToken` does), the
 * responses race: each sets a different cookie and each rendered page embeds a
 * different token. The browser keeps whichever Set-Cookie landed last, so a
 * form built from a losing response carries a token that matches neither the
 * surviving cookie nor the single `prev` cookie — a spurious 403 ("cookie
 * soup").
 *
 * Fix: derive the rotated nonce deterministically from the *prior* cookie's
 * issuance timestamp (`priorIssuedAt`) plus the session ID, via HMAC. Every
 * concurrent request reads the same stale cookie, so every request sees the
 * same `priorIssuedAt` and derives the *same* new nonce — regardless of tiny
 * wall-clock skew between them. All responses therefore agree on the cookie and
 * on the embedded token, so no in-flight form is spuriously rejected.
 *
 * Security is unchanged from the random-nonce design: the derived nonce is an
 * HMAC under the same server secret, so an attacker cannot predict or forge it
 * without the secret. The token itself is still `HMAC(nonce, sessionId)`, which
 * the double-submit check validates exactly as before.
 */
export async function deriveRotatedCsrf(
  sessionId: string,
  priorIssuedAt: number,
): Promise<{ token: string; nonce: string }> {
  const signature = await getWebCrypto().subtle.sign(
    'HMAC',
    await getCsrfKey(),
    // Domain-separated from the token HMAC (`nonce:sessionId`) so the derived
    // nonce can never coincide with a token value. `priorIssuedAt` makes each
    // rotation window derive a distinct nonce.
    encoder.encode(`csrf-rotation:v1:${sessionId}:${priorIssuedAt}`),
  );
  // Use the first 16 bytes (32 hex) so the nonce matches the random-nonce
  // format produced by generateRandomHex(16).
  const nonce = toHex(signature).slice(0, 32);
  const token = await signCsrfValue(nonce, sessionId);
  return { token, nonce };
}

/**
 * Extract the issuance timestamp from a CSRF cookie value
 * (`nonce:sessionId!timestamp`). Returns null when the cookie has no parseable
 * `!timestamp` suffix (legacy cookies) so callers can fall back safely.
 */
export function csrfCookieIssuedAt(cookieValue: string): number | null {
  const bangIdx = cookieValue.lastIndexOf('!');
  if (bangIdx === -1) return null;
  const issuedAt = parseInt(cookieValue.slice(bangIdx + 1), 10);
  return Number.isNaN(issuedAt) ? null : issuedAt;
}

/**
 * Strip a trailing `!timestamp` suffix from a CSRF cookie value, returning just
 * the `nonce:sessionId` prefix. Only removes the suffix when it is numeric, so
 * a legacy cookie (no `!timestamp`) is returned unchanged. Used when re-stamping
 * the `prev` cookie with the rotation time.
 */
export function stripCsrfTimestamp(cookieValue: string): string {
  const bangIdx = cookieValue.lastIndexOf('!');
  if (bangIdx === -1) return cookieValue;
  const suffix = cookieValue.slice(bangIdx + 1);
  if (suffix.length === 0 || Number.isNaN(parseInt(suffix, 10))) return cookieValue;
  return cookieValue.slice(0, bangIdx);
}

/**
 * Verify a CSRF token against the stored nonce and session.
 */
export function verifyCsrfToken(
  token: string,
  nonce: string,
  sessionId: string,
): Promise<boolean> {
  return signCsrfValue(nonce, sessionId)
    .then((expected) => constantTimeEqual(token, expected));
}

/**
 * Check CSRF token on a mutating request.
 * Returns null if valid, or a NextResponse error if invalid.
 *
 * Exemptions:
 * - Local-mode (explicit launcher marker + SESSION_TOKEN env + localhost)
 * - Webhook routes (/api/paypal/webhook, /api/license/*)
 * - Portal routes (use their own token auth)
 * - GET/HEAD/OPTIONS requests
 */
export async function checkCsrf(request: NextRequest): Promise<NextResponse | null> {
  const method = request.method.toUpperCase();

  // Only check mutating methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;

  // Skip local-mode (Electron launcher — bound to localhost)
  const sessionToken = process.env.SESSION_TOKEN;
  const launcherLocalMode = process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE === '1';
  if (launcherLocalMode && sessionToken) {
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

  if (!(await verifyCsrfToken(headerToken, nonce, sessionId))) {
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
          if (await verifyCsrfToken(headerToken, prevNonce, prevRest)) {
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
