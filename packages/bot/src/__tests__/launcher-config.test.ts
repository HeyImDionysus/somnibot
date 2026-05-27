/**
 * Launcher Config buildEnvVars Tests — V53 Phase 5 (Finding 5.3)
 *
 * Tests the env var generation for single-guild, multi-guild, and legacy fallback.
 * Function inlined here to avoid cross-package import (launcher is Electron).
 */
import { describe, it, expect } from 'vitest';

// Replicated from packages/launcher/src/main/config-store.ts
interface GuildEntry {
  discordGuildId: string;
  name: string;
  enabled: boolean;
}

interface LauncherConfig {
  discordToken: string;
  discordApplicationId: string;
  discordClientSecret: string;
  discordGuildId: string;
  guilds: GuildEntry[];
  supabaseUrl: string;
  supabaseSecretKey: string;
  supabasePublishableKey: string;
  firstRunComplete: boolean;
  lavalinkEnabled: boolean;
  lastPids: { bot: number | null; dashboard: number | null; lavalink: number | null };
}

function buildEnvVars(config: LauncherConfig, sessionToken: string): Record<string, string> {
  return {
    DISCORD_TOKEN: config.discordToken,
    DISCORD_APPLICATION_ID: config.discordApplicationId,
    DISCORD_CLIENT_SECRET: config.discordClientSecret,
    DISCORD_GUILD_ID: config.guilds.length > 0
      ? config.guilds.filter(g => g.enabled).map(g => g.discordGuildId).join(',')
      : config.discordGuildId,
    SUPABASE_URL: config.supabaseUrl,
    SUPABASE_SECRET_KEY: config.supabaseSecretKey,
    NEXT_PUBLIC_SUPABASE_URL: config.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: config.supabasePublishableKey,
    SESSION_TOKEN: sessionToken,
    PORT: '3456',
    HOSTNAME: '127.0.0.1',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3456',
    LAVALINK_HOST: 'localhost',
    LAVALINK_PORT: '2333',
    LAVALINK_PASSWORD: 'test-secure-password-1234',
    VALKEY_URL: 'redis://127.0.0.1:6379',
    NODE_ENV: 'production',
  };
}

function makeConfig(overrides: Partial<LauncherConfig> = {}): LauncherConfig {
  return {
    discordToken: 'test-token',
    discordApplicationId: 'app-123',
    discordClientSecret: 'secret-456',
    discordGuildId: 'legacy-guild-id',
    guilds: [],
    supabaseUrl: 'https://test.supabase.co',
    supabaseSecretKey: 'sb-secret',
    supabasePublishableKey: 'sb-pub',
    firstRunComplete: true,
    lavalinkEnabled: false,
    lastPids: { bot: null, dashboard: null, lavalink: null },
    ...overrides,
  };
}

describe('buildEnvVars', () => {
  it('sets all required Discord vars', () => {
    const env = buildEnvVars(makeConfig(), 'sess-token');
    expect(env.DISCORD_TOKEN).toBe('test-token');
    expect(env.DISCORD_APPLICATION_ID).toBe('app-123');
    expect(env.DISCORD_CLIENT_SECRET).toBe('secret-456');
  });

  it('falls back to legacy discordGuildId when guilds array is empty', () => {
    const env = buildEnvVars(makeConfig({ guilds: [] }), 'sess');
    expect(env.DISCORD_GUILD_ID).toBe('legacy-guild-id');
  });

  it('uses comma-separated enabled guild IDs for multi-guild', () => {
    const guilds: GuildEntry[] = [
      { discordGuildId: '111', name: 'Guild A', enabled: true },
      { discordGuildId: '222', name: 'Guild B', enabled: false },
      { discordGuildId: '333', name: 'Guild C', enabled: true },
    ];
    const env = buildEnvVars(makeConfig({ guilds }), 'sess');
    expect(env.DISCORD_GUILD_ID).toBe('111,333');
  });

  it('sets Supabase vars in both bot and dashboard formats', () => {
    const env = buildEnvVars(makeConfig(), 'sess');
    expect(env.SUPABASE_URL).toBe('https://test.supabase.co');
    expect(env.SUPABASE_SECRET_KEY).toBe('sb-secret');
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://test.supabase.co');
    expect(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe('sb-pub');
  });

  it('includes session token', () => {
    const env = buildEnvVars(makeConfig(), 'my-session-token');
    expect(env.SESSION_TOKEN).toBe('my-session-token');
  });

  it('sets Lavalink defaults', () => {
    const env = buildEnvVars(makeConfig(), 'sess');
    expect(env.LAVALINK_HOST).toBe('localhost');
    expect(env.LAVALINK_PORT).toBe('2333');
    expect(env.LAVALINK_PASSWORD).toBe('test-secure-password-1234');
  });

  it('sets NODE_ENV to production', () => {
    const env = buildEnvVars(makeConfig(), 'sess');
    expect(env.NODE_ENV).toBe('production');
  });

  it('dashboard runs on port 3456 by default', () => {
    const env = buildEnvVars(makeConfig(), 'sess');
    expect(env.PORT).toBe('3456');
    expect(env.HOSTNAME).toBe('127.0.0.1');
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3456');
  });

  it('with all guilds disabled, uses empty string (not legacy)', () => {
    const guilds: GuildEntry[] = [
      { discordGuildId: '111', name: 'Guild A', enabled: false },
    ];
    const env = buildEnvVars(makeConfig({ guilds }), 'sess');
    expect(env.DISCORD_GUILD_ID).toBe('');
  });
});
