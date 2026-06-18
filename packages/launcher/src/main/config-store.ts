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
import { randomBytes } from 'crypto';
import { getLavalinkPassword } from './lavalink-manager.js';
import { buildRuntimeEnvVars, type RuntimeMode } from './runtime-profile.js';

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
  /** Direct Postgres connection URL — required for running DB migrations. */
  supabaseDbPassword: string;
  /** Optional Supabase Management API token for auth-provider setup. */
  supabaseAccessToken: string;
  /** Operator confirmation that Discord auth provider and callback allow-list are configured manually. */
  supabaseDiscordAuthProviderConfigured: boolean;

  // ── UI state ──
  windowBounds?: { width: number; height: number; x?: number; y?: number };

  // ── Runtime networking ──
  runtimeMode: RuntimeMode;
  publicCallbackBaseUrl: string;
  vpsDomain: string;
  vpsSshHost: string;
  vpsSshUser: string;
  vpsDeployPath: string;
  tailscaleAuthKey?: string;

  // ── Phase 6: First-run onboarding ──
  firstRunComplete: boolean;

  // ── Phase 6: Lavalink management ──
  lavalinkEnabled: boolean;

  // ── Phase 6: Stale process tracking (PIDs from last run) ──
  lastPids: { bot: number | null; dashboard: number | null; lavalink: number | null; valkey: number | null };
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
  supabaseDbPassword: '',
  supabaseAccessToken: '',
  supabaseDiscordAuthProviderConfigured: false,
  runtimeMode: 'regular-local',
  publicCallbackBaseUrl: '',
  vpsDomain: '',
  vpsSshHost: '',
  vpsSshUser: '',
  vpsDeployPath: '',
  tailscaleAuthKey: '',
  firstRunComplete: false,
  lavalinkEnabled: false,
  lastPids: { bot: null, dashboard: null, lavalink: null, valkey: null },
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
  'supabaseDbPassword',
  'supabaseAccessToken',
  'tailscaleAuthKey',
]);

/**
 * Encrypt a string using the OS keychain (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux). Falls back to plaintext if safeStorage is unavailable
 * (e.g., CI, headless Linux without a keyring).
 */
// V5 Audit §10.5 — Track whether we've already warned about safeStorage
let _safeStorageWarned = false;

function encryptSensitive(value: string): string {
  if (!value) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(value).toString('base64');
    }
  } catch {
    // safeStorage threw — treat as unavailable
  }
  // V5 Audit §10.5 — Warn loudly when falling back to plaintext storage
  if (!_safeStorageWarned) {
    _safeStorageWarned = true;
    console.warn(
      '[ConfigStore] WARNING: OS keychain (safeStorage) is not available. ' +
      'Sensitive credentials will be stored in plaintext. ' +
      'On Linux, install a keyring daemon (gnome-keyring, kwallet, or keepassxc) ' +
      'to enable encrypted credential storage.',
    );
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
    supabaseDbPassword: getSensitive('supabaseDbPassword'),
    supabaseAccessToken: getSensitive('supabaseAccessToken'),
    supabaseDiscordAuthProviderConfigured: store.get('supabaseDiscordAuthProviderConfigured', false),
    windowBounds: store.get('windowBounds'),
    runtimeMode: store.get('runtimeMode', 'regular-local'),
    publicCallbackBaseUrl: store.get('publicCallbackBaseUrl', ''),
    vpsDomain: store.get('vpsDomain', ''),
    vpsSshHost: store.get('vpsSshHost', ''),
    vpsSshUser: store.get('vpsSshUser', ''),
    vpsDeployPath: store.get('vpsDeployPath', ''),
    tailscaleAuthKey: getSensitive('tailscaleAuthKey'),
    firstRunComplete: store.get('firstRunComplete', false),
    lavalinkEnabled: store.get('lavalinkEnabled', false),
    lastPids: store.get('lastPids', { bot: null, dashboard: null, lavalink: null, valkey: null }),
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
/**
 * Build SUPABASE_DB_URL env entry from the project URL + database password.
 * Returns an empty object when either value is missing or the ref can't be extracted.
 */
function buildDbUrlEnv(supabaseUrl: string, dbPassword: string): Record<string, string> {
  if (!dbPassword || !supabaseUrl) return {};
  const ref = supabaseUrl.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (!ref) return {};
  return {
    SUPABASE_DB_URL: `postgresql://postgres.${ref}:${encodeURIComponent(dbPassword)}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
  };
}

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
    SUPABASE_ACCESS_TOKEN: config.supabaseAccessToken,
    SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED: config.supabaseDiscordAuthProviderConfigured ? 'true' : 'false',

    // Supabase — dashboard format
    NEXT_PUBLIC_SUPABASE_URL: config.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: config.supabasePublishableKey,

    // Dashboard local-mode auth
    // V10 Audit §12: Pass token via file to avoid /proc/environ exposure.
    // The dashboard reads SESSION_TOKEN_FILE in instrumentation.ts.
    // Fall back to env var for backward compatibility.
    SESSION_TOKEN: sessionToken,

    // Security — CSRF protection, session signing, and internal webhook replay.
    // Generated once per launcher session. Local-mode is CSRF-exempt,
    // but these are still required so the dashboard env schema validates
    // and so cloud-deploy settings pages work if configured.
    CSRF_SECRET: randomBytes(32).toString('hex'),
    NEXTAUTH_SECRET: randomBytes(32).toString('hex'),
    WEBHOOK_REPLAY_SECRET: randomBytes(32).toString('hex'),

    // Runtime networking: operator dashboard URL and public callback base
    // are intentionally separate. Regular local keeps the launcher dashboard
    // on localhost while public providers may call back through Tailscale
    // Funnel. VPS mode uses the VPS HTTPS domain for both.
    ...buildRuntimeEnvVars(config),

    // Lavalink defaults
    // V7 Audit §9.8: Use the same password that was written to application.yml.
    // getLavalinkPassword() is the single source of truth — resolves from
    // LAVALINK_PASSWORD env var or a random per-launch hex, and caches the result.
    // Always pass a valid password — BotEnvSchema requires min 8 chars even
    // when Lavalink is disabled (the bot still validates all env vars at startup).
    LAVALINK_PASSWORD: getLavalinkPassword(),

    // Database — direct Postgres access for migrations.
    // Construct the connection URL from the project ref + user-supplied password.
    ...buildDbUrlEnv(config.supabaseUrl, config.supabaseDbPassword),

    // Production mode
    NODE_ENV: 'production',
  };
}
