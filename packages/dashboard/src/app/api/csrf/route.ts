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
  signExistingCsrf,
  csrfRotationSeed,
  csrfCookieSessionId,
  csrfCookieNonce,
  csrfCookieIssuedAt,
  shouldRotateCsrfValue,
  stripCsrfTimestamp,
  generateRandomHex,
  CSRF_COOKIE_NAME,
  CSRF_PREV_COOKIE_NAME,
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
  // rotation, and never strand an in-flight token. There are three cases for the
  // existing cookie:
  //
  // 1. Same-session cookie, NOT yet due for rotation → re-sign the EXISTING
  //    nonce. The cookie value stays byte-identical, so concurrent tabs merely
  //    refreshing their in-memory token cannot overwrite the cookie with a
  //    different nonce. A tab that still holds the token for the current nonce
  //    (e.g. it mounted first and B just refreshed) stays valid — no cookie-soup
  //    race and, crucially, no 403 for the tab that did not re-fetch. This is
  //    the gap the earlier "always derive a new nonce" path left open: it
  //    rotated the nonce on every fetch without a `prev` grace, so a tab holding
  //    the pre-fetch token was rejected.
  //
  // 2. Same-session cookie that IS due for rotation → derive ONE new nonce
  //    deterministically from the stale cookie's own seed (so concurrent tabs
  //    crossing the boundary converge on the same nonce/token/cookie), AND set
  //    the `prev` cookie so in-flight requests still carrying the pre-rotation
  //    token are accepted for the grace window — mirroring the middleware.
  //
  // 3. No cookie, or a cross-session cookie (post logout/login) → fresh random
  //    token bound to the authenticated session. A stale cross-session cookie
  //    can never seed the new session's token.
  const existingCookie = request.cookies.get(CSRF_COOKIE_NAME)?.value;
  const existingNonce =
    existingCookie !== undefined ? csrfCookieNonce(existingCookie) : null;
  const sameSession =
    existingCookie !== undefined &&
    existingNonce !== null &&
    csrfCookieSessionId(existingCookie) === sessionId;
  const rotationDue = sameSession && shouldRotateCsrfValue(existingCookie!);

  const rotatedAt = Date.now();

  let token: string;
  let nonce: string;
  let issuedAt: number;
  if (sameSession && !rotationDue) {
    // Case 1: re-sign the nonce already in the browser; keep the cookie stable.
    ({ token, nonce } = await signExistingCsrf(existingNonce!, sessionId));
    issuedAt = csrfCookieIssuedAt(existingCookie!) ?? rotatedAt;
  } else if (rotationDue) {
    // Case 2: deterministic rotation converged with the middleware's seed.
    ({ token, nonce } = await deriveRotatedCsrf(
      sessionId,
      csrfRotationSeed(existingCookie!),
    ));
    issuedAt = rotatedAt;
  } else {
    // Case 3: fresh random token for a new / cross-session client.
    ({ token, nonce } = await generateCsrfToken(sessionId));
    issuedAt = rotatedAt;
  }

  const response = NextResponse.json({ token });

  // Case 2 only: preserve the OLD nonce as `prev`, stamped at rotation time, so
  // a tab that still holds the pre-rotation token is accepted for the grace
  // window (checkCsrf binds this grace to the active session). The current
  // cookie belongs to `sessionId` here, so the prev session matches the active
  // session by construction.
  if (rotationDue) {
    response.cookies.set(
      CSRF_PREV_COOKIE_NAME,
      `${stripCsrfTimestamp(existingCookie!)}!${rotatedAt}`,
      {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 90, // grace window (60s) + buffer; matches the middleware
      },
    );
  }

  // Set HttpOnly cookie with nonce + session for server-side verification.
  // V5 Audit §1.P3b: the `!timestamp` suffix drives periodic rotation. For a
  // reused (non-rotating) cookie the timestamp is preserved so the value is
  // byte-identical across concurrent responses and the rotation clock is not
  // reset on every token fetch.
  response.cookies.set(CSRF_COOKIE_NAME, `${nonce}:${sessionId}!${issuedAt}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60, // 1 hour
  });

  return response;
}
