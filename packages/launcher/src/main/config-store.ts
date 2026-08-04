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
import { app, safeStorage } from 'electron';
import { randomBytes } from 'crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { getLavalinkPassword } from './lavalink-manager.js';
import { buildRuntimeEnvVars, getRuntimeHolderId, type RuntimeMode } from './runtime-profile.js';
import { buildDbUrlEnv } from './supabase-db-url.js';
import {
  LEGACY_CONFIG_RELATIVE_PATHS,
  selectMissingLegacyConfig,
} from './legacy-config-migration.js';
import { normalizeDiscordToken } from './credential-normalization.js';

/** V53 Phase 4 (4.3.3): Per-guild config for multi-guild support */
export interface GuildEntry {
  discordGuildId: string;
  name: string;
  enabled: boolean;
}

export interface LauncherConfig {
  /** One-time marker that current-store plaintext secrets were migrated. */
  credentialStoreVersion?: number;
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
  /** Password-free Supavisor session endpoint discovered from the Management API. */
  supabaseDbUrlTemplate?: string;
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
  /** Installation controls surfaced in the owner administration panel. */
  autoInstallOnQuit: boolean;
  keychainRequired: boolean;
  ownerBrandName: string;
  updatePromptBeforeDownload: boolean;
  sdkCacheTtlMs: number;

  // ── Phase 6: Stale process tracking (PIDs from last run) ──
  lastPids: { bot: number | null; dashboard: number | null; lavalink: number | null; valkey: number | null };
  /** Wall-clock launch witnesses used to reject reused or planted PIDs. */
  lastPidStartedAt?: { bot: number | null; dashboard: number | null; lavalink: number | null; valkey: number | null };
}

const DEFAULTS: LauncherConfig = {
  credentialStoreVersion: 0,
  discordToken: '',
  discordApplicationId: '',
  discordClientSecret: '',
  discordGuildId: '',
  guilds: [],
  supabaseUrl: '',
  supabaseSecretKey: '',
  supabasePublishableKey: '',
  supabaseDbPassword: '',
  supabaseDbUrlTemplate: '',
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
  autoInstallOnQuit: true,
  keychainRequired: true,
  ownerBrandName: 'SomniBot',
  updatePromptBeforeDownload: true,
  sdkCacheTtlMs: 60000,
  lastPids: { bot: null, dashboard: null, lavalink: null, valkey: null },
  lastPidStartedAt: { bot: null, dashboard: null, lavalink: null, valkey: null },
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
  'supabaseDbUrlTemplate',
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
 * libsecret on Linux). Credential writes fail closed if safeStorage is
 * unavailable; the launcher must never create a new plaintext secret store.
 */
// V5 Audit §10.5 — Track whether we've already reported a keychain failure
let _safeStorageWarned = false;

/**
 * [infrastructure-launcher] Keychain-failure audit hook. When the OS keychain
 * (safeStorage) is unavailable, credential access fails closed and we notify
 * this listener (once) so the main process can write a durable audit_logs row.
 */
let _keychainFailureListener: (() => void) | undefined;

export function setKeychainFallbackListener(listener: () => void): void {
  _keychainFailureListener = listener;
}

function notifyKeychainUnavailable(): void {
  if (_safeStorageWarned) return;
  _safeStorageWarned = true;
  console.warn(
    '[ConfigStore] OS keychain (safeStorage) is unavailable; refusing to read or write launcher credentials. ' +
    'On Linux, install a keyring daemon (gnome-keyring, kwallet, or keepassxc).',
  );
  try {
    _keychainFailureListener?.();
  } catch {
    // Audit is best-effort and must not change the fail-closed behavior.
  }
}

