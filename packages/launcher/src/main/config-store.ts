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

export interface LauncherConfig {
  // ── Discord (required) ──
  discordToken: string;
  discordApplicationId: string;
  discordClientSecret: string;
  discordGuildId: string;

  // ── Supabase (required) ──
  supabaseUrl: string;
  supabaseSecretKey: string;
  supabasePublishableKey: string;

  // ── UI state ──
  windowBounds?: { width: number; height: number; x?: number; y?: number };
}

const DEFAULTS: LauncherConfig = {
  discordToken: '',
  discordApplicationId: '',
  discordClientSecret: '',
  discordGuildId: '',
  supabaseUrl: '',
  supabaseSecretKey: '',
  supabasePublishableKey: '',
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
    supabaseUrl: store.get('supabaseUrl', ''),
    supabaseSecretKey: store.get('supabaseSecretKey', ''),
    supabasePublishableKey: store.get('supabasePublishableKey', ''),
    windowBounds: store.get('windowBounds'),
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
    DISCORD_GUILD_ID: config.discordGuildId,

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
