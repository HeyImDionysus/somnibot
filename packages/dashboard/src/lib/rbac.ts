/**
 * RBAC helper — resolves the current user's dashboard permissions.
 * Used by API routes and server components for authorization.
 *
 * V5 Audit §1.1 — requirePermission now throws typed AuthError with
 * proper HTTP status codes (401/403) instead of generic Error that
 * resulted in 500 responses.
 */

import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createServerSupabase } from '@/lib/supabase/server';
import type { DashboardPermission } from '@somnibot/shared';

export interface AuthContext {
  userId: string;
  discordId: string;
  guildId: string;
  isOwner: boolean;
  permissions: DashboardPermission[];
}

/**
 * Typed auth error with HTTP status code.
 * Route handlers can check `instanceof AuthError` to return proper responses.
 */
export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/**
 * Convert an AuthError (or any error) to a NextResponse.
 * Use in catch blocks to return proper 401/403 instead of 500.
 */
export function authErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
}

/**
 * Extract Discord ID from Supabase auth user metadata.
 */
function getDiscordId(user: { user_metadata?: Record<string, unknown> }): string | null {
  const meta = user.user_metadata;
  if (!meta) return null;
  return (meta.provider_id as string) || (meta.sub as string) || null;
}

interface GuildRow {
  id: string;
  owner_discord_id: string | null;
}

interface RoleAssignmentRow {
  guild_id: string;
}

function normalizeRows<T>(data: T[] | T | null | undefined): T[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

async function getRequestedGuildId(): Promise<string | null> {
  const headerStore = await headers();
  const headerGuildId = headerStore.get('x-guild-id')?.trim();
  if (headerGuildId) return headerGuildId;

  const cookieStore = await cookies();
  const cookieGuildId = cookieStore.get('active_guild_id')?.value?.trim();
  return cookieGuildId || null;
}

/**
 * Resolve full auth context including RBAC permissions for the current user.
 * Returns null if unauthenticated or no guild found.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const discordId = getDiscordId(user);
  if (!discordId) return null;

  const admin = createAdminSupabase();
  const requestedGuildId = await getRequestedGuildId();

  // V53-D2: Find the guild associated with this user's Discord ID.
  // Previous code used .limit(1).single() with no filter which would
  // return an arbitrary guild in a multi-guild deployment.  Now we
  // first try to match a guild where the user is the owner, then fall
  // back to the first guild where they have a member record.
  const { data: ownedGuildData } = await admin
    .from('guild')
    .select('id, owner_discord_id')
    .eq('owner_discord_id', discordId)
    .limit(1000);
  const ownedGuilds = normalizeRows(ownedGuildData as GuildRow[] | GuildRow | null);

  const requestedOwnedGuild = requestedGuildId
    ? ownedGuilds.find((g) => g.id === requestedGuildId) ?? null
    : null;

  if (requestedOwnedGuild) {
    return {
      userId: user.id,
      discordId,
      guildId: requestedOwnedGuild.id,
      isOwner: true,
      permissions: ['dashboard.full_access'],
    };
  }

  if (!requestedGuildId && ownedGuilds.length > 0) {
    const guild = ownedGuilds[0]!;
    return {
      userId: user.id,
      discordId,
      guildId: guild.id,
      isOwner: true,
      permissions: ['dashboard.full_access'],
    };
  }

  // V53-M3: If user doesn't own a guild, only fall back to a guild where
  // they have an explicit dashboard_user_roles assignment. Prevents scoping
  // to an arbitrary guild in multi-guild deployments.
  const { data: roleAssignmentData } = await admin
    .from('dashboard_user_roles')
    .select('guild_id')
    .eq('discord_id', discordId)
    .limit(1000);

  const assignedGuildIds = Array.from(
    new Set(
      normalizeRows(roleAssignmentData as RoleAssignmentRow[] | RoleAssignmentRow | null)
        .map((r) => r.guild_id)
        .filter(Boolean),
    ),
  );

  const selectedGuildId = requestedGuildId ?? assignedGuildIds[0] ?? null;

  if (!selectedGuildId) return null;

  if (requestedGuildId && !assignedGuildIds.includes(requestedGuildId)) {
    throw new AuthError('Forbidden', 403);
  }

  const { data: assignedGuild } = await admin
    .from('guild')
    .select('id, owner_discord_id')
    .eq('id', selectedGuildId)
    .single();

  const guild = assignedGuild as GuildRow | null;
  if (!guild) return null;

  const isOwner = guild.owner_discord_id === discordId;

  // Owner always has full access
  if (isOwner) {
    return {
      userId: user.id,
      discordId,
      guildId: guild.id,
      isOwner: true,
      permissions: ['dashboard.full_access'],
    };
  }

  // Look up user's dashboard roles
  const { data: userRoles } = await admin
    .from('dashboard_user_roles')
    .select('role_id, dashboard_roles(permissions)')
    .eq('guild_id', guild.id)
    .eq('discord_id', discordId)
    .limit(1000);

  const permissions = new Set<DashboardPermission>();
  if (userRoles) {
    for (const ur of userRoles) {
      const role = (ur as Record<string, unknown>).dashboard_roles as { permissions: DashboardPermission[] } | null;
      if (role?.permissions) {
        for (const perm of role.permissions) {
          permissions.add(perm);
        }
      }
    }
  }

  return {
    userId: user.id,
    discordId,
    guildId: guild.id,
    isOwner: false,
    permissions: Array.from(permissions),
  };
}

/**
 * Require specific permission. Returns auth context or throws AuthError.
 *
 * Throws AuthError(401) if unauthenticated, AuthError(403) if lacking permission.
 * Callers should catch with `authErrorResponse()` for proper HTTP status codes.
 */
export async function requirePermission(
  permission: DashboardPermission | null,
): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) throw new AuthError('Unauthorized', 401);

  if (permission === null) return ctx;
  if (ctx.permissions.includes('dashboard.full_access')) return ctx;
  if (!ctx.permissions.includes(permission)) throw new AuthError('Forbidden', 403);

  return ctx;
}
