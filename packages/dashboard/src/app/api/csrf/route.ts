/**
 * GET /api/csrf — Issue a CSRF token for the current session.
 *
 * V53 Phase 1.8
 *
 * Returns { token } in the response body and sets an HttpOnly cookie
 * containing the nonce + session ID needed for verification.
 *
 * The dashboard frontend should call this on mount and include the
 * returned token in the X-CSRF-Token header for all mutating requests.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { SupabaseRuntimeConfigError } from '@/lib/supabase/runtime-config';
import {
  generateCsrfToken,
  deriveRotatedCsrf,
  csrfRotationSeed,
  csrfCookieSessionId,
  csrfCookieIssuedAt,
  generateRandomHex,
  CSRF_COOKIE_NAME,
} from '@/lib/api/csrf';

export async function GET(request: NextRequest) {
  // Get session identifier
  let sessionId: string;

  // In explicit launcher local mode, use a fixed session ID. SESSION_TOKEN
  // alone is not proof of launcher ownership; it can be accidentally set in
  // cloud environments.
  if (process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE === '1' && process.env.SESSION_TOKEN) {
    sessionId = 'local-session';
  } else {
    try {
      const supabase = await createServerSupabase();
      const { data: { user } } = await supabase.auth.getUser();
      sessionId = user?.id?.slice(-16) ?? generateRandomHex(8);
    } catch (err) {
      if (
        err instanceof SupabaseRuntimeConfigError &&
        err.code === 'MISSING_PUBLIC_SUPABASE_CONFIG'
      ) {
        sessionId = generateRandomHex(8);
      } else {
        throw err;
      }
    }
  }

  // [security] Converge token issuance with the deterministic middleware
  // rotation. The middleware derives ONE rotated nonce per (session, stale
  // cookie) so concurrent tabs crossing the rotation boundary all agree on the
  // cookie/token. But if each /api/csrf call minted a fresh RANDOM token and
  // overwrote the cookie, several tabs re-fetching after rotation would race
  // again: their concurrent responses set different random cookies, and any tab
  // whose response loses the last-Set-Cookie write submits a token that no
  // longer matches the surviving cookie (a spurious 403). Deriving from the
  // existing cookie's own stable rotation seed makes every /api/csrf response
  // that reads the same cookie converge on the same nonce, token, and cookie
  // value — matching what the middleware would have derived. We only reuse the
  // cookie when its embedded session matches the authenticated session, so a
  // stale cross-session cookie (post logout/login) can never seed the new
  // session's token; that case falls through to a fresh random token.
  const existingCookie = request.cookies.get(CSRF_COOKIE_NAME)?.value;
  const reuseExisting =
    existingCookie !== undefined && csrfCookieSessionId(existingCookie) === sessionId;

  const { token, nonce } = reuseExisting
    ? await deriveRotatedCsrf(sessionId, csrfRotationSeed(existingCookie))
    : await generateCsrfToken(sessionId);

  // Preserve the existing cookie's issuance timestamp when converging so the
  // whole cookie value is byte-identical across concurrent responses (and does
  // not keep resetting the rotation clock on every token fetch). A brand-new
  // cookie is stamped with the current time. V5 Audit §1.P3b: the `!timestamp`
  // suffix drives periodic rotation in `shouldRotateCsrf`.
  const issuedAt = reuseExisting ? (csrfCookieIssuedAt(existingCookie) ?? Date.now()) : Date.now();

  const response = NextResponse.json({ token });

  // Set HttpOnly cookie with nonce + session for server-side verification
  response.cookies.set(CSRF_COOKIE_NAME, `${nonce}:${sessionId}!${issuedAt}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60, // 1 hour
  });

  return response;
}
