/**
 * RBAC helper — resolves the current user's dashboard permissions.
 * Used by API routes and server components for authorization.
 */

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
 * Extract Discord ID from Supabase auth user metadata.
 */
function getDiscordId(user: { user_metadata?: Record<string, unknown> }): string | null {
  const meta = user.user_metadata;
  if (!meta) return null;
  return (meta.provider_id as string) || (meta.sub as string) || null;
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

  // Find the guild (single-guild architecture)
  const { data: guild } = await admin
    .from('guild')
    .select('id, owner_discord_id')
    .limit(1)
    .single();

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
    .eq('discord_id', discordId);

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
 * Require specific permission. Returns auth context or throws.
 */
export async function requirePermission(
  permission: DashboardPermission | null,
): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) throw new Error('Unauthorized');

  if (permission === null) return ctx;
  if (ctx.permissions.includes('dashboard.full_access')) return ctx;
  if (!ctx.permissions.includes(permission)) throw new Error('Forbidden');

  return ctx;
}
