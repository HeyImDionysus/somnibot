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
import { buildRuntimeEnvVars, getRuntimeHolderId, type RuntimeMode } from './runtime-profile.js';
import { buildDbUrlEnv } from './supabase-db-url.js';

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

  // ── PayPal store/webhook (required for store payments) ──
  paypalClientId: string;
  paypalClientSecret: string;
  paypalWebhookId: string;
  paypalWebhookProofKey: string;
  paypalSandbox: boolean;

  // ── Persisted VPS runtime secrets ──
  // Generated once, encrypted locally, and synced with the rest of the
  // instance credentials so retries, redeploys, and machine changes reuse the
  // same service generation instead of splitting old/new containers.
  vpsCsrfSecret?: string;
  vpsNextAuthSecret?: string;
  vpsWebhookReplaySecret?: string;
  vpsValkeyPassword?: string;
  vpsLavalinkPassword?: string;

  // ── UI state ──
  windowBounds?: { width: number; height: number; x?: number; y?: number };

  // ── Runtime networking ──
  runtimeMode: RuntimeMode;
  /** Last runtime that completed its full readiness proof; UI selection alone never changes this. */
  lastSuccessfulRuntimeMode?: RuntimeMode;
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
  paypalClientId: '',
  paypalClientSecret: '',
  paypalWebhookId: '',
  paypalWebhookProofKey: '',
  paypalSandbox: true,
  vpsCsrfSecret: '',
  vpsNextAuthSecret: '',
  vpsWebhookReplaySecret: '',
  vpsValkeyPassword: '',
  vpsLavalinkPassword: '',
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
  'paypalClientSecret',
  'paypalWebhookId',
  'paypalWebhookProofKey',
  'vpsCsrfSecret',
  'vpsNextAuthSecret',
  'vpsWebhookReplaySecret',
  'vpsValkeyPassword',
  'vpsLavalinkPassword',
  'tailscaleAuthKey',
]);

/**
 * Encrypt a string using the OS keychain (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux). Falls back to plaintext if safeStorage is unavailable
 * (e.g., CI, headless Linux without a keyring).
 */
// V5 Audit §10.5 — Track whether we've already warned about safeStorage
let _safeStorageWarned = false;

/**
 * [infrastructure-launcher] Keychain-failure audit hook. When the OS keychain
 * (safeStorage) is unavailable and we fall back to plaintext credential
 * storage, we notify this listener (once) so the main process can write a
 * durable audit_logs row — a plaintext-credential fallback is a security-
 * relevant degradation that must be observable, not just a console warning.
 */
let _keychainFallbackListener: (() => void) | undefined;

export function setKeychainFallbackListener(listener: () => void): void {
  _keychainFallbackListener = listener;
}

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
    // Fire the durable-audit hook once per process for the degradation.
    try {
      _keychainFallbackListener?.();
    } catch {
      // Audit is best-effort — never let it break credential storage.
    }
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
    paypalClientId: store.get('paypalClientId', ''),
    paypalClientSecret: getSensitive('paypalClientSecret'),
    paypalWebhookId: getSensitive('paypalWebhookId'),
    paypalWebhookProofKey: getSensitive('paypalWebhookProofKey'),
    paypalSandbox: store.get('paypalSandbox', true),
    vpsCsrfSecret: getSensitive('vpsCsrfSecret'),
    vpsNextAuthSecret: getSensitive('vpsNextAuthSecret'),
    vpsWebhookReplaySecret: getSensitive('vpsWebhookReplaySecret'),
    vpsValkeyPassword: getSensitive('vpsValkeyPassword'),
    vpsLavalinkPassword: getSensitive('vpsLavalinkPassword'),
    windowBounds: store.get('windowBounds'),
    runtimeMode: store.get('runtimeMode', 'regular-local'),
    lastSuccessfulRuntimeMode: store.get('lastSuccessfulRuntimeMode'),
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
export function buildEnvVars(
  config: LauncherConfig,
  sessionToken: string,
): Record<string, string> {
  const paypalApiBase = config.paypalSandbox
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

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

    // Security — reuse the portable instance generation across local restarts
    // and VPS handoffs. The fallback is only for legacy direct callers; normal
    // launcher startup persists these before spawning any service.
    CSRF_SECRET: config.vpsCsrfSecret || randomBytes(32).toString('hex'),
    NEXTAUTH_SECRET: config.vpsNextAuthSecret || randomBytes(32).toString('hex'),
    WEBHOOK_REPLAY_SECRET: config.vpsWebhookReplaySecret || randomBytes(32).toString('hex'),
    SOMNIBOT_RUNTIME_HOLDER_ID: getRuntimeHolderId(
      'regular-local',
      config.vpsWebhookReplaySecret || config.discordApplicationId,
    ),

    // Runtime networking: operator dashboard URL and public callback base
    // are intentionally separate. Regular local keeps the launcher dashboard
    // on localhost while public providers may call back through Tailscale
    // Funnel. VPS mode uses the VPS HTTPS domain for both.
    ...buildRuntimeEnvVars(config),

    // PayPal store/webhook runtime. The public webhook URL is derived from
    // the runtime profile; the operator-provided credentials stay in the
    // encrypted launcher store and are passed only to child processes.
    PAYPAL_CLIENT_ID: config.paypalClientId,
    PAYPAL_CLIENT_SECRET: config.paypalClientSecret,
    PAYPAL_WEBHOOK_ID: config.paypalWebhookId,
    PAYPAL_SANDBOX: config.paypalSandbox ? 'true' : 'false',
    PAYPAL_API_BASE: paypalApiBase,

    // Lavalink defaults
    // V7 Audit §9.8: Use the same password that was written to application.yml.
    // getLavalinkPassword() is the single source of truth — resolves from
    // LAVALINK_PASSWORD env var or a random per-launch hex, and caches the result.
    // Always pass a valid password — BotEnvSchema requires min 8 chars even
    // when Lavalink is disabled (the bot still validates all env vars at startup).
    LAVALINK_PASSWORD: config.vpsLavalinkPassword || getLavalinkPassword(),

    // Database — direct Postgres access for migrations.
    // Construct the connection URL from the project ref + user-supplied password.
    ...buildDbUrlEnv(config.supabaseUrl, config.supabaseDbPassword),

    // Production mode
    NODE_ENV: 'production',
  };
}
