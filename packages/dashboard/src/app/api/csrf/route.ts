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
import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { generateCsrfToken, generateRandomHex, CSRF_COOKIE_NAME } from '@/lib/api/csrf';

export async function GET() {
  // Get session identifier
  let sessionId: string;

  // In local-mode, use a fixed session ID (CSRF is exempt anyway for localhost)
  if (process.env.SESSION_TOKEN) {
    sessionId = 'local-session';
  } else {
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    sessionId = user?.id?.slice(-16) ?? generateRandomHex(8);
  }

  const { token, nonce } = await generateCsrfToken(sessionId);

  const response = NextResponse.json({ token });

  // Set HttpOnly cookie with nonce + session for server-side verification
  // V5 Audit §1.P3b: Append issuance timestamp for periodic rotation
  response.cookies.set(CSRF_COOKIE_NAME, `${nonce}:${sessionId}!${Date.now()}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60, // 1 hour
  });

  return response;
}
