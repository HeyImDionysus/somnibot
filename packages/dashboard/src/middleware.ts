import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { checkCsrf, shouldRotateCsrf, csrfRotationSeed, stripCsrfTimestamp, csrfCookieSessionId, deriveRotatedCsrf, deriveRebindCsrf, CSRF_COOKIE_NAME, CSRF_PREV_COOKIE_NAME } from '@/lib/api/csrf';
import { requireBrowserSupabaseConfig } from '@/lib/supabase/runtime-config';
import { getTrustedRedirectUrl } from '@/lib/public-redirect-origin';

/* ------------------------------------------------------------------ */
/*  CSP Nonce — generated per request for strict script-src            */
/* ------------------------------------------------------------------ */

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Convert to base64
  return btoa(String.fromCharCode(...bytes));
}

function buildCspHeader(nonce: string): string {
  const inlineCompat = process.env.SOMNIBOT_CSP_INLINE_COMPAT === '1';
  const developmentMode = process.env.NODE_ENV === 'development';
  const scriptSrc = inlineCompat
    ? `script-src 'self' 'unsafe-inline'${developmentMode ? " 'unsafe-eval'" : ''}`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentMode ? " 'unsafe-eval'" : ''}`;
  const styleSrc = inlineCompat || developmentMode
    ? "style-src 'self' 'unsafe-inline'"
    : `style-src 'self' 'nonce-${nonce}'`;

  return [
    "default-src 'self'",
    // Production default is nonce-based. Standalone deployments that cannot yet
    // propagate nonces into Next's framework/bootstrap scripts must opt into the
    // narrower compatibility mode with SOMNIBOT_CSP_INLINE_COMPAT=1.
    scriptSrc,
    styleSrc,
    "img-src 'self' data: https:",
    "font-src 'self'",
    // connect-src: External API calls (Discord, PayPal) go through server-side
    // routes. Add origins here only for direct client-side fetches.
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

function requestWithNonce(
  request: NextRequest,
  nonce: string,
  occurrenceId: string,
): { headers: Headers } {
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('x-somnibot-request-route', request.nextUrl.pathname);
  headers.set('x-somnibot-request-method', request.method);
  headers.set('x-somnibot-request-occurrence-id', occurrenceId);
  // Next.js reads the request CSP header during render to nonce framework
  // scripts. The response CSP is still set separately by applyCspHeaders.
  headers.set('Content-Security-Policy', buildCspHeader(nonce));
  return { headers };
}

function nextWithNonce(request: NextRequest, nonce: string, occurrenceId: string): NextResponse {
  return NextResponse.next({
    request: requestWithNonce(request, nonce, occurrenceId),
  });
}

/**
 * Apply security headers to a response.
 *
 * Includes CSP with per-request nonce, plus standard hardening headers:
 * - HSTS: enforce HTTPS for 1 year (includeSubDomains, preload-ready)
 * - X-Content-Type-Options: prevent MIME-type sniffing
 * - Referrer-Policy: don't leak full URL on cross-origin navigation
 * - X-Frame-Options: block framing (defense-in-depth alongside CSP frame-ancestors)
 */
function applyCspHeaders(response: NextResponse, nonce: string): void {
  response.headers.set('Content-Security-Policy', buildCspHeader(nonce));
  // V5 Audit §1.8: Don't expose the CSP nonce to the client via a response
  // header — it weakens CSP if an attacker can read response headers (e.g.
  // via an XSS in a script that reads document headers). Server components
  // access the nonce via the request header (set on line ~203) instead.
  response.headers.delete('x-nonce');
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Frame-Options', 'DENY');
}

/* ------------------------------------------------------------------ */
/*  Local-mode detection                                               */
/*  When explicit launcher local mode is enabled, we skip              */
/*  Supabase/Discord OAuth entirely and authenticate via a simple      */
/*  session cookie. The dashboard is bound to 127.0.0.1 so the token  */
/*  never leaves the machine.                                          */
/* ------------------------------------------------------------------ */

const LOCAL_MODE_ENABLED = process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE === '1';
const LOCAL_SESSION_TOKEN = process.env.SESSION_TOKEN ?? null;
const COOKIE_NAME = 'somnibot-local-session';

function isLocalMode(): boolean {
  return LOCAL_MODE_ENABLED && LOCAL_SESSION_TOKEN !== null && LOCAL_SESSION_TOKEN.length > 0;
}

/**
 * Handle auth for local-mode (Electron launcher).
 * Returns a response if handled, or null to fall through to remote auth.
 */
function handleLocalAuth(
  request: NextRequest,
  nonce: string,
  occurrenceId: string,
): NextResponse | null {
  if (!isLocalMode()) return null;

  // I-2: Only allow local-mode auth for actual localhost requests.
  // Prevents accidental auto-auth if SESSION_TOKEN is set in a hosted deployment.
  const host = request.headers.get('host') ?? '';
  const isLocalhost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(host);
  if (!isLocalhost) {
    // V6 Audit §1.4: Loud warning when SESSION_TOKEN is set in a non-local deployment.
    // This should NEVER happen in production — SESSION_TOKEN is only for Electron launcher.
    console.error(
      '[Middleware] SECURITY WARNING: SESSION_TOKEN is set but request host is not localhost (' +
      host + '). This env var must ONLY be set by the Electron launcher for local-mode. ' +
      'Remove SESSION_TOKEN from your production environment immediately.',
    );
    return null;
  }

  const sessionCookie = request.cookies.get(COOKIE_NAME)?.value;
  const pathname = request.nextUrl.pathname;

  // In local mode, redirect login/root to dashboard — the user is already
  // authenticated by virtue of being on localhost with SESSION_TOKEN set.
  // Without this, the root page calls supabase.auth.getUser() (which returns
  // null in local mode) and redirects to /login, where the Discord OAuth
  // button has no Supabase URL to work with.
  if (pathname === '/' || pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    const response = NextResponse.redirect(url);
    if (sessionCookie !== LOCAL_SESSION_TOKEN) {
      response.cookies.set(COOKIE_NAME, LOCAL_SESSION_TOKEN!, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      });
    }
    return response;
  }

  // Already authenticated — pass through
  if (sessionCookie === LOCAL_SESSION_TOKEN) {
    return nextWithNonce(request, nonce, occurrenceId);
  }

  // First visit or mismatched token — bind the browser, then repeat the same
  // protected request. Continuing immediately would render the server layout
  // before the response cookie exists; the layout would see no local session
  // and redirect to /login, creating a login/dashboard loop.
  const response = NextResponse.redirect(request.nextUrl.clone());
  response.cookies.set(COOKIE_NAME, LOCAL_SESSION_TOKEN!, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // No secure flag — this runs on http://localhost
  });
  return response;
}

/* ------------------------------------------------------------------ */
/*  Remote-mode auth (existing Supabase / Discord OAuth)               */
/* ------------------------------------------------------------------ */

function isSessionlessPublicRoute(pathname: string): boolean {
  return (
    pathname.startsWith('/api/auth') ||
    pathname === '/api/csrf' ||
    pathname === '/setup' ||
    pathname.startsWith('/api/setup') ||
    pathname.startsWith('/api/paypal/webhook') ||
    pathname.startsWith('/api/inbound-webhooks/') ||
    // Cron/operator recovery authenticates with the dedicated
    // x-paypal-reconcile-secret header in the route itself. Keep it out of
    // Supabase session auth so machine callers can reach that gate.
    pathname === '/api/paypal/recovery' ||
    pathname.startsWith('/api/license/validate') ||
    pathname.startsWith('/api/license/heartbeat') ||
    pathname.startsWith('/api/license/deactivate') ||
    // Portal routes use x-portal-token auth (Discord identity), not Supabase session
    pathname.startsWith('/portal') ||
    pathname.startsWith('/api/portal/') ||
    // Downloads use portal token auth internally
    pathname.startsWith('/api/downloads/')
  );
}

function constantTimeTextMatches(provided: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(provided);
  const right = encoder.encode(expected);
  let mismatch = left.length ^ right.length;
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

/**
 * Middleware must let the machine-authenticated reconcile request reach its
 * route before Supabase-session and CSRF checks. The bypass is deliberately
 * narrower than a public route: exact path, configured secret, exact match.
 * A missing or wrong secret stays on the normal owner auth + CSRF path.
 */
function hasValidReconcileSchedulerSecret(request: NextRequest): boolean {
  if (request.nextUrl.pathname !== '/api/paypal/reconcile') return false;
  const expected = process.env.PAYPAL_RECONCILE_SECRET;
  if (!expected) return false;
  const direct = request.headers.get('x-reconcile-secret');
  const authorization = request.headers.get('authorization');
  const provided = direct
    ?? (
      authorization?.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7)
        : null
    );
  return provided !== null && constantTimeTextMatches(provided, expected);
}

/**
 * Middleware — refresh Supabase auth session on every request.
 * Redirects unauthenticated users away from protected routes.
 */
export async function middleware(request: NextRequest) {
  // Generate per-request CSP nonce
  const nonce = generateNonce();
  const occurrenceId = crypto.randomUUID();

  // Health probes are machine-to-machine requests and do not retain the
  // launcher-local session cookie. They must bypass local auth before it can
  // redirect a first request back to the identical URL to set that cookie.
  // Otherwise Node's fetch follows the self-redirect until its redirect limit
  // is exhausted and the launcher can never prove an otherwise healthy stack.
  if (
    ['/api/health', '/api/health/live'].includes(request.nextUrl.pathname) &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    const healthResponse = nextWithNonce(request, nonce, occurrenceId);
    applyCspHeaders(healthResponse, nonce);
    return healthResponse;
  }

  // ── Local mode: bypass Supabase entirely ──
  const localResponse = handleLocalAuth(request, nonce, occurrenceId);
  if (localResponse) {
    applyCspHeaders(localResponse, nonce);
    return localResponse;
  }

  if (hasValidReconcileSchedulerSecret(request)) {
    const schedulerResponse = nextWithNonce(request, nonce, occurrenceId);
    applyCspHeaders(schedulerResponse, nonce);
    return schedulerResponse;
  }

  if (isSessionlessPublicRoute(request.nextUrl.pathname)) {
    const csrfError = await checkCsrf(request);
    if (csrfError) {
      applyCspHeaders(csrfError, nonce);
      return csrfError;
    }

    const publicResponse = nextWithNonce(request, nonce, occurrenceId);
    applyCspHeaders(publicResponse, nonce);
    return publicResponse;
  }

  // ── Remote mode: Supabase session refresh + Discord OAuth ──
  let supabaseResponse = nextWithNonce(request, nonce, occurrenceId);

  const { url, publishableKey } = requireBrowserSupabaseConfig();
  const supabase = createServerClient(
    url,
    publishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = nextWithNonce(request, nonce, occurrenceId);
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options as Parameters<typeof supabaseResponse.cookies.set>[2]),
          );
        },
      },
    },
  );

  // Refresh the session
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Redirect unauthenticated users to login (except for auth & setup routes)
  const isPublicRoute =
    request.nextUrl.pathname.startsWith('/login') ||
    isSessionlessPublicRoute(request.nextUrl.pathname);

  if (!user && !isPublicRoute) {
    const url = getTrustedRedirectUrl(request);
    url.pathname = '/login';
    const redirect = NextResponse.redirect(url);
    applyCspHeaders(redirect, nonce);
    return redirect;
  }

  // Redirect authenticated users away from login
  if (user && request.nextUrl.pathname === '/login') {
    const url = getTrustedRedirectUrl(request);
    url.pathname = '/dashboard';
    const redirect = NextResponse.redirect(url);
    applyCspHeaders(redirect, nonce);
    return redirect;
  }

  // [security] R8 SESSION-BINDING INVARIANT + validation-ordering fix.
  //
  // The current CSRF cookie's embedded session MUST always equal the
  // authenticated session. After a logout/login or account switch the browser
  // still carries the *previous* user's CSRF cookie (nothing clears it on
  // sign-in), and `checkCsrf` verifies a token against the session embedded IN
  // the cookie — never the authenticated user.
  //
  // This mismatch check MUST run BEFORE `checkCsrf`, not after. If it runs after
  // (validating first, rebinding only in the response), the FIRST mutating
  // request following an account switch is validated by the PREVIOUS session's
  // token — the browser still holds A's cookie AND A's matching token, so
  // `checkCsrf` sees a self-consistent A cookie/token pair and passes, letting
  // the mutation execute as B before the cookie is ever rebound. Detecting the
  // mismatch up front and failing closed on mutating methods guarantees a foreign
  // cookie can never validate a request under the new session.
  const currentCookie = request.cookies.get(CSRF_COOKIE_NAME)?.value;
  const sessionId = user?.id?.slice(-16) ?? 'unknown';
  const sessionMismatch =
    user !== null &&
    currentCookie !== undefined &&
    csrfCookieSessionId(currentCookie) !== sessionId;

  if (sessionMismatch) {
    // Foreign cookie → hard reset for the new session. Rebind the current cookie
    // and expire any stale prev grace, DETERMINISTICALLY (see below). We apply
    // the rebind to whatever response we return so the client's NEXT request
    // carries a session-correct cookie.
    //
    // For mutating methods we additionally FAIL CLOSED (403): the incoming token
    // could only ever match the foreign cookie, so accepting it would validate a
    // mutation under the wrong session. The client re-fetches /api/csrf after the
    // 403 and retries with a session-correct token. Non-mutating methods (GET of
    // a page/route) carry no CSRF requirement, so we simply rebind and continue.
    //
    // [security] The rebind nonce is DERIVED DETERMINISTICALLY, not random:
    // several tabs can hit the middleware with the same foreign cookie during one
    // account switch, and a per-request random nonce would reintroduce the
    // cookie-soup race (each response setting a different cookie/token). Seed the
    // derivation from the foreign cookie's own content under a distinct `rebind:`
    // domain so (a) all concurrent switch requests converge on one nonce and
    // (b) the rebind nonce can never collide with a same-session rotation nonce
    // for the same seed. Unforgeability is unchanged — the nonce is still
    // HMAC(secret, …) and the foreign cookie content is not secret.
    const rebindAt = Date.now();
    const rebound = await deriveRebindCsrf(sessionId, currentCookie!);

    const method = request.method.toUpperCase();
    const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const target = isMutating
      ? NextResponse.json(
          { error: 'CSRF session rebound — please retry' },
          { status: 403 },
        )
      : supabaseResponse;

    target.cookies.delete({ name: CSRF_PREV_COOKIE_NAME, path: '/' });
    target.cookies.set(CSRF_COOKIE_NAME, `${rebound.nonce}:${sessionId}!${rebindAt}`, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60,
    });

    applyCspHeaders(target, nonce);
    return target;
  }

  // V53 Phase 1.8: CSRF protection for mutating requests. Safe to run here: a
  // session mismatch has already been handled (and rejected for mutating
  // methods) above, so `checkCsrf` only ever validates a cookie whose embedded
  // session matches the authenticated user.
  const csrfError = await checkCsrf(request);
  if (csrfError) {
    applyCspHeaders(csrfError, nonce);
    return csrfError;
  }

  // V5 Audit §1.P3b: Periodically rotate CSRF cookie to limit token lifetime
  // V10 Audit §5: Preserve the old nonce in a separate cookie so in-flight
  // requests using the previous token are accepted during the grace period.
  // WAVE 2B [security]: Rotate DETERMINISTICALLY. Under concurrency (many
  // dashboard tabs), several requests observe the same stale cookie and each
  // rotate. A random per-request nonce makes every response set a different
  // cookie and embed a different token — the browser keeps the last Set-Cookie,
  // so a form built from a losing response holds a token that matches neither
  // the surviving cookie nor the single `prev` cookie (spurious 403 "cookie
  // soup"). Deriving the new nonce from the stale cookie's issuance timestamp
  // means every concurrent request converges on the same rotated token.
  if (user && currentCookie && shouldRotateCsrf(request)) {
    // Same session (mismatch already handled above), cookie aged past the
    // rotation window → deterministic rotate.
    const rotatedAt = Date.now();

    // Save the old nonce as `prev` so in-flight requests still holding the old
    // token are accepted during the grace period. Stamp it with the ROTATION
    // time (not the stale cookie's original issuance) — the grace window is
    // measured from when rotation happened.
    const oldPrefix = stripCsrfTimestamp(currentCookie);
    supabaseResponse.cookies.set(CSRF_PREV_COOKIE_NAME, `${oldPrefix}!${rotatedAt}`, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      // V11 Audit M-3: Align cookie TTL with CSRF_GRACE_PERIOD_MS (60s) + 30s
      // buffer.
      maxAge: 90,
    });

    // Derive the rotated token from a stable seed taken from the STALE cookie
    // itself so every concurrent request lands on the same nonce. For
    // timestamped cookies the seed is the issuance timestamp; for legacy
    // timestamp-less cookies it is the cookie's own prefix — never the
    // per-request clock, which would give concurrent tabs different nonces and
    // reintroduce the very race this change eliminates.
    const rotationSeed = csrfRotationSeed(currentCookie);
    const csrf = await deriveRotatedCsrf(sessionId, rotationSeed);
    supabaseResponse.cookies.set(CSRF_COOKIE_NAME, `${csrf.nonce}:${sessionId}!${rotatedAt}`, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60,
    });
  }

  // Apply CSP nonce to the response. The matching x-nonce request header is
  // attached via nextWithNonce so Next.js can nonce framework/client scripts.
  applyCspHeaders(supabaseResponse, nonce);
  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico (favicon)
     * - public folder files
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
