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
import { generateCsrfToken, CSRF_COOKIE_NAME } from '@/lib/api/csrf';
import { randomBytes } from 'crypto';

export async function GET() {
  // Get session identifier
  let sessionId: string;

  // In local-mode, use a fixed session ID (CSRF is exempt anyway for localhost)
  if (process.env.SESSION_TOKEN) {
    sessionId = 'local-session';
  } else {
    const supabase = await createServerSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    sessionId = session?.access_token?.slice(-16) ?? randomBytes(8).toString('hex');
  }

  const { token, nonce } = generateCsrfToken(sessionId);

  const response = NextResponse.json({ token });

  // Set HttpOnly cookie with nonce + session for server-side verification
  response.cookies.set(CSRF_COOKIE_NAME, `${nonce}:${sessionId}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60, // 1 hour
  });

  return response;
}
