import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { checkCsrf, shouldRotateCsrf, CSRF_COOKIE_NAME, CSRF_PREV_COOKIE_NAME, generateCsrfToken } from '@/lib/api/csrf';
import { requireBrowserSupabaseConfig } from '@/lib/supabase/runtime-config';

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
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // V5 Audit §1.1: Removed 'unsafe-inline' fallback. Safari 15.4+ (released
    // March 2022) supports nonce on style-src, and all current browsers handle
    // nonce correctly. Keeping unsafe-inline weakened CSP on legacy clients.
    `style-src 'self' 'nonce-${nonce}'`,
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
function handleLocalAuth(request: NextRequest): NextResponse | null {
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
    return NextResponse.next({ request });
  }

  // First visit or mismatched token — set the cookie and continue
  // The launcher sets SESSION_TOKEN and only serves on localhost,
  // so anyone who can reach the server IS the operator.
  const response = NextResponse.next({ request });
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

/**
 * Middleware — refresh Supabase auth session on every request.
 * Redirects unauthenticated users away from protected routes.
 */
export async function middleware(request: NextRequest) {
  // Generate per-request CSP nonce
  const nonce = generateNonce();

  // ── Local mode: bypass Supabase entirely ──
  const localResponse = handleLocalAuth(request);
  if (localResponse) {
    applyCspHeaders(localResponse, nonce);
    return localResponse;
  }

  // Health checks must not depend on Supabase auth/session refresh. If this
  // route touches remote auth before the health handler runs, a production
  // auth outage can turn the monitor endpoint into a platform 500.
  if (
    request.nextUrl.pathname === '/api/health' &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    const healthResponse = NextResponse.next({ request });
    applyCspHeaders(healthResponse, nonce);
    return healthResponse;
  }

  if (isSessionlessPublicRoute(request.nextUrl.pathname)) {
    const csrfError = await checkCsrf(request);
    if (csrfError) {
      applyCspHeaders(csrfError, nonce);
      return csrfError;
    }

    const publicResponse = NextResponse.next({ request });
    applyCspHeaders(publicResponse, nonce);
    return publicResponse;
  }

  // ── Remote mode: Supabase session refresh + Discord OAuth ──
  let supabaseResponse = NextResponse.next({
    request,
  });

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
          supabaseResponse = NextResponse.next({
            request,
          });
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
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    const redirect = NextResponse.redirect(url);
    applyCspHeaders(redirect, nonce);
    return redirect;
  }

  // Redirect authenticated users away from login
  if (user && request.nextUrl.pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    const redirect = NextResponse.redirect(url);
    applyCspHeaders(redirect, nonce);
    return redirect;
  }

  // V53 Phase 1.8: CSRF protection for mutating requests
  const csrfError = await checkCsrf(request);
  if (csrfError) {
    applyCspHeaders(csrfError, nonce);
    return csrfError;
  }

  // V5 Audit §1.P3b: Periodically rotate CSRF cookie to limit token lifetime
  // V10 Audit §5: Preserve the old nonce in a separate cookie so in-flight
  // requests using the previous token are accepted during the grace period.
  if (user && shouldRotateCsrf(request)) {
    const sessionId = user.id?.slice(-16) ?? 'unknown';

    // Save current cookie as previous before overwriting
    const currentCookie = request.cookies.get(CSRF_COOKIE_NAME)?.value;
    if (currentCookie) {
      supabaseResponse.cookies.set(CSRF_PREV_COOKIE_NAME, `${currentCookie}`, {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        // V11 Audit M-3: Align cookie TTL with CSRF_GRACE_PERIOD_MS (60s) + 30s
        // buffer. Previously 120s which stored the cookie well past the 60s
        // acceptance window, wasting cookie bandwidth and leaking timing info.
        maxAge: 90,
      });
    }

    const csrf = await generateCsrfToken(sessionId);
    supabaseResponse.cookies.set(CSRF_COOKIE_NAME, `${csrf.nonce}:${sessionId}!${Date.now()}`, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60,
    });
  }

  // Apply CSP nonce to the response + pass nonce via header for layout
  applyCspHeaders(supabaseResponse, nonce);
  // Set nonce as a request header so server components can access it
  request.headers.set('x-nonce', nonce);
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
