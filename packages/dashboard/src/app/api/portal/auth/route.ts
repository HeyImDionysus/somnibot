/**
 * POST /api/portal/auth — Customer portal authentication.
 * GET  /api/portal/auth — Validate current session.
 *
 * Existing dashboard sessions are exchanged directly for a guild-scoped portal
 * session. Buyers without a dashboard session can still use Discord OAuth2:
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
import { randomBytes, createHash, randomUUID } from 'crypto';
import { rateLimits } from '@/lib/api/rate-limit';
import { getClientIp } from '@/lib/api/client-ip';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { apiServerError } from '@/lib/api/response';
import { writeCommerceAudit } from '@/lib/commerce-audit';
import {
  exchangeCodeForUser,
  loginDependencyFailure,
} from '@/lib/api/portal-login-dependency';
import { requireAuth } from '@/lib/api/require-owner';

const portalGuildIdSchema = z.string().min(1).max(64);
const portalAuthSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('login'),
    code: z.string().min(1).max(512),
    // The target guild whose store the buyer is logging into. A Discord identity can
    // be a customer in many guilds (customers is UNIQUE(discord_id, guild_id)), so the
    // session MUST be scoped to one guild — otherwise the login binds an arbitrary,
    // possibly wrong, tenant.
    guild_id: portalGuildIdSchema,
    redirect_uri: z.string().url().max(2048).optional(),
  }),
  z.object({
    action: z.literal('dashboard_session'),
    guild_id: portalGuildIdSchema,
  }),
]);
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
  try {
    const clientIp = getClientIp(request);
    const ipLimit = await rateLimits.portalAuth(clientIp);
    if (ipLimit.limited) {
      return NextResponse.json(
        {
          error: 'Too many login attempts. Try again later.',
          retry_after: Math.ceil(ipLimit.retryAfterMs / 1000),
        },
        { status: 429 },
      );
    }
    const parsed = await parseBody(request, portalAuthSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const dashboardOccurrenceId = body.action === 'dashboard_session' ? randomUUID() : undefined;
    const admin = createAdminSupabase();

    {
      let code: string;
      let discordUser: { id: string };

      if (body.action === 'dashboard_session') {
        const origin = request.headers.get('origin');
        const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim();
        if (origin !== request.nextUrl.origin || contentType !== 'application/json') {
          await writeCommerceAudit(admin, {
            guildId: body.guild_id,
            actorType: 'user',
            actorId: 'anonymous',
            action: 'portal.login_denied',
            targetType: 'portal_session',
            details: { reason: 'invalid_request_origin', ipAddress: clientIp },
            success: false,
          });
          return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
        }
        const auth = await requireAuth();
        if (!auth.ok) {
          await writeCommerceAudit(admin, {
            guildId: body.guild_id,
            actorType: 'user',
            actorId: 'anonymous',
            action: 'portal.login_denied',
            targetType: 'portal_session',
            details: { reason: 'missing_dashboard_session', ipAddress: clientIp },
            success: false,
          });
          return auth.response;
        }
        if (auth.localGuildIds && !auth.localGuildIds.includes(body.guild_id)) {
          await writeCommerceAudit(admin, {
            guildId: body.guild_id,
            actorType: 'user',
            actorId: auth.userId,
            action: 'portal.login_denied',
            targetType: 'portal_session',
            details: { reason: 'launcher_guild_out_of_scope', ipAddress: clientIp },
            success: false,
          });
          return NextResponse.json(
            { error: 'This server is not configured for the local launcher session.' },
            { status: 403 },
          );
        }
        const rl = await rateLimits.portalDashboardSession(auth.userId, clientIp);
        if (rl.limited) {
          return NextResponse.json(
            { error: 'Too many portal session requests. Try again later.', retry_after: Math.ceil(rl.retryAfterMs / 1000) },
            { status: 429 },
          );
        }
        if (!auth.discordId) {
          await writeCommerceAudit(admin, {
            guildId: body.guild_id,
            actorType: 'user',
            actorId: auth.userId,
            action: 'portal.login_denied',
            targetType: 'portal_session',
            details: { reason: 'missing_verified_discord_identity', ipAddress: clientIp },
            success: false,
          });
          return NextResponse.json(
            { error: 'Authenticated account has no Discord identity linked.' },
            { status: 401 },
          );
        }
        code = `dashboard-session:${auth.userId}:${body.guild_id}`;
        discordUser = { id: auth.discordId };
      } else {
        code = body.code;

        // Determine the redirect URI (must match what the frontend used)
        const origin = request.headers.get('origin') || request.nextUrl.origin;
        const redirectUri = body.redirect_uri || `${origin}/portal`;

        // Exchange code for verified Discord identity
        const identity = await exchangeCodeForUser(code, redirectUri);
        if (identity.kind === 'unavailable') {
          return loginDependencyFailure(
            admin,
            { guildId: body.guild_id, code, cause: 'provider_unavailable' },
          );
        }
        if (identity.kind === 'denied') {
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
        discordUser = identity.user;
      }

      // Find the customer by verified Discord ID SCOPED TO THE TARGET GUILD.
      // (customers is UNIQUE(discord_id, guild_id) — an unscoped lookup bound the
      // session to an arbitrary guild for a buyer who is a customer in more than one.)
      const { data: customer, error: customerError } = await admin
        .from('customers')
        .select('id, guild_id, discord_id')
        .eq('guild_id', body.guild_id)
        .eq('discord_id', discordUser.id)
        .maybeSingle();

      if (customerError) {
        return loginDependencyFailure(
          admin,
          {
            guildId: body.guild_id,
            code,
            cause: 'account_dependency',
            actorId: discordUser.id,
            occurrenceId: dashboardOccurrenceId,
          },
        );
      }

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
      const { data: portalConfig, error: portalConfigError } = await admin
        .from('guild_config')
        .select('portal_session_ttl_ms')
        .eq('guild_id', customer.guild_id)
        .maybeSingle();
      if (portalConfigError) {
        return loginDependencyFailure(
          admin,
          {
            guildId: body.guild_id,
            code,
            cause: 'account_dependency',
            actorId: discordUser.id,
            occurrenceId: dashboardOccurrenceId,
          },
        );
      }
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

      const MAX_CONCURRENT_SESSIONS = 3;
      const { data: issuedSessionId, error } = await admin.rpc('issue_portal_session_atomic', {
        p_guild_id: customer.guild_id,
        p_customer_id: customer.id,
        p_token_hash: tokenHash,
        p_discord_id: discordUser.id,
        p_expires_at: expires.toISOString(),
        p_ip_address: clientIp,
        p_user_agent: request.headers.get('user-agent') || null,
        p_max_sessions: MAX_CONCURRENT_SESSIONS,
      });

      if (error || typeof issuedSessionId !== 'string') {
        return loginDependencyFailure(
          admin,
          {
            guildId: body.guild_id,
            code,
            cause: 'session_dependency',
            actorId: discordUser.id,
            occurrenceId: dashboardOccurrenceId,
          },
        );
      }

      // Auditable state change: a portal session was issued for this buyer.
      await writeCommerceAudit(admin, {
        guildId: customer.guild_id,
        actorType: 'user',
        actorId: discordUser.id,
        action: 'portal.login_succeeded',
        targetType: 'portal_session',
        targetId: issuedSessionId,
        occurrenceKey: `portal.login_succeeded:${issuedSessionId}`,
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
        guild_id: session.guild_id,
        discord_id: session.discord_id,
        customer: (session as { customers?: unknown }).customers ?? null,
      },
    });
  } catch (e) {
    return apiServerError(e, 'GET /api/portal/auth');
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const token = request.headers.get('x-portal-token');
    if (!token) {
      return NextResponse.json({ error: 'Portal session required.' }, { status: 401 });
    }

    const tokenHash = hashToken(token);
    const admin = createAdminSupabase();
    const { data: revokedRows, error: sessionError } = await admin.rpc(
      'revoke_portal_session_atomic',
      { p_token_hash: tokenHash },
    );

    if (sessionError) return apiServerError(sessionError, 'portal/auth/logout');
    const session = Array.isArray(revokedRows) ? revokedRows[0] : revokedRows;
    if (!session) {
      return NextResponse.json({ error: 'Portal session is invalid or expired.' }, { status: 401 });
    }

    await writeCommerceAudit(admin, {
      guildId: session.guild_id,
      actorType: 'user',
      actorId: session.discord_id,
      action: 'portal.logout_succeeded',
      targetType: 'portal_session',
      targetId: session.id,
      occurrenceKey: `portal.logout_succeeded:${session.id}`,
      details: { customerId: session.customer_id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return apiServerError(error, 'portal/auth/logout');
  }
}
