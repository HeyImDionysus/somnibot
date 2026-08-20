import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { writeCommerceAudit } from '@/lib/commerce-audit';
import { getDiscordOAuthRuntimeConfig } from '@/lib/discord-runtime-config';

const DiscordTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
}).passthrough();

const DiscordUserSchema = z.object({
  id: z.string().min(1),
  username: z.string(),
}).passthrough();

const DISCORD_API = 'https://discord.com/api/v10';

function hashOccurrenceSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isProviderUnavailableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export type DiscordIdentityResult =
  | { kind: 'verified'; user: { id: string; username: string } }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

export async function exchangeCodeForUser(
  code: string,
  redirectUri: string,
): Promise<DiscordIdentityResult> {
  try {
    const { applicationId: clientId, clientSecret } = await getDiscordOAuthRuntimeConfig();
    if (!clientId || !clientSecret) return { kind: 'unavailable' };
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

    if (!tokenRes.ok) {
      return isProviderUnavailableStatus(tokenRes.status)
        ? { kind: 'unavailable' }
        : { kind: 'denied' };
    }

    const tokenParsed = DiscordTokenSchema.safeParse(await tokenRes.json());
    if (!tokenParsed.success) return { kind: 'unavailable' };

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenParsed.data.access_token}` },
    });

    if (!userRes.ok) {
      return isProviderUnavailableStatus(userRes.status)
        ? { kind: 'unavailable' }
        : { kind: 'denied' };
    }

    const userParsed = DiscordUserSchema.safeParse(await userRes.json());
    if (!userParsed.success) return { kind: 'unavailable' };

    return {
      kind: 'verified',
      user: { id: userParsed.data.id, username: userParsed.data.username },
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

type LoginDependencyCause =
  | 'provider_unavailable'
  | 'account_dependency'
  | 'session_dependency';

type LoginDependencyFailure = {
  readonly guildId: string;
  readonly code: string;
  readonly cause: LoginDependencyCause;
  readonly actorId?: string;
  readonly occurrenceId?: string;
};

export async function loginDependencyFailure(
  admin: SupabaseClient,
  failure: LoginDependencyFailure,
): Promise<NextResponse> {
  await writeCommerceAudit(admin, {
    guildId: failure.guildId,
    actorType: 'user',
    actorId: failure.actorId ?? 'unknown',
    action: 'portal.login_failed',
    targetType: 'portal_session',
    details: { cause: failure.cause },
    correlationId: `portal.login:${hashOccurrenceSecret(failure.code)}`,
    occurrenceKey: `portal.login_failed:${failure.cause}:${failure.occurrenceId ?? hashOccurrenceSecret(failure.code)}`,
    success: false,
  });
  return NextResponse.json(
    { error: 'Sign-in is temporarily unavailable. Please try again.' },
    { status: 503, headers: { 'Retry-After': '30' } },
  );
}
