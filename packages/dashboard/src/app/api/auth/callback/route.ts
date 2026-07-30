import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { rateLimits } from '@/lib/api/rate-limit';
import { getClientIp } from '@/lib/api/client-ip';
import { requireBrowserSupabaseConfig } from '@/lib/supabase/runtime-config';

/**
 * Discord OAuth callback handler.
 * Supabase handles the token exchange — we just need to set cookies
 * and redirect to the dashboard.
 */
export async function GET(request: Request) {
  // V5 Audit P3-2: Rate-limit OAuth callbacks per IP.
  // Index 0 of X-Forwarded-For is the value the CLIENT sent, so rotating the
  // header bought a fresh bucket per request; getClientIp counts from the right.
  const clientIp = getClientIp(request);
  const rl = await rateLimits.authCallback(clientIp);
  if (rl.limited) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  // Validate `next` to prevent open redirects.
  // Only allow relative paths starting with "/" and block protocol-relative URLs ("//").
  const rawNext = searchParams.get('next') ?? '/dashboard';
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/dashboard';

  if (code) {
    const cookieStore = await cookies();
    const { url, publishableKey } = requireBrowserSupabaseConfig();
    const supabase = createServerClient(
      url,
      publishableKey,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options as Parameters<typeof cookieStore.set>[2]),
            );
          },
        },
      },
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Something went wrong — redirect to login
  return NextResponse.redirect(`${origin}/login?error=auth_callback_error`);
}
