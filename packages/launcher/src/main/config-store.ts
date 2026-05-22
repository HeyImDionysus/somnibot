/**
 * Config Store — persistent credential storage using electron-store.
 *
 * Saves to:
 *   Windows:  %APPDATA%/SomniBot/config.json
 *   macOS:    ~/Library/Application Support/SomniBot/config.json
 *   Linux:    ~/.config/somnibot/config.json
 *
 * Only stores credentials — all bot/feature configuration lives in Supabase.
 */

import Store from 'electron-store';

/** V53 Phase 4 (4.3.3): Per-guild config for multi-guild support */
export interface GuildEntry {
  discordGuildId: string;
  name: string;
  enabled: boolean;
}

export interface LauncherConfig {
  // ── Discord (required) ──
  discordToken: string;
  discordApplicationId: string;
  discordClientSecret: string;
  /** @deprecated Use `guilds` array for multi-guild. Kept for migration. */
  discordGuildId: string;
  /** V53 Phase 4: Multi-guild support. If empty, falls back to discordGuildId. */
  guilds: GuildEntry[];

  // ── Supabase (required) ──
  supabaseUrl: string;
  supabaseSecretKey: string;
  supabasePublishableKey: string;

  // ── UI state ──
  windowBounds?: { width: number; height: number; x?: number; y?: number };

  // ── Phase 6: First-run onboarding ──
  firstRunComplete: boolean;

  // ── Phase 6: Lavalink management ──
  lavalinkEnabled: boolean;

  // ── Phase 6: Stale process tracking (PIDs from last run) ──
  lastPids: { bot: number | null; dashboard: number | null; lavalink: number | null };
}

const DEFAULTS: LauncherConfig = {
  discordToken: '',
  discordApplicationId: '',
  discordClientSecret: '',
  discordGuildId: '',
  guilds: [],
  supabaseUrl: '',
  supabaseSecretKey: '',
  supabasePublishableKey: '',
  firstRunComplete: false,
  lavalinkEnabled: false,
  lastPids: { bot: null, dashboard: null, lavalink: null },
};

const store = new Store<LauncherConfig>({
  name: 'config',
  defaults: DEFAULTS,
  encryptionKey: 'somnibot-launcher-v1', // Basic obfuscation — not a security boundary
  clearInvalidConfig: true,
});

export function getConfig(): LauncherConfig {
  return {
    discordToken: store.get('discordToken', ''),
    discordApplicationId: store.get('discordApplicationId', ''),
    discordClientSecret: store.get('discordClientSecret', ''),
    discordGuildId: store.get('discordGuildId', ''),
    guilds: store.get('guilds', []),
    supabaseUrl: store.get('supabaseUrl', ''),
    supabaseSecretKey: store.get('supabaseSecretKey', ''),
    supabasePublishableKey: store.get('supabasePublishableKey', ''),
    windowBounds: store.get('windowBounds'),
    firstRunComplete: store.get('firstRunComplete', false),
    lavalinkEnabled: store.get('lavalinkEnabled', false),
    lastPids: store.get('lastPids', { bot: null, dashboard: null, lavalink: null }),
  };
}

export function saveConfig(config: Partial<LauncherConfig>): void {
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) {
      store.set(key as keyof LauncherConfig, value);
    }
  }
}

export function clearConfig(): void {
  store.clear();
}

/**
 * Build the full env var object for spawning bot + dashboard processes.
 */
export function buildEnvVars(
  config: LauncherConfig,
  sessionToken: string,
): Record<string, string> {
  return {
    // Discord
    DISCORD_TOKEN: config.discordToken,
    DISCORD_APPLICATION_ID: config.discordApplicationId,
    DISCORD_CLIENT_SECRET: config.discordClientSecret,
    // V53 Phase 4: Pass all enabled guild IDs (comma-separated), with legacy fallback
    DISCORD_GUILD_ID: config.guilds.length > 0
      ? config.guilds.filter(g => g.enabled).map(g => g.discordGuildId).join(',')
      : config.discordGuildId,

    // Supabase — bot format
    SUPABASE_URL: config.supabaseUrl,
    SUPABASE_SECRET_KEY: config.supabaseSecretKey,

    // Supabase — dashboard format
    NEXT_PUBLIC_SUPABASE_URL: config.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: config.supabasePublishableKey,

    // Dashboard local-mode auth
    SESSION_TOKEN: sessionToken,

    // Dashboard binding
    PORT: '3456',
    HOSTNAME: '127.0.0.1',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3456',

    // Lavalink defaults
    LAVALINK_HOST: 'localhost',
    LAVALINK_PORT: '2333',
    LAVALINK_PASSWORD: 'YOUR_LAVALINK_PASSWORD',

    // Valkey defaults
    VALKEY_URL: 'redis://127.0.0.1:6379',

    // Production mode
    NODE_ENV: 'production',
  };
}
