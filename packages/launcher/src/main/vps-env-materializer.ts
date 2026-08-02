import { randomBytes } from 'node:crypto';
import type { LauncherConfig } from './config-store.js';
import { buildDbUrlEnv } from './supabase-db-url.js';
import type { VpsDeploymentPlan } from './vps-deployment-plan.js';

type SecretGenerator = (bytes: number) => string;

const requiredCredentialFields: Array<keyof LauncherConfig> = [
  'discordToken',
  'discordApplicationId',
  'discordClientSecret',
  'supabaseUrl',
  'supabaseSecretKey',
  'supabasePublishableKey',
  'supabaseDbPassword',
  'paypalClientId',
  'paypalClientSecret',
  'paypalWebhookId',
];

function generatedSecret(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function dotenvValue(value: string): string {
  if (/\0|\r|\n/.test(value)) {
    throw new Error('VPS environment values must be single-line strings.');
  }
  // Compose treats single-quoted .env values literally, so provider tokens
  // containing $, #, spaces, or backslashes are not interpolated or truncated.
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function blockedPlan(plan: VpsDeploymentPlan, reasons: string[]): VpsDeploymentPlan {
  return {
    ...plan,
    status: 'blocked',
    canApprove: false,
    blockedReasons: [...plan.blockedReasons, ...reasons],
    commands: [],
  };
}

/**
 * Attach the real VPS .env payload only to the main-process execution plan.
 * The public/dry-run plan stays placeholder-only, while the SSH runner receives
 * credentials over stdin so they never appear in argv, renderer state, or logs.
 */
export function materializeVpsDeploymentPlan(
  plan: VpsDeploymentPlan,
  config: LauncherConfig,
  generateSecret: SecretGenerator = generatedSecret,
): VpsDeploymentPlan {
  if (plan.status !== 'ready' || !plan.environment) return plan;

  const missing = requiredCredentialFields
    .filter((field) => typeof config[field] !== 'string' || !(config[field] as string).trim())
    .map((field) => String(field));
  if (missing.length > 0) {
    return blockedPlan(plan, [
      `Saved launcher credentials are incomplete for VPS deployment: ${missing.join(', ')}.`,
    ]);
  }

  if (!config.supabaseAccessToken && !config.supabaseDiscordAuthProviderConfigured) {
    return blockedPlan(plan, [
      'Supabase Discord auth provider setup needs the saved access token or the saved manual-configuration confirmation.',
    ]);
  }

  const supabaseDbUrl = buildDbUrlEnv(config.supabaseUrl, config.supabaseDbPassword).SUPABASE_DB_URL;
  if (!supabaseDbUrl) {
    return blockedPlan(plan, ['The saved Supabase URL and database password could not produce a direct database URL.']);
  }

  const csrfSecret = generateSecret(32);
  const nextAuthSecret = generateSecret(32);
  const webhookReplaySecret = generateSecret(32);
  const valkeyPassword = generateSecret(16);
  const lavalinkPassword = generateSecret(16);
  const guildIds = config.guilds.length > 0
    ? config.guilds.filter((guild) => guild.enabled).map((guild) => guild.discordGuildId).join(',')
    : config.discordGuildId;
  const paypalApiBase = config.paypalSandbox
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

  const actualValues: Record<string, string> = {
    DISCORD_TOKEN: config.discordToken,
    DISCORD_APPLICATION_ID: config.discordApplicationId,
    DISCORD_CLIENT_SECRET: config.discordClientSecret,
    DISCORD_GUILD_ID: guildIds,
    SUPABASE_URL: config.supabaseUrl,
    SUPABASE_SECRET_KEY: config.supabaseSecretKey,
    SUPABASE_DB_URL: supabaseDbUrl,
    SUPABASE_ACCESS_TOKEN: config.supabaseAccessToken,
    SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED: config.supabaseDiscordAuthProviderConfigured ? 'true' : 'false',
    NEXT_PUBLIC_SUPABASE_URL: config.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: config.supabasePublishableKey,
    CSRF_SECRET: csrfSecret,
    NEXTAUTH_SECRET: nextAuthSecret,
    WEBHOOK_REPLAY_SECRET: webhookReplaySecret,
    VALKEY_PASSWORD: valkeyPassword,
    VALKEY_URL: `redis://:${valkeyPassword}@valkey:6379`,
    LAVALINK_PASSWORD: lavalinkPassword,
    PAYPAL_CLIENT_ID: config.paypalClientId,
    PAYPAL_CLIENT_SECRET: config.paypalClientSecret,
    PAYPAL_SANDBOX: config.paypalSandbox ? 'true' : 'false',
    PAYPAL_API_BASE: paypalApiBase,
    PAYPAL_WEBHOOK_ID: config.paypalWebhookId,
  };

  let envFile: string;
  try {
    envFile = `${plan.environment.variables.map((variable) => {
      const value = actualValues[variable.name] ?? variable.value;
      return `${variable.name}=${dotenvValue(value)}`;
    }).join('\n')}\n`;
  } catch (error) {
    return blockedPlan(plan, [error instanceof Error ? error.message : String(error)]);
  }

  return {
    ...plan,
    commands: plan.commands.map((command) => command.id === 'write-env-file'
      ? { ...command, sensitiveStdin: envFile }
      : command),
  };
}
