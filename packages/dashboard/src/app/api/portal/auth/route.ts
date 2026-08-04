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
import { getClientIp } from '@/lib/api/client-ip';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { dbError, apiServerError } from '@/lib/api/response';
import { writeCommerceAudit } from '@/lib/commerce-audit';

const portalAuthSchema = z.object({
  action: z.literal('login'),
  code: z.string().min(1).max(512),
  // The target guild whose store the buyer is logging into. A Discord identity can
  // be a customer in many guilds (customers is UNIQUE(discord_id, guild_id)), so the
  // session MUST be scoped to one guild — otherwise the login binds an arbitrary,
  // possibly wrong, tenant.
  guild_id: z.string().min(1).max(64),
  redirect_uri: z.string().url().max(2048).optional(),
});


const DiscordTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
}).passthrough();

const DiscordUserSchema = z.object({
  id: z.string().min(1),
  username: z.string(),
}).passthrough();

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

  const tokenRaw = await tokenRes.json();
  const tokenParsed = DiscordTokenSchema.safeParse(tokenRaw);
  if (!tokenParsed.success) return null;

  // Step 2: Fetch the authenticated user's identity
  const userRes = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${tokenParsed.data.access_token}` },
  });

  if (!userRes.ok) return null;

  const userRaw = await userRes.json();
  const userParsed = DiscordUserSchema.safeParse(userRaw);
  if (!userParsed.success) return null;

  return { id: userParsed.data.id, username: userParsed.data.username };
}

export async function POST(request: NextRequest) {
  // Rate limit: 10 attempts per 5 minutes per IP.
  //
  // This one mattered twice over. The old index-0 read let an attacker rotate
  // X-Forwarded-For for a fresh bucket on every login attempt, defeating the
  // brute-force limit outright — and the same value is persisted as
  // `portal_sessions.ip_address` and into the commerce audit trail, so a forged
  // header wrote attacker-chosen addresses into the record used to investigate
  // account takeover. Both are fixed by counting from the right.
  const clientIp = getClientIp(request);
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
        // Auditable refusal: OAuth exchange / identity lookup failed.
        await writeCommerceAudit(admin, {
          guildId: body.guild_id,
          actorType: 'user',
          actorId: 'unknown',
          action: 'portal.login_denied',
          targetType: 'portal_session',
          details: { reason: 'discord_auth_failed', ipAddress: clientIp },
          success: false,
        });
        return NextResponse.json(
          { error: 'Discord authentication failed. Please try again.' },
          { status: 401 },
        );
      }

      // Find the customer by verified Discord ID SCOPED TO THE TARGET GUILD.
      // (customers is UNIQUE(discord_id, guild_id) — an unscoped lookup bound the
      // session to an arbitrary guild for a buyer who is a customer in more than one.)
      const { data: customer } = await admin
        .from('customers')
        .select('id, guild_id, discord_id')
        .eq('guild_id', body.guild_id)
        .eq('discord_id', discordUser.id)
        .maybeSingle();

      if (!customer) {
        // Auditable refusal: verified identity is not a customer in this guild.
        await writeCommerceAudit(admin, {
          guildId: body.guild_id,
          actorType: 'user',
          actorId: discordUser.id,
          action: 'portal.login_denied',
          targetType: 'portal_session',
          details: { reason: 'no_account', discordId: discordUser.id, ipAddress: clientIp },
          success: false,
        });
        return NextResponse.json(
          { error: "No account found for this Discord user in this server's store." },
          { status: 404 },
        );
      }

      // Guild-scoped portal policy. The migration constrains this value; keep
      // the runtime fallback bounded so a stale/malformed row can never create
      // an effectively permanent session.
      const { data: portalConfig } = await admin
        .from('guild_config')
        .select('portal_session_ttl_ms')
        .eq('guild_id', customer.guild_id)
        .maybeSingle();
      const configuredTtl = Number(portalConfig?.portal_session_ttl_ms);
      const sessionTtlMs = Number.isSafeInteger(configuredTtl)
        && configuredTtl >= 3_600_000
        && configuredTtl <= 2_592_000_000
        ? configuredTtl
        : 604_800_000;

      // Create session
      const token = randomBytes(32).toString('hex');
      const tokenHash = hashToken(token);
      const expires = new Date(Date.now() + sessionTtlMs);

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
        .order('created_at', { ascending: true })
        .limit(500);

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

      if (error) return dbError(error, 'portal/auth');

      // Auditable state change: a portal session was issued for this buyer.
      await writeCommerceAudit(admin, {
        guildId: customer.guild_id,
        actorType: 'user',
        actorId: discordUser.id,
        action: 'portal.login_succeeded',
        targetType: 'portal_session',
        targetId: customer.id,
        details: { discordId: discordUser.id, customerId: customer.id, ipAddress: clientIp },
      });

      return NextResponse.json({
        success: true,
        data: { token, expires_at: expires.toISOString(), customer_id: customer.id },
      });
    }
  } catch (e) {
    return apiServerError(e, 'POST /api/portal/auth');
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
        customer: (session as { customers?: unknown }).customers ?? null,
      },
    });
  } catch (e) {
    return apiServerError(e, 'GET /api/portal/auth');
  }
}
