import type { LauncherConfig } from './config-store.js';

export const MASKED_SECRET = '••••••••';

export const SENSITIVE_CONFIG_KEYS = [
  'discordToken',
  'discordClientSecret',
  'supabaseSecretKey',
  'supabaseDbPassword',
  'supabaseDbUrlTemplate',
  'supabaseAccessToken',
  'paypalClientSecret',
  'paypalWebhookId',
  'paypalWebhookProofKey',
  'tailscaleAuthKey',
  'vpsCsrfSecret',
  'vpsNextAuthSecret',
  'vpsWebhookReplaySecret',
  'vpsValkeyPassword',
  'vpsLavalinkPassword',
] as const satisfies readonly (keyof LauncherConfig)[];

/** Return renderer-safe config values without exposing plaintext credentials over IPC. */
export function maskConfigSecrets<T extends Partial<LauncherConfig>>(config: T): T {
  const masked = { ...config };
  for (const key of SENSITIVE_CONFIG_KEYS) {
    if (typeof masked[key] === 'string' && masked[key].length > 0) {
      masked[key] = MASKED_SECRET as T[typeof key];
    }
  }
  return masked;
}

/** Drop unchanged mask placeholders so a renderer round-trip cannot erase stored secrets. */
export function sanitizeConfigPatchForStorage<T extends Partial<LauncherConfig>>(config: T): T {
  const sanitized = { ...config };
  // Runtime process ownership is main-process state. Never accept it from a
  // renderer round-trip: a compromised page must not be able to plant a PID
  // that startup cleanup will later consider launcher-owned.
  delete sanitized.lastPids;
  delete sanitized.lastPidStartedAt;
  for (const key of SENSITIVE_CONFIG_KEYS) {
    if (sanitized[key] === MASKED_SECRET) {
      delete sanitized[key];
    }
  }
  return sanitized;
}
