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
import { CSRF_EXEMPT_PREFIXES } from '@/lib/csrf-exempt';

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

// V7 Audit §1.P3a — CSRF_EXEMPT_PREFIXES lives in @/lib/csrf-exempt (client-safe
// module) so the client fetch wrapper can skip the token preflight for the same
// routes this server-side check exempts.

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
 * Fix: derive the rotated nonce deterministically from a `rotationSeed` that is
 * a stable property of the *stale cookie itself* (plus the session ID), via
 * HMAC. Every concurrent request reads the same stale cookie, so every request
 * passes the same `rotationSeed` and derives the *same* new nonce — regardless
 * of tiny wall-clock skew between them. All responses therefore agree on the
 * cookie and on the embedded token, so no in-flight form is spuriously rejected.
 *
 * The seed MUST come from the stale cookie, never from the per-request clock:
 * for a timestamped cookie the caller passes the issuance timestamp; for a
 * legacy timestamp-less cookie the caller passes the cookie prefix
 * (`nonce:sessionId`). Both are identical across all concurrent requests that
 * read the same cookie, which is what makes the derivation converge. (An earlier
 * revision fell back to `Date.now()` for legacy cookies, which reintroduced the
 * race for those users because each concurrent request read a different clock.)
 *
 * Security is unchanged from the random-nonce design: the derived nonce is an
 * HMAC under the same server secret, so an attacker cannot predict or forge it
 * without the secret. The token itself is still `HMAC(nonce, sessionId)`, which
 * the double-submit check validates exactly as before.
 */
export async function deriveRotatedCsrf(
  sessionId: string,
  rotationSeed: string | number,
): Promise<{ token: string; nonce: string }> {
  const signature = await getWebCrypto().subtle.sign(
    'HMAC',
    await getCsrfKey(),
    // Domain-separated from the token HMAC (`nonce:sessionId`) so the derived
    // nonce can never coincide with a token value. `rotationSeed` makes each
    // rotation window derive a distinct nonce.
    encoder.encode(`csrf-rotation:v1:${sessionId}:${rotationSeed}`),
  );
  // Use the first 16 bytes (32 hex) so the nonce matches the random-nonce
  // format produced by generateRandomHex(16).
  const nonce = toHex(signature).slice(0, 32);
  const token = await signCsrfValue(nonce, sessionId);
  return { token, nonce };
}

/**
 * Sign a token for a nonce that already lives in the browser's CSRF cookie.
 *
 * [security] `/api/csrf` uses this when a same-session cookie exists but is not
 * yet due for rotation: re-signing the EXISTING nonce keeps the cookie value
 * byte-identical, so concurrent tabs refreshing their in-memory token never
 * overwrite the cookie with a different nonce. Any tab still holding a token for
 * that nonce stays valid — no cookie-soup race, and no need for a `prev` grace
 * cookie. Determinism and unforgeability are unchanged: the token is the same
 * `HMAC(nonce, sessionId)` the double-submit check already validates.
 */
export async function signExistingCsrf(
  nonce: string,
  sessionId: string,
): Promise<{ token: string; nonce: string }> {
  const token = await signCsrfValue(nonce, sessionId);
  return { token, nonce };
}

/**
 * Compute the stable rotation seed for a CSRF cookie value.
 *
 * WAVE 2B follow-up [security]: the seed must be derived only from the stale
 * cookie's own content — never the wall clock — so that all concurrent requests
 * reading the same cookie converge on one rotated nonce (see `deriveRotatedCsrf`).
 *
 * - Timestamped cookie (`nonce:sessionId!timestamp`): seed is the numeric
 *   issuance timestamp. Identical across concurrent readers.
 * - Legacy cookie (`nonce:sessionId`, no timestamp): seed is the cookie prefix
 *   (`stripCsrfTimestamp` returns it unchanged), which is likewise identical
 *   across concurrent readers, so legacy-cookie rotations no longer race.
 */
export function csrfRotationSeed(cookieValue: string): string {
  const issuedAt = csrfCookieIssuedAt(cookieValue);
  return issuedAt !== null ? String(issuedAt) : `legacy:${stripCsrfTimestamp(cookieValue)}`;
}

