import { cookies, headers } from 'next/headers';
import { createAdminSupabase } from '@/lib/supabase/admin';

const LOCAL_SESSION_COOKIE = 'somnibot-local-session';
const LOCAL_HOST_PATTERN = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/;

export interface LauncherLocalAuthContext {
  userId: string;
  discordId: string;
  guildId: string;
  configuredGuildIds: string[];
}

export type LauncherLocalAuthResult =
  | { kind: 'remote' }
  | { kind: 'authorized'; ctx: LauncherLocalAuthContext }
  | { kind: 'denied'; status: 401 | 403 | 503; message: string };

export async function resolveLauncherLocalAuth(): Promise<LauncherLocalAuthResult> {
  const sessionToken = process.env.SESSION_TOKEN;
  if (process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE !== '1' || !sessionToken) {
    return { kind: 'remote' };
  }

  const headerStore = await headers();
  const host = headerStore.get('host') ?? '';
  if (!LOCAL_HOST_PATTERN.test(host)) {
    return { kind: 'remote' };
  }

  const cookieStore = await cookies();
  if (cookieStore.get(LOCAL_SESSION_COOKIE)?.value !== sessionToken) {
    return { kind: 'denied', status: 401, message: 'Unauthorized' };
  }

  const configuredGuildIds = Array.from(new Set(
    (process.env.DISCORD_GUILD_ID ?? '')
      .split(',')
      .map((guildId) => guildId.trim())
      .filter(Boolean),
  ));
  if (configuredGuildIds.length === 0) {
    return { kind: 'denied', status: 503, message: 'Launcher guild configuration is unavailable' };
  }

  const headerGuildId = headerStore.get('x-guild-id')?.trim();
  if (headerGuildId && !configuredGuildIds.includes(headerGuildId)) {
    return { kind: 'denied', status: 403, message: 'Forbidden' };
  }
  const cookieGuildId = cookieStore.get('active_guild_id')?.value?.trim();
  const requestedGuildId = headerGuildId
    || (cookieGuildId && configuredGuildIds.includes(cookieGuildId) ? cookieGuildId : null)
    || configuredGuildIds[0]!;

  const admin = createAdminSupabase();
  const { data: guild, error } = await admin
    .from('guild')
    .select('id, owner_discord_id')
    .eq('id', requestedGuildId)
    .maybeSingle();

  if (error) {
    return { kind: 'denied', status: 503, message: 'Launcher guild state is unavailable' };
  }
  if (!guild?.id || !guild.owner_discord_id) {
    return { kind: 'denied', status: 403, message: 'Configured guild is not available' };
  }

  return {
    kind: 'authorized',
    ctx: {
      userId: 'launcher-local',
      discordId: guild.owner_discord_id,
      guildId: guild.id,
      configuredGuildIds,
    },
  };
}
