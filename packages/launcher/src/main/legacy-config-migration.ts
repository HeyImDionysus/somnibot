import type { LauncherConfig } from './config-store.js';

/**
 * Fields that existed in the pre-bootstrap Electron store or were added to the
 * launcher after that store was created. Keep this allow-list explicit so a
 * legacy config cannot inject arbitrary electron-store keys into the current
 * schema.
 */
const MIGRATABLE_KEYS = [
  'discordToken',
  'discordApplicationId',
  'discordClientSecret',
  'discordGuildId',
  'guilds',
  'supabaseUrl',
  'supabaseSecretKey',
  'supabasePublishableKey',
  'supabaseDbPassword',
  'supabaseAccessToken',
  'supabaseDiscordAuthProviderConfigured',
  'paypalClientId',
  'paypalClientSecret',
  'paypalWebhookId',
  'paypalWebhookProofKey',
  'paypalSandbox',
  'vpsCsrfSecret',
  'vpsNextAuthSecret',
  'vpsWebhookReplaySecret',
  'vpsValkeyPassword',
  'vpsLavalinkPassword',
  'windowBounds',
  'runtimeMode',
  'lastSuccessfulRuntimeMode',
  'publicCallbackBaseUrl',
  'vpsDomain',
  'vpsSshHost',
  'vpsSshUser',
  'vpsDeployPath',
  'tailscaleAuthKey',
  'firstRunComplete',
  'lavalinkEnabled',
  'lastPids',
] as const satisfies ReadonlyArray<keyof LauncherConfig>;

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const STRING_KEYS = new Set<keyof LauncherConfig>([
  'discordToken',
  'discordApplicationId',
  'discordClientSecret',
  'discordGuildId',
  'supabaseUrl',
  'supabaseSecretKey',
  'supabasePublishableKey',
  'supabaseDbPassword',
  'supabaseAccessToken',
  'paypalClientId',
  'paypalClientSecret',
  'paypalWebhookId',
  'paypalWebhookProofKey',
  'vpsCsrfSecret',
  'vpsNextAuthSecret',
  'vpsWebhookReplaySecret',
  'vpsValkeyPassword',
  'vpsLavalinkPassword',
  'publicCallbackBaseUrl',
  'vpsDomain',
  'vpsSshHost',
  'vpsSshUser',
  'vpsDeployPath',
  'tailscaleAuthKey',
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidLegacyValue(key: keyof LauncherConfig, value: unknown): boolean {
  if (STRING_KEYS.has(key)) return isNonBlankString(value);
  if (key === 'runtimeMode' || key === 'lastSuccessfulRuntimeMode') {
    return value === 'regular-local' || value === 'vps';
  }
  if (key === 'supabaseDiscordAuthProviderConfigured' || key === 'paypalSandbox' || key === 'firstRunComplete' || key === 'lavalinkEnabled') {
    return typeof value === 'boolean';
  }
  if (key === 'windowBounds') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const bounds = value as Record<string, unknown>;
    return isFiniteNumber(bounds.width)
      && isFiniteNumber(bounds.height)
      && (bounds.x === undefined || isFiniteNumber(bounds.x))
      && (bounds.y === undefined || isFiniteNumber(bounds.y));
  }
  if (key === 'guilds') {
    return Array.isArray(value) && value.every(entry => (
      entry !== null
      && typeof entry === 'object'
      && typeof (entry as Record<string, unknown>).discordGuildId === 'string'
      && typeof (entry as Record<string, unknown>).name === 'string'
      && typeof (entry as Record<string, unknown>).enabled === 'boolean'
    ));
  }
  if (key === 'lastPids') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const pids = value as Record<string, unknown>;
    return ['bot', 'dashboard', 'lavalink', 'valkey'].every(name => (
      pids[name] === null || (typeof pids[name] === 'number' && Number.isInteger(pids[name]) && pids[name] >= 0)
    ));
  }
  return false;
}

/**
 * Select only missing values from a legacy config. Existing current-store
 * values always win, including current secrets and runtime ownership state.
 * The returned object contains the original values; the caller is responsible
 * for passing sensitive fields through the current safeStorage writer.
 */
export function selectMissingLegacyConfig(
  current: Partial<LauncherConfig>,
  legacy: Record<string, unknown>,
): Partial<LauncherConfig> {
  const patch: Partial<LauncherConfig> = {};

  for (const key of MIGRATABLE_KEYS) {
    const legacyValue = legacy[key];
    if (legacyValue === undefined || legacyValue === null) continue;
    if (!isValidLegacyValue(key, legacyValue)) continue;

    const currentValue = current[key];
    if (typeof currentValue === 'string') {
      if (!currentValue.trim() && isNonBlankString(legacyValue)) {
        (patch as Record<string, unknown>)[key] = legacyValue;
      }
      continue;
    }

    if (currentValue === undefined) {
      (patch as Record<string, unknown>)[key] = legacyValue;
    }
  }

  return patch;
}

export const LEGACY_CONFIG_RELATIVE_PATHS = [
  ['Electron', 'config.json'],
  ['SomniBot', 'config.json'],
] as const;