function isSafeStorageAvailable(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // Electron can fall back to `basic_text` when a Linux keyring is absent.
    // That backend is reversible with a hard-coded key and therefore does not
    // satisfy SomniBot's encrypted credential-store contract.
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function encryptSensitive(value: string): string {
  if (!value) return '';
  if (!isSafeStorageAvailable()) {
    notifyKeychainUnavailable();
    throw new Error('OS keychain is unavailable; launcher credentials were not saved. Install or unlock a supported keychain and retry.');
  }
  try {
    return safeStorage.encryptString(value).toString('base64');
  } catch {
    notifyKeychainUnavailable();
    throw new Error('OS keychain encryption failed; launcher credentials were not saved.');
  }
}

/**
 * Decrypt a string that was encrypted via encryptSensitive().
 * Legacy plaintext is handled only by the one-time migration below.
 */
function decryptSensitive(stored: string): string {
  if (!stored) return '';
  if (!isSafeStorageAvailable()) {
    notifyKeychainUnavailable();
    return '';
  }
  try {
    const buf = Buffer.from(stored, 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    // Current-store plaintext is migrated exactly once by
    // migrateCurrentPlaintextSecrets(). After that boundary, malformed or
    // injected values fail closed and never become runtime credentials.
    console.warn('[ConfigStore] Stored credential could not be decrypted; refusing to use it.');
    return '';
  }
}

function getSensitive(key: keyof LauncherConfig): string {
  const raw = store.get(key, '') as string;
  return decryptSensitive(raw);
}

function setSensitive(key: keyof LauncherConfig, value: string): void {
  store.set(key, encryptSensitive(value));
}

/**
 * Migrate connection state from the pre-bootstrap Electron/SomniBot store.
 *
 * The launcher now sets a stable package identity before loading this module,
 * which correctly prevents future generic-Electron collisions but also moves
 * the electron-store path. Read the old path only when it already exists and
 * merge missing values into the current store. Once migration succeeds,
 * sensitive fields are removed from the legacy store so plaintext copies do
 * not remain indefinitely; unrelated legacy settings are preserved. Both the current safeStorage format and the older electron-
 * store encryptionKey format are supported.
 */
export function migrateLegacyConfig(): void {
  try {
    const appDataPath = app.getPath('appData');
    const current = getConfigSnapshot();

    for (const [relativeDirectory, fileName] of LEGACY_CONFIG_RELATIVE_PATHS) {
      const legacyDirectory = path.join(appDataPath, relativeDirectory);
      const legacyPath = path.join(legacyDirectory, fileName);
      if (!existsSync(legacyPath)) continue;

      let legacy: Record<string, unknown> | undefined;
      let legacyStore: Store<Record<string, unknown>> | undefined;
      try {
        legacyStore = new Store<Record<string, unknown>>({
          name: 'config',
          cwd: legacyDirectory,
          clearInvalidConfig: false,
        });
        const candidate = legacyStore.store;
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          throw new Error('legacy config is not an object');
        }
        legacy = candidate;
      } catch {
        // Older builds encrypted the whole electron-store with this key.
        try {
          legacyStore = new Store<Record<string, unknown>>({
            name: 'config',
            cwd: legacyDirectory,
            encryptionKey: 'somnibot-launcher-v1',
            clearInvalidConfig: false,
          });
          const candidate = legacyStore.store;
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            throw new Error('legacy config is not an object');
          }
          legacy = candidate;
        } catch {
          legacy = undefined;
        }
      }
      if (!legacy) continue;

      const patch = selectMissingLegacyConfig(current, legacy);
      if (Object.keys(patch).length > 0) {
        saveConfig(patch);
        Object.assign(current, patch);
      }

      // Retire only credentials that now exist in the safeStorage-backed
      // current store. This is intentionally after saveConfig so a failed
      // migration never destroys the only usable copy.
      if (legacyStore) {
        const secured = getConfigSnapshot();
        for (const key of SENSITIVE_KEYS) {
          if (secured[key] && legacyStore.has(key)) legacyStore.delete(key);
        }
      }
    }
  } catch {
    // A malformed or inaccessible legacy store must never prevent the current
    // launcher from starting with its own store. Do not log paths or values.
    console.warn('[ConfigStore] Legacy config migration skipped.');
  }
}

/**
 * Re-encrypt plaintext values written by pre-safeStorage launcher builds.
 * The migration is bounded by a durable version marker; later decryption
 * failures are rejected instead of being interpreted as plaintext secrets.
 */
export function migrateCurrentPlaintextSecrets(): void {
  if (store.get('credentialStoreVersion', 0) >= 1) return;
  if (!isSafeStorageAvailable()) {
    notifyKeychainUnavailable();
    return;
  }

  for (const key of SENSITIVE_KEYS) {
    const raw = store.get(key, '') as string;
    if (!raw) continue;
    try {
      safeStorage.decryptString(Buffer.from(raw, 'base64'));
    } catch {
      setSensitive(key, raw);
    }
  }
  store.set('credentialStoreVersion', 1);
}

