/**
 * Centralized owner authorization guard for admin API routes.
 *
 * Every admin route MUST call `requireGuildOwner()` before performing
 * any data access. This ensures:
 * 1. The request has a valid Supabase auth session
 * 2. The authenticated user has a Discord ID
 * 3. That Discord ID matches the guild's `owner_discord_id`
 *
 * Returns the guild ID and discord ID on success, or a NextResponse error.
 */
import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { resolveLauncherLocalAuth } from '@/lib/api/launcher-local-auth';
import { auditDashboardAuthorizationDenial } from '@/lib/rbac-audit';
import { verifiedDiscordId } from '@/lib/verified-discord-identity';

export interface OwnerContext {
  userId: string;       // Supabase auth user ID
  discordId: string;    // Discord user ID
  guildId: string;      // Guild ID (snowflake)
}

type OwnerResult =
  | { ok: true; ctx: OwnerContext }
  | { ok: false; response: NextResponse };

type OwnerDenial = {
  readonly guildId: string | null;
  readonly actorId: string;
  readonly reason: string;
  readonly status: 401 | 403;
};

async function auditOwnerDenial(denial: OwnerDenial): Promise<void> {
  await auditDashboardAuthorizationDenial({
    guildId: denial.guildId,
    actorId: denial.actorId,
    permission: 'guild.owner',
    reason: denial.reason,
    status: denial.status,
  });
}

/**
 * Verify the caller is the authenticated guild owner.
 *
 * Usage in a route handler:
 * ```ts
 * const auth = await requireGuildOwner();
 * if (!auth.ok) return auth.response;
 * const { guildId, discordId } = auth.ctx;
 * ```
 */
export async function requireGuildOwner(): Promise<OwnerResult> {
  const localAuth = await resolveLauncherLocalAuth();
  if (localAuth.kind === 'authorized') {
    return {
      ok: true,
      ctx: {
        userId: localAuth.ctx.userId,
        discordId: localAuth.ctx.discordId,
        guildId: localAuth.ctx.guildId,
      },
    };
  }
  if (localAuth.kind === 'denied') {
    await auditOwnerDenial({ guildId: null, actorId: 'anonymous', reason: 'local_auth_denied', status: localAuth.status === 403 ? 403 : 401 });
    return {
      ok: false,
      response: NextResponse.json({ error: localAuth.message }, { status: localAuth.status }),
    };
  }

  // Step 1: Verify auth session
  const supabase = await createServerSupabase();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    await auditOwnerDenial({ guildId: null, actorId: 'anonymous', reason: 'missing_session', status: 401 });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Unauthorized — no valid session' },
        { status: 401 },
      ),
    };
  }

  // Step 2: Extract Discord ID from the immutable provider identity. Supabase
  // users may edit user_metadata themselves, so it is never authorization
  // evidence.
  const discordId = verifiedDiscordId(user);

  if (!discordId) {
    await auditOwnerDenial({ guildId: null, actorId: user.id, reason: 'missing_discord_identity', status: 401 });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Unauthorized — no Discord identity linked' },
        { status: 401 },
      ),
    };
  }

  // Step 3: Verify this Discord user owns at least one guild
  // V53 Phase 4 (4.3): Multi-guild support — select active guild from cookie/header
  const admin = createAdminSupabase();
  const { data: guilds } = await admin
    .from('guild')
    .select('id')
    .eq('owner_discord_id', discordId)
    .limit(1000);

  if (!guilds || guilds.length === 0) {
    await auditOwnerDenial({ guildId: null, actorId: discordId, reason: 'not_guild_owner', status: 403 });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Forbidden — you are not the guild owner' },
        { status: 403 },
      ),
    };
  }

  // Determine active guild: check x-guild-id header, then cookie, then first guild
  const { cookies, headers } = await import('next/headers');
  const headerStore = await headers();
  const cookieStore = await cookies();
  const headerGuildId = headerStore.get('x-guild-id');
  const cookieGuildId = cookieStore.get('active_guild_id')?.value;
  const requestedGuildId = headerGuildId ?? cookieGuildId;

  let activeGuild = guilds[0]!;
  if (requestedGuildId && guilds.some(g => g.id === requestedGuildId)) {
    activeGuild = guilds.find(g => g.id === requestedGuildId)!;
  } else if (requestedGuildId) {
    // V5 Audit [1.2]: Log when a user requests a guild ID they don't own.
    // Deny instead of falling back so admin actions cannot silently apply
    // to a different guild than the one selected in the dashboard.
    console.warn(
      `[requireGuildOwner] Guild probe: user ${discordId} requested guild ${requestedGuildId} ` +
      `but only owns [${guilds.map(g => g.id).join(', ')}].`,
    );
    await auditOwnerDenial({ guildId: requestedGuildId, actorId: discordId, reason: 'requested_guild_not_owned', status: 403 });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Forbidden — requested guild is not accessible' },
        { status: 403 },
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      userId: user.id,
      discordId,
      guildId: activeGuild.id,
    },
  };
}

/**
 * Lightweight auth check — verifies session only, no guild owner check.
 * Use for routes where any authenticated user should have access
 * (e.g., license validation by a customer via session).
 */
export async function requireAuth(): Promise<
  | { ok: true; userId: string; discordId: string | null; localGuildIds?: string[] }
  | { ok: false; response: NextResponse }
> {
  const localAuth = await resolveLauncherLocalAuth();
  if (localAuth.kind === 'authorized') {
    return {
      ok: true,
      userId: localAuth.ctx.userId,
      discordId: localAuth.ctx.discordId,
      localGuildIds: localAuth.ctx.configuredGuildIds,
    };
  }
  if (localAuth.kind === 'denied') {
    return {
      ok: false,
      response: NextResponse.json({ error: localAuth.message }, { status: localAuth.status }),
    };
  }

  const supabase = await createServerSupabase();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const discordId = verifiedDiscordId(user);

  return { ok: true, userId: user.id, discordId };
}

/**
 * Check whether first-run setup has been finalized.
 * Returns true if a `setup_completed_at` row exists in instance_settings.
 */
export async function isSetupComplete(): Promise<boolean> {
  const admin = createAdminSupabase();
  const { data } = await admin
    .from('instance_settings')
    .select('value')
    .eq('key', 'setup_completed_at')
    .maybeSingle();

  return !!data?.value;
}
