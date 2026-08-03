import type { LauncherConfig } from './config-store.js';
import { mergeMissingLauncherConfig } from './existing-env-import.js';
import {
  pullFromSupabase,
  type RestoredCredentials,
} from './supabase-sync.js';
import { validateDiscordToken, type ValidationResult } from './validators.js';

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

type ValidateDiscordCredential = (token: string) => Promise<ValidationResult>;

export function needsCloudCredentialRestore(config: LauncherConfig): boolean {
  return CORE_RECOVERABLE_FIELDS.some((field) => {
    const value = config[field];
    return typeof value === 'string' && value.trim().length === 0;
  });
}

/**
 * Recover and reconcile a launcher cache from SomniBot's durable settings.
 * Missing fields are restored non-destructively. A nonblank local Discord
 * token is replaced only when Discord definitively rejects it and a different
 * cloud token validates, preventing stale local state from blocking recovery
 * without allowing an outage to overwrite a credential that may still work.
 */
export async function restoreMissingCredentialsOnStartup(
  config: LauncherConfig,
  pullCredentials: PullCredentials = pullFromSupabase,
  validateDiscordCredential: ValidateDiscordCredential = validateDiscordToken,
): Promise<CredentialBootstrapResult> {
  if (!config.supabaseUrl.trim() || !config.supabaseSecretKey.trim()) {
    return { attempted: false, patch: {}, restoredFields: [] };
  }

  const localDiscordToken = config.discordToken.trim();
  const localDiscordValidation = localDiscordToken
    ? await validateDiscordCredential(localDiscordToken)
    : null;
  const localDiscordRejected = localDiscordValidation?.code === 'invalid';

  if (!needsCloudCredentialRestore(config) && !localDiscordRejected) {
    return { attempted: false, patch: {}, restoredFields: [] };
  }

  const result = await pullCredentials(config.supabaseUrl, config.supabaseSecretKey);
  if (!result.ok || !result.credentials) {
    return {
      attempted: true,
      patch: {},
      restoredFields: [],
      error: localDiscordRejected
        ? `The saved Discord bot token is no longer accepted, and cloud recovery failed: ${result.error ?? 'no saved values were returned.'}`
        : result.error ?? 'SomniBot cloud credential restore returned no values.',
    };
  }

  const patch = mergeMissingLauncherConfig(config, result.credentials);
  let error: string | undefined;

  if (localDiscordRejected) {
    const cloudDiscordToken = result.credentials.discordToken?.trim();
    if (cloudDiscordToken && cloudDiscordToken !== localDiscordToken) {
      const cloudValidation = await validateDiscordCredential(cloudDiscordToken);
      if (cloudValidation.ok) {
        patch.discordToken = cloudDiscordToken;
      } else {
        error = cloudValidation.code === 'invalid'
          ? 'Both the saved local and cloud Discord bot tokens are no longer accepted.'
          : 'The saved local Discord bot token is no longer accepted, and the cloud replacement could not be verified while Discord was unavailable.';
      }
    } else {
      error = 'The saved Discord bot token is no longer accepted, and no different cloud token is available for automatic recovery.';
    }
  } else if (!localDiscordToken && typeof patch.discordToken === 'string') {
    const cloudValidation = await validateDiscordCredential(patch.discordToken);
    if (!cloudValidation.ok && cloudValidation.code === 'invalid') {
      delete patch.discordToken;
      error = 'The Discord bot token stored in the cloud is no longer accepted.';
    }
  }

  return {
    attempted: true,
    patch,
    restoredFields: Object.keys(patch) as Array<keyof LauncherConfig>,
    ...(error ? { error } : {}),
  };
}
