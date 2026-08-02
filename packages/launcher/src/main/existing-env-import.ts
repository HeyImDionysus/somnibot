import { promises as fsp } from 'node:fs';
import type { LauncherConfig } from './config-store.js';

const MAX_ENV_BYTES = 1024 * 1024;

type ImportableStringField = Exclude<keyof LauncherConfig,
  | 'guilds'
  | 'windowBounds'
  | 'supabaseDiscordAuthProviderConfigured'
  | 'paypalSandbox'
  | 'runtimeMode'
  | 'firstRunComplete'
  | 'lavalinkEnabled'
  | 'lastPids'
>;

const ENV_TO_CONFIG: Readonly<Record<string, ImportableStringField>> = {
  DISCORD_TOKEN: 'discordToken',
  DISCORD_APPLICATION_ID: 'discordApplicationId',
  DISCORD_CLIENT_SECRET: 'discordClientSecret',
  DISCORD_GUILD_ID: 'discordGuildId',
  SUPABASE_URL: 'supabaseUrl',
  NEXT_PUBLIC_SUPABASE_URL: 'supabaseUrl',
  SUPABASE_SECRET_KEY: 'supabaseSecretKey',
  SUPABASE_PUBLISHABLE_KEY: 'supabasePublishableKey',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'supabasePublishableKey',
  SUPABASE_DB_PASSWORD: 'supabaseDbPassword',
  SUPABASE_ACCESS_TOKEN: 'supabaseAccessToken',
  PAYPAL_CLIENT_ID: 'paypalClientId',
  PAYPAL_CLIENT_SECRET: 'paypalClientSecret',
  PAYPAL_WEBHOOK_ID: 'paypalWebhookId',
  CSRF_SECRET: 'vpsCsrfSecret',
  NEXTAUTH_SECRET: 'vpsNextAuthSecret',
  WEBHOOK_REPLAY_SECRET: 'vpsWebhookReplaySecret',
  VALKEY_PASSWORD: 'vpsValkeyPassword',
  LAVALINK_PASSWORD: 'vpsLavalinkPassword',
};

export interface ExistingEnvImportResult {
  ok: boolean;
  patch: Partial<LauncherConfig>;
  importedFields: Array<keyof LauncherConfig>;
  error?: string;
}

function unquoteEnvValue(rawValue: string): string {
  const value = rawValue.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\\'/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  const commentStart = value.search(/\s#/);
  return (commentStart >= 0 ? value.slice(0, commentStart) : value).trim();
}

export function parseExistingSomniBotEnv(source: string): Record<string, string> {
  if (source.includes('\0')) return {};
  const parsed: Record<string, string> = {};

  for (const sourceLine of source.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) continue;
    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    parsed[key] = unquoteEnvValue(withoutExport.slice(separator + 1));
  }

  return parsed;
}

function databasePasswordFromUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return '';
    return decodeURIComponent(parsed.password);
  } catch {
    return '';
  }
}

export function launcherConfigFromExistingEnv(env: Record<string, string>): Partial<LauncherConfig> {
  const imported: Partial<LauncherConfig> = {};
  for (const [envKey, configKey] of Object.entries(ENV_TO_CONFIG)) {
    const value = env[envKey]?.trim();
    if (value && !imported[configKey]) {
      (imported as Record<string, unknown>)[configKey] = value;
    }
  }

  const databasePassword = imported.supabaseDbPassword
    || databasePasswordFromUrl(env.SUPABASE_DB_URL)
    || databasePasswordFromUrl(env.DATABASE_URL);
  if (databasePassword) imported.supabaseDbPassword = databasePassword;

  const paypalSandbox = env.PAYPAL_SANDBOX?.trim().toLowerCase();
  if (paypalSandbox === 'true' || paypalSandbox === 'false') {
    imported.paypalSandbox = paypalSandbox === 'true';
  }

  const runtimeMode = env.SOMNIBOT_RUNTIME_MODE?.trim();
  if (runtimeMode === 'regular-local' || runtimeMode === 'vps') {
    imported.runtimeMode = runtimeMode;
  }

  const publicBaseUrl = env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL?.trim()
    || env.NEXT_PUBLIC_APP_URL?.trim()
    || env.DASHBOARD_URL?.trim();
  if (publicBaseUrl) {
    if (imported.runtimeMode === 'vps') imported.vpsDomain = publicBaseUrl;
    else imported.publicCallbackBaseUrl = publicBaseUrl;
  }

  return imported;
}

export function mergeMissingLauncherConfig(
  current: LauncherConfig,
  imported: Partial<LauncherConfig>,
): Partial<LauncherConfig> {
  const patch: Partial<LauncherConfig> = {};
  for (const [rawKey, value] of Object.entries(imported)) {
    const key = rawKey as keyof LauncherConfig;
    if (typeof value === 'string') {
      const currentValue = current[key];
      if (typeof currentValue === 'string' && !currentValue.trim() && value.trim()) {
        (patch as Record<string, unknown>)[key] = value;
      }
    } else if (!current.firstRunComplete && typeof value === 'boolean') {
      (patch as Record<string, unknown>)[key] = value;
    }
  }
  return patch;
}

export async function importExistingSomniBotEnv(
  filePath: string,
  current: LauncherConfig,
): Promise<ExistingEnvImportResult> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_ENV_BYTES) {
      return { ok: false, patch: {}, importedFields: [], error: 'The selected file is not a supported SomniBot environment file.' };
    }
    const source = await fsp.readFile(filePath, 'utf8');
    const imported = launcherConfigFromExistingEnv(parseExistingSomniBotEnv(source));
    const recognizedFields = Object.keys(imported) as Array<keyof LauncherConfig>;
    const hasSomniBotIdentity = Boolean(imported.supabaseUrl && imported.supabaseSecretKey && imported.discordApplicationId);
    if (!hasSomniBotIdentity) {
      return { ok: false, patch: {}, importedFields: [], error: 'The selected file does not contain a complete SomniBot connection identity.' };
    }
    const patch = mergeMissingLauncherConfig(current, imported);
    return {
      ok: true,
      patch,
      importedFields: recognizedFields.filter((field) => field in patch),
    };
  } catch {
    return { ok: false, patch: {}, importedFields: [], error: 'SomniBot could not read the selected environment file.' };
  }
}