/** Read current values without decrypting sensitive fields twice. */
function getConfigSnapshot(): Partial<LauncherConfig> {
  const storedOrUndefined = <T>(key: keyof LauncherConfig, fallback: T): T | undefined => (
    store.has(key) ? store.get(key as never, fallback as never) as T : undefined
  );

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
    supabaseDbUrlTemplate: getSensitive('supabaseDbUrlTemplate'),
    supabaseAccessToken: getSensitive('supabaseAccessToken'),
    supabaseDiscordAuthProviderConfigured: storedOrUndefined('supabaseDiscordAuthProviderConfigured', false),
    paypalClientId: store.get('paypalClientId', ''),
    paypalClientSecret: getSensitive('paypalClientSecret'),
    paypalWebhookId: getSensitive('paypalWebhookId'),
    paypalWebhookProofKey: getSensitive('paypalWebhookProofKey'),
    paypalSandbox: storedOrUndefined('paypalSandbox', true),
    vpsCsrfSecret: getSensitive('vpsCsrfSecret'),
    vpsNextAuthSecret: getSensitive('vpsNextAuthSecret'),
    vpsWebhookReplaySecret: getSensitive('vpsWebhookReplaySecret'),
    vpsValkeyPassword: getSensitive('vpsValkeyPassword'),
    vpsLavalinkPassword: getSensitive('vpsLavalinkPassword'),
    windowBounds: store.get('windowBounds'),
    runtimeMode: storedOrUndefined('runtimeMode', 'regular-local'),
    lastSuccessfulRuntimeMode: store.get('lastSuccessfulRuntimeMode'),
    publicCallbackBaseUrl: store.get('publicCallbackBaseUrl', ''),
    vpsDomain: store.get('vpsDomain', ''),
    vpsSshHost: store.get('vpsSshHost', ''),
    vpsSshUser: store.get('vpsSshUser', ''),
    vpsDeployPath: store.get('vpsDeployPath', ''),
    tailscaleAuthKey: getSensitive('tailscaleAuthKey'),
    firstRunComplete: storedOrUndefined('firstRunComplete', false),
    lavalinkEnabled: storedOrUndefined('lavalinkEnabled', false),
    autoInstallOnQuit: storedOrUndefined('autoInstallOnQuit', true),
    keychainRequired: storedOrUndefined('keychainRequired', true),
    ownerBrandName: store.get('ownerBrandName', 'SomniBot'),
    updatePromptBeforeDownload: storedOrUndefined('updatePromptBeforeDownload', true),
    sdkCacheTtlMs: storedOrUndefined('sdkCacheTtlMs', 60000),
    lastPids: storedOrUndefined('lastPids', { bot: null, dashboard: null, lavalink: null, valkey: null }),
    lastPidStartedAt: storedOrUndefined('lastPidStartedAt', { bot: null, dashboard: null, lavalink: null, valkey: null }),
  };
}

export function getConfig(): LauncherConfig {
  return {
    credentialStoreVersion: store.get('credentialStoreVersion', 0),
    discordToken: getSensitive('discordToken'),
    discordApplicationId: store.get('discordApplicationId', ''),
    discordClientSecret: getSensitive('discordClientSecret'),
    discordGuildId: store.get('discordGuildId', ''),
    guilds: store.get('guilds', []),
    supabaseUrl: store.get('supabaseUrl', ''),
    supabaseSecretKey: getSensitive('supabaseSecretKey'),
    supabasePublishableKey: store.get('supabasePublishableKey', ''),
    supabaseDbPassword: getSensitive('supabaseDbPassword'),
    supabaseDbUrlTemplate: getSensitive('supabaseDbUrlTemplate'),
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
    autoInstallOnQuit: store.get('autoInstallOnQuit', true),
    keychainRequired: store.get('keychainRequired', true),
    ownerBrandName: store.get('ownerBrandName', 'SomniBot'),
    updatePromptBeforeDownload: store.get('updatePromptBeforeDownload', true),
    sdkCacheTtlMs: store.get('sdkCacheTtlMs', 60000),
    lastPids: store.get('lastPids', { bot: null, dashboard: null, lavalink: null, valkey: null }),
    lastPidStartedAt: store.get('lastPidStartedAt', { bot: null, dashboard: null, lavalink: null, valkey: null }),
  };
}

export function saveConfig(config: Partial<LauncherConfig>): void {
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) {
      const normalizedValue = key === 'discordToken' && typeof value === 'string'
        ? normalizeDiscordToken(value)
        : value;
      if (SENSITIVE_KEYS.has(key as keyof LauncherConfig) && typeof value === 'string') {
        setSensitive(key as keyof LauncherConfig, normalizedValue as string);
      } else {
        store.set(key as keyof LauncherConfig, normalizedValue);
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
    ...buildDbUrlEnv(config.supabaseUrl, config.supabaseDbPassword, config.supabaseDbUrlTemplate),

    // Production mode
    NODE_ENV: 'production',
  };
}
