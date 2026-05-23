/**
 * Config Store — persistent credential storage using electron-store + safeStorage.
 *
 * Saves to:
 *   Windows:  %APPDATA%/SomniBot/config.json
 *   macOS:    ~/Library/Application Support/SomniBot/config.json
 *   Linux:    ~/.config/somnibot/config.json
 *
 * Sensitive fields (tokens, secrets) are encrypted with the OS keychain
 * via Electron's safeStorage API. Non-sensitive fields (window bounds,
 * flags) are stored in plain JSON.
 *
 * Only stores credentials — all bot/feature configuration lives in Supabase.
 */

import Store from 'electron-store';
import { safeStorage } from 'electron';

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
  clearInvalidConfig: true,
  // V5 Audit [10.1]: Removed hardcoded encryptionKey. Sensitive fields are
  // now encrypted individually via safeStorage (OS keychain).
});

/**
 * Fields that contain secrets and must be encrypted via safeStorage.
 * All other fields are stored as plain JSON (non-sensitive).
 */
const SENSITIVE_KEYS: ReadonlySet<keyof LauncherConfig> = new Set([
  'discordToken',
  'discordClientSecret',
  'supabaseSecretKey',
]);

/**
 * Encrypt a string using the OS keychain (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux). Falls back to plaintext if safeStorage is unavailable
 * (e.g., CI, headless Linux without a keyring).
 */
function encryptSensitive(value: string): string {
  if (!value) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(value).toString('base64');
    }
  } catch {
    // safeStorage not available — store plaintext (same as old behavior)
  }
  return value;
}

/**
 * Decrypt a string that was encrypted via encryptSensitive().
 * Handles both encrypted (base64 of safeStorage buffer) and legacy plaintext values.
 */
function decryptSensitive(stored: string): string {
  if (!stored) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = Buffer.from(stored, 'base64');
      return safeStorage.decryptString(buf);
    }
  } catch {
    // If decryption fails, the value is likely a legacy plaintext string
    // (from before safeStorage migration). Return as-is.
  }
  return stored;
}

function getSensitive(key: keyof LauncherConfig): string {
  const raw = store.get(key, '') as string;
  return decryptSensitive(raw);
}

function setSensitive(key: keyof LauncherConfig, value: string): void {
  store.set(key, encryptSensitive(value));
}

export function getConfig(): LauncherConfig {
  return {
    discordToken: getSensitive('discordToken'),
    discordApplicationId: store.get('discordApplicationId', ''),
    discordClientSecret: getSensitive('discordClientSecret'),
    discordGuildId: store.get('discordGuildId', ''),
    guilds: store.get('guilds', []),
    supabaseUrl: store.get('supabaseUrl', ''),
    supabaseSecretKey: getSensitive('supabaseSecretKey'),
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
      if (SENSITIVE_KEYS.has(key as keyof LauncherConfig) && typeof value === 'string') {
        setSensitive(key as keyof LauncherConfig, value);
      } else {
        store.set(key as keyof LauncherConfig, value);
      }
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