/**
 * Extract the session identifier embedded in a CSRF cookie value
 * (`nonce:sessionId` or `nonce:sessionId!timestamp`). Returns null when the
 * cookie has no `:` separator (malformed). Mirrors the parsing in `checkCsrf`
 * so callers that need to compare the cookie's session against the currently
 * authenticated session stay consistent.
 */
export function csrfCookieSessionId(cookieValue: string): string | null {
  const colonIdx = cookieValue.indexOf(':');
  if (colonIdx === -1) return null;
  const rest = cookieValue.slice(colonIdx + 1);
  const bangIdx = rest.lastIndexOf('!');
  return bangIdx === -1 ? rest : rest.slice(0, bangIdx);
}

/**
 * Extract the nonce embedded in a CSRF cookie value
 * (`nonce:sessionId` or `nonce:sessionId!timestamp`). Returns null when the
 * cookie has no `:` separator (malformed). Lets callers re-sign the nonce that
 * is actually stored in the browser instead of deriving a fresh one.
 */
export function csrfCookieNonce(cookieValue: string): string | null {
  const colonIdx = cookieValue.indexOf(':');
  if (colonIdx === -1) return null;
  return cookieValue.slice(0, colonIdx);
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

        // [security] Bind the prev-token grace to the ACTIVE session. The grace
        // branch verifies the header against the session embedded IN the prev
        // cookie (`prevRest`), so a prev cookie left over from a different
        // session would let a stale tab pass CSRF under the new session. This
        // happens even without a fresh rotation: a legitimate same-session
        // rotation under account A stamps a 60s-fresh `prev`, then the user
        // signs into account B; the browser still carries A's prev, and the
        // current cookie has been rebound to B. Requiring the prev session to
        // equal the current cookie's session (`sessionId`, the active session)
        // rejects that cross-session grace regardless of whether rotation fired
        // on the switch request.
        if (
          prevRest === sessionId &&
          !Number.isNaN(prevTimestamp) &&
          Date.now() - prevTimestamp < CSRF_GRACE_PERIOD_MS
        ) {
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

/**
 * Decide whether a CSRF cookie *value* is due for rotation. Shared by the
 * request-based `shouldRotateCsrf` (middleware) and `/api/csrf`, which must
 * apply the exact same age policy so the two rotation paths stay consistent.
 */
export function shouldRotateCsrfValue(cookieValue: string): boolean {
  const bangIdx = cookieValue.lastIndexOf('!');
  if (bangIdx === -1) {
    // Legacy cookie without timestamp — rotate to add one
    return true;
  }

  const issuedAt = parseInt(cookieValue.slice(bangIdx + 1), 10);
  if (Number.isNaN(issuedAt)) return true;

  return Date.now() - issuedAt > CSRF_ROTATION_MAX_AGE_MS;
}

/**
 * WAVE 2B follow-up [security] — proactive near-boundary rotation lead time.
 *
 * `/api/csrf` normally re-signs the existing (unchanged) nonce when a same-session
 * cookie is not yet rotation-due, writing no cookie. That is correct except in a
 * narrow window: if the cookie is issued just BEFORE the rotation boundary, a
 * freshly fetched token is for the OLD nonce, but a concurrent request may rotate
 * the cookie moments later. The user then holds a token that matches only the
 * `prev` grace cookie — which expires 60s after rotation. A user who fetches a
 * token, spends a minute filling a form, and submits would 403.
 *
 * To close this, `/api/csrf` PROACTIVELY rotates when the cookie is within this
 * lead time of the hard boundary: it returns the deterministic rotated token and
 * writes the rotated cookie + prev, so the token the user just fetched is valid
 * against the CURRENT cookie (not just the expiring grace window) even if a
 * concurrent request rotates. The derivation is the same deterministic seed the
 * middleware uses, so the two paths converge on one nonce.
 *
 * Set to CSRF_GRACE_PERIOD_MS (60s): the lead time is exactly the window in which
 * a not-yet-due token could otherwise become grace-only before the user submits.
 */
const CSRF_ROTATION_LEAD_MS = CSRF_GRACE_PERIOD_MS; // 60s

/**
 * Whether a same-session cookie is close enough to the rotation boundary that
 * `/api/csrf` should proactively rotate NOW rather than re-sign the old nonce.
 * Returns true when the cookie is due, or within CSRF_ROTATION_LEAD_MS of the
 * hard boundary. Legacy (timestamp-less) and unparseable cookies are always due
 * (mirrors `shouldRotateCsrfValue`), so they also count as near-boundary.
 */
export function isNearRotationBoundary(cookieValue: string): boolean {
  const bangIdx = cookieValue.lastIndexOf('!');
  if (bangIdx === -1) return true;
  const issuedAt = parseInt(cookieValue.slice(bangIdx + 1), 10);
  if (Number.isNaN(issuedAt)) return true;
  return Date.now() - issuedAt > CSRF_ROTATION_MAX_AGE_MS - CSRF_ROTATION_LEAD_MS;
}

/**
 * WAVE 2B follow-up [security] — DETERMINISTIC cross-session rebind seed.
 *
 * When `/api/csrf` (or the middleware) rebinds a leftover foreign cookie to the
 * newly authenticated session, several post-switch tabs can hit the endpoint with
 * the SAME foreign cookie at once. A random nonce per tab reintroduces the
 * cookie-soup race (each response setting a different cookie/token, last write
 * wins, the other tabs' forms 403). Deriving the rebind nonce from the foreign
 * cookie's own content under a distinct `rebind:` domain makes all concurrent
 * post-switch tabs converge on one nonce, exactly as the middleware does — so the
 * two rebind paths agree and no tab is stranded. Domain separation guarantees the
 * rebind nonce can never collide with a same-session rotation nonce for the same
 * seed. Unforgeability is unchanged: the nonce is still HMAC(secret, …).
 */
export async function deriveRebindCsrf(
  sessionId: string,
  foreignCookieValue: string,
): Promise<{ token: string; nonce: string }> {
  return deriveRotatedCsrf(sessionId, `rebind:${stripCsrfTimestamp(foreignCookieValue)}`);
}

export function shouldRotateCsrf(request: NextRequest): boolean {
  const csrfCookie = request.cookies.get(CSRF_COOKIE_NAME)?.value;
  if (!csrfCookie) return false;
  return shouldRotateCsrfValue(csrfCookie);
}

/**
 * Cookie name and header name exports for the /api/csrf route.
 */
export { CSRF_COOKIE_NAME, CSRF_PREV_COOKIE_NAME, CSRF_HEADER_NAME };

/**
 * V9 Audit §1.P2 follow-up [security] — Invalidate every CSRF cookie after a
 * privilege change.
 *
 * Deleting only `CSRF_COOKIE_NAME` is insufficient: if the current token was
 * rotated within the last `CSRF_GRACE_PERIOD_MS`, the browser still holds a
 * `CSRF_PREV_COOKIE_NAME` cookie that `checkCsrf` accepts during the grace
 * window. A stale tab could keep passing its pre-change token via `prev` even
 * after the client re-fetches `/api/csrf`, defeating the documented CSRF
 * invalidation window on RBAC role assignment/removal. Clearing both cookies
 * closes that window. Call this anywhere the current CSRF token is invalidated.
 *
 * [security] The expiry Set-Cookie MUST carry the same `path: '/'` these cookies
 * are issued with (see `/api/csrf` and the middleware rotation). A browser only
 * removes a stored cookie when the deletion's Path (and Domain) match the stored
 * cookie's. Deleting by bare name emits a `Path`-less expiry that does not match
 * the root-path `somnibot-csrf-prev`, leaving it intact so `checkCsrf` could keep
 * honouring the pre-change token during the grace window. Pass the path so the
 * deletion actually lands.
 */
export function invalidateCsrfCookies(response: NextResponse): void {
  response.cookies.delete({ name: CSRF_COOKIE_NAME, path: '/' });
  response.cookies.delete({ name: CSRF_PREV_COOKIE_NAME, path: '/' });
}
