/**
 * POST /api/portal/auth — Customer portal authentication via Discord OAuth2.
 * GET  /api/portal/auth — Validate current session.
 *
 * Flow:
 *   1. Frontend redirects user to Discord authorize URL
 *   2. Discord redirects back with ?code=…
 *   3. Frontend POSTs { action: "login", code: "…" } here
 *   4. We exchange the code for an access token with Discord
 *   5. We call /users/@me to get the real Discord identity
 *   6. We match that against our customers table
 *   7. We issue a portal session token
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { randomBytes, createHash } from 'crypto';
import { rateLimits } from '@/lib/api/rate-limit';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';

const portalAuthSchema = z.object({
  action: z.literal('login'),
  code: z.string().min(1).max(512),
  redirect_uri: z.string().url().max(2048).optional(),
});

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Exchange a Discord OAuth2 authorization code for user identity.
 * Returns the Discord user object ({ id, username, ... }) or null on failure.
 */
async function exchangeCodeForUser(
  code: string,
  redirectUri: string,
): Promise<{ id: string; username: string } | null> {
  const clientId = process.env.DISCORD_APPLICATION_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  // Step 1: Exchange code for access token
  const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) return null;

  const tokenData = (await tokenRes.json()) as { access_token?: string };
  if (!tokenData.access_token) return null;

  // Step 2: Fetch the authenticated user's identity
  const userRes = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userRes.ok) return null;

  const user = (await userRes.json()) as { id: string; username: string };
  if (!user.id) return null;

  return user;
}

export async function POST(request: NextRequest) {
  // Rate limit: 10 attempts per 5 minutes per IP
  const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const rl = await rateLimits.portalAuth(clientIp);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many login attempts. Try again later.', retry_after: Math.ceil(rl.retryAfterMs / 1000) },
      { status: 429 },
    );
  }

  try {
    const parsed = await parseBody(request, portalAuthSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();

    {
      const code = body.code;

      // Determine the redirect URI (must match what the frontend used)
      const origin = request.headers.get('origin') || request.nextUrl.origin;
      const redirectUri = body.redirect_uri || `${origin}/portal`;

      // Exchange code for verified Discord identity
      const discordUser = await exchangeCodeForUser(code, redirectUri);
      if (!discordUser) {
        return NextResponse.json(
          { error: 'Discord authentication failed. Please try again.' },
          { status: 401 },
        );
      }

      // Find customer by verified Discord ID
      const { data: customer } = await admin
        .from('customers')
        .select('id, guild_id, discord_id')
        .eq('discord_id', discordUser.id)
        .limit(1)
        .single();

      if (!customer) {
        return NextResponse.json(
          { error: 'No account found for this Discord user.' },
          { status: 404 },
        );
      }

      // Create session
      const token = randomBytes(32).toString('hex');
      const tokenHash = hashToken(token);
      // I-4: Reduced from 30 days to 7 days. Long-lived tokens without rotation
      // increase the window for token theft. 7 days balances usability with security.
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      // V53 Phase 3 (1.9): Enforce max 3 concurrent sessions.
      // If limit reached, auto-revoke the oldest session(s).
      const MAX_CONCURRENT_SESSIONS = 3;
      const { data: activeSessions } = await admin
        .from('portal_sessions')
        .select('id, created_at')
        .eq('guild_id', customer.guild_id)
        .eq('customer_id', customer.id)
        .eq('revoked', false)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: true });

      if (activeSessions && activeSessions.length >= MAX_CONCURRENT_SESSIONS) {
        // Revoke oldest sessions to make room
        const toRevoke = activeSessions.slice(0, activeSessions.length - MAX_CONCURRENT_SESSIONS + 1);
        await admin
          .from('portal_sessions')
          .update({ revoked: true })
          .in('id', toRevoke.map((s) => s.id));
      }

      const { error } = await admin
        .from('portal_sessions')
        .insert({
          guild_id: customer.guild_id,
          customer_id: customer.id,
          token_hash: tokenHash,
          discord_id: discordUser.id,
          expires_at: expires.toISOString(),
          ip_address: clientIp,
          user_agent: request.headers.get('user-agent') || null,
        });

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      return NextResponse.json({
        success: true,
        data: { token, expires_at: expires.toISOString(), customer_id: customer.id },
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const token = request.headers.get('x-portal-token');
    if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 401 });

    const admin = createAdminSupabase();
    const tokenHash = hashToken(token);

    const { data: session } = await admin
      .from('portal_sessions')
      .select('*, customers(id, discord_id, email, discord_username)')
      .eq('token_hash', tokenHash)
      .eq('revoked', false)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });

    // Update last used
    await admin
      .from('portal_sessions')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', session.id);

    return NextResponse.json({
      success: true,
      data: {
        session_id: session.id,
        customer_id: session.customer_id,
        discord_id: session.discord_id,
        customer: (session as Record<string, unknown>).customers,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
