import type { LauncherConfig } from './config-store.js';
import { mergeMissingLauncherConfig } from './existing-env-import.js';
import {
  pullFromSupabase,
  type RestoredCredentials,
} from './supabase-sync.js';

const CORE_RECOVERABLE_FIELDS = [
  'discordToken',
  'discordApplicationId',
  'discordClientSecret',
  'discordGuildId',
  'supabasePublishableKey',
  'supabaseDbPassword',
  'paypalClientId',
  'paypalClientSecret',
  'paypalWebhookId',
] as const satisfies ReadonlyArray<keyof LauncherConfig>;

export interface CredentialBootstrapResult {
  attempted: boolean;
  patch: Partial<LauncherConfig>;
  restoredFields: Array<keyof LauncherConfig>;
  error?: string;
}

type PullCredentials = (
  supabaseUrl: string,
  supabaseSecretKey: string,
) => Promise<{ ok: boolean; credentials?: RestoredCredentials; error?: string }>;

export function needsCloudCredentialRestore(config: LauncherConfig): boolean {
  return CORE_RECOVERABLE_FIELDS.some((field) => {
    const value = config[field];
    return typeof value === 'string' && value.trim().length === 0;
  });
}

/**
 * Recover a partial launcher cache from SomniBot's durable instance settings.
 * Bootstrap credentials stay local; every recovered value is merged only into
 * an empty field, so a cloud read can never overwrite a newer local value.
 */
export async function restoreMissingCredentialsOnStartup(
  config: LauncherConfig,
  pullCredentials: PullCredentials = pullFromSupabase,
): Promise<CredentialBootstrapResult> {
  if (!config.supabaseUrl.trim() || !config.supabaseSecretKey.trim()) {
    return { attempted: false, patch: {}, restoredFields: [] };
  }
  if (!needsCloudCredentialRestore(config)) {
    return { attempted: false, patch: {}, restoredFields: [] };
  }

  const result = await pullCredentials(config.supabaseUrl, config.supabaseSecretKey);
  if (!result.ok || !result.credentials) {
    return {
      attempted: true,
      patch: {},
      restoredFields: [],
      error: result.error ?? 'SomniBot cloud credential restore returned no values.',
    };
  }

  const patch = mergeMissingLauncherConfig(config, result.credentials);
  return {
    attempted: true,
    patch,
    restoredFields: Object.keys(patch) as Array<keyof LauncherConfig>,
  };
}
