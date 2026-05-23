import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { checkCsrf } from '@/lib/api/csrf';

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
    // style-src still needs unsafe-inline for Tailwind/CSS-in-JS
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://cdn.discordapp.com",
    "font-src 'self'",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Apply CSP nonce headers to a response.
 * The nonce is also set as a request header so the root layout
 * can read it via headers() to pass to Script components.
 */
function applyCspHeaders(response: NextResponse, nonce: string): void {
  response.headers.set('Content-Security-Policy', buildCspHeader(nonce));
  response.headers.set('x-nonce', nonce);
}

/* ------------------------------------------------------------------ */
/*  Local-mode detection                                               */
/*  When SESSION_TOKEN env var is set (by the Electron launcher),      */
/*  we skip Supabase/Discord OAuth entirely and authenticate via a     */
/*  simple session cookie.  The dashboard is bound to 127.0.0.1 so    */
/*  the token never leaves the machine.                                */
/* ------------------------------------------------------------------ */

const LOCAL_SESSION_TOKEN = process.env.SESSION_TOKEN ?? null;
const COOKIE_NAME = 'somnibot-local-session';

function isLocalMode(): boolean {
  return LOCAL_SESSION_TOKEN !== null && LOCAL_SESSION_TOKEN.length > 0;
}

/**
 * Handle auth for local-mode (Electron launcher).
 * Returns a response if handled, or null to fall through to remote auth.
 */
function handleLocalAuth(request: NextRequest): NextResponse | null {
  if (!isLocalMode()) return null;

  // I-2: Only allow local-mode auth for actual localhost requests.
  // Prevents accidental auto-auth if SESSION_TOKEN is set in a cloud deployment.
  const host = request.headers.get('host') ?? '';
  const isLocalhost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(host);
  if (!isLocalhost) {
    console.warn('[Middleware] SESSION_TOKEN is set but request host is not localhost — ignoring local-mode auth');
    return null;
  }

  const sessionCookie = request.cookies.get(COOKIE_NAME)?.value;

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

  // ── Remote mode: Supabase session refresh + Discord OAuth ──
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
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
    request.nextUrl.pathname.startsWith('/api/auth') ||
    request.nextUrl.pathname === '/setup' ||
    request.nextUrl.pathname.startsWith('/api/setup') ||
    request.nextUrl.pathname.startsWith('/api/paypal/webhook') ||
    request.nextUrl.pathname.startsWith('/api/license/validate') ||
    request.nextUrl.pathname.startsWith('/api/license/heartbeat') ||
    request.nextUrl.pathname.startsWith('/api/license/deactivate') ||
    // Portal routes use x-portal-token auth (Discord identity), not Supabase session
    request.nextUrl.pathname.startsWith('/portal') ||
    request.nextUrl.pathname.startsWith('/api/portal/') ||
    // Downloads use portal token auth internally
    request.nextUrl.pathname.startsWith('/api/downloads/');

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
  const csrfError = checkCsrf(request);
  if (csrfError) {
    applyCspHeaders(csrfError, nonce);
    return csrfError;
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
