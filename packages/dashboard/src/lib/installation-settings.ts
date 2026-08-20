import type { createAdminSupabase } from '@/lib/supabase/admin';

type AdminSupabase = ReturnType<typeof createAdminSupabase>;

export const SECRET_FIELDS = new Set([
  'supabase_anon_key',
  'supabase_secret_key',
  'discord_bot_token',
  'discord_client_secret',
  'paypal_client_secret',
  'paypal_webhook_id',
  'lavalink_password',
  'valkey_url',
  'supabase_access_token',
  'supabase_db_url',
  'supabase_db_url_template',
  'supabase_db_password',
  'discord_token',
  'paypal_webhook_proof_key',
  'tailscale_auth_key',
  'vps_csrf_secret',
  'vps_nextauth_secret',
  'vps_webhook_replay_secret',
  'vps_valkey_password',
  'vps_lavalink_password',
]);

export const ENCRYPTED_SECRET_FIELDS = new Set([
  'discord_bot_token',
  'discord_client_secret',
  'paypal_client_secret',
  'paypal_webhook_id',
  'lavalink_password',
  'valkey_url',
  'supabase_access_token',
  'supabase_db_url',
]);

export const BOOTSTRAP_ONLY_FIELDS = new Set([
  'supabase_url',
  'supabase_anon_key',
  'supabase_secret_key',
]);

export const ENV_MAP: Record<string, string[]> = {
  supabase_url: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'],
  supabase_anon_key: ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY'],
  supabase_secret_key: ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
  discord_application_id: ['DISCORD_APPLICATION_ID'],
  discord_bot_token: ['DISCORD_TOKEN'],
  discord_guild_id: ['DISCORD_GUILD_ID'],
  discord_client_secret: ['DISCORD_CLIENT_SECRET'],
  paypal_client_id: ['PAYPAL_CLIENT_ID'],
  paypal_client_secret: ['PAYPAL_CLIENT_SECRET'],
  paypal_webhook_id: ['PAYPAL_WEBHOOK_ID'],
  paypal_webhook_url: ['PAYPAL_WEBHOOK_URL'],
  paypal_sandbox: ['PAYPAL_SANDBOX'],
  lavalink_host: ['LAVALINK_HOST'],
  lavalink_port: ['LAVALINK_PORT'],
  lavalink_password: ['LAVALINK_PASSWORD'],
  valkey_url: ['VALKEY_URL', 'REDIS_URL'],
};

export const INSTALLATION_DEFAULTS: Record<string, string> = {
  auto_install_on_quit: 'true',
  keychain_required: 'true',
  lavalink_enabled: 'false',
  owner_brand_name: 'SomniBot',
  runtime_mode: 'regular-local',
  update_prompt_before_download: 'true',
  vps_deploy_path: '',
  sdk_cache_ttl_ms: '60000',
};

export const ALLOWED_SETTING_KEYS = new Set([
  ...Object.keys(ENV_MAP),
  ...Object.keys(INSTALLATION_DEFAULTS),
]);

export const SETTING_SECTIONS: Record<string, string> = {
  supabase_url: 'supabase',
  supabase_anon_key: 'supabase',
  supabase_secret_key: 'supabase',
  discord_application_id: 'discord',
  discord_bot_token: 'discord',
  discord_guild_id: 'discord',
  discord_client_secret: 'discord',
  paypal_client_id: 'paypal',
  paypal_client_secret: 'paypal',
  paypal_webhook_id: 'paypal',
  paypal_webhook_url: 'paypal',
  paypal_sandbox: 'paypal',
  lavalink_host: 'lavalink',
  lavalink_port: 'lavalink',
  lavalink_password: 'lavalink',
  valkey_url: 'valkey',
  auto_install_on_quit: 'administration',
  keychain_required: 'administration',
  lavalink_enabled: 'administration',
  owner_brand_name: 'administration',
  runtime_mode: 'administration',
  update_prompt_before_download: 'administration',
  vps_deploy_path: 'administration',
  sdk_cache_ttl_ms: 'administration',
};

export type InstallationSettingValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function normalizeInstallationSettingValue(
  key: string,
  rawValue: string,
): InstallationSettingValidation {
  const value = rawValue.trim();

  if (key === 'discord_application_id' && !/^\d{17,20}$/.test(value)) {
    return { ok: false, error: 'discord_application_id must be a 17-20 digit Discord application ID' };
  }

  if (key === 'paypal_sandbox') {
    const normalized = value.toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return { ok: true, value: 'true' };
    if (['false', '0', 'no', 'off'].includes(normalized)) return { ok: true, value: 'false' };
    return { ok: false, error: 'paypal_sandbox must be true or false' };
  }

  if (key === 'lavalink_port') {
    const port = Number(value);
    if (!/^\d+$/.test(value) || port < 1 || port > 65_535) {
      return { ok: false, error: 'lavalink_port must be an integer between 1 and 65535' };
    }
    return { ok: true, value: String(port) };
  }

  if (key === 'paypal_webhook_url' && value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
    } catch {
      return { ok: false, error: 'paypal_webhook_url must be a valid HTTP or HTTPS URL' };
    }
  }

  if (key === 'valkey_url' && value) {
    try {
      const url = new URL(value);
      if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('invalid protocol');
    } catch {
      return { ok: false, error: 'valkey_url must be a valid redis:// or rediss:// URL' };
    }
  }

  return { ok: true, value };
}

function envValue(key: string): string | null {
  for (const name of ENV_MAP[key] ?? []) {
    const value = process.env[name];
    if (value) return value;
  }
  return null;
}

function mask(value: string): string {
  return value.length <= 4 ? '••••••••' : `••••••••${value.slice(-4)}`;
}

export async function readInstallationSettings(admin: AdminSupabase) {
  const values: Record<string, string> = {};
  const sources: Record<string, 'env' | 'db' | 'none'> = {};
  const environmentFallbacks: Record<string, boolean> = {};

  for (const key of Object.keys(ENV_MAP)) {
    const value = envValue(key);
    environmentFallbacks[key] = Boolean(value);
    if (!value) continue;
    values[key] = SECRET_FIELDS.has(key) ? mask(value) : value;
    sources[key] = 'env';
  }
  for (const [key, value] of Object.entries(INSTALLATION_DEFAULTS)) {
    values[key] = value;
    sources[key] = 'none';
  }

  const { data: settings, error: settingsError } = await admin
    .from('instance_settings')
    .select('key, value, section')
    .limit(1000);
  if (settingsError) {
    throw new Error('Failed to load authoritative installation settings');
  }
  for (const row of settings ?? []) {
    const encryptedBaseKey = row.key.endsWith('_encrypted')
      ? row.key.slice(0, -'_encrypted'.length)
      : null;
    if (
      !ALLOWED_SETTING_KEYS.has(row.key)
      && !(encryptedBaseKey && SECRET_FIELDS.has(encryptedBaseKey))
    ) continue;
    if (
      encryptedBaseKey
      && SECRET_FIELDS.has(encryptedBaseKey)
      && !BOOTSTRAP_ONLY_FIELDS.has(encryptedBaseKey)
      && row.value
    ) {
      values[encryptedBaseKey] = '••••••••';
      sources[encryptedBaseKey] = 'db';
    } else if (SECRET_FIELDS.has(row.key)) {
      continue;
    } else if (row.value && !BOOTSTRAP_ONLY_FIELDS.has(row.key)) {
      values[row.key] = row.value;
      sources[row.key] = 'db';
    }
  }

  const statuses: Record<string, 'connected' | 'disconnected' | 'bot-side'> = {
    supabase: values.supabase_url && values.supabase_secret_key ? 'connected' : 'disconnected',
    discord: 'disconnected',
    paypal: values.paypal_client_id && values.paypal_client_secret ? 'connected' : 'disconnected',
    lavalink: 'disconnected',
    valkey: 'disconnected',
  };
  const { data: guildRecord } = await admin
    .from('guild')
    .select('id, bot_role_position')
    .limit(1)
    .single();
  const botConfigured = Boolean(guildRecord);
  if ((values.discord_bot_token && values.discord_guild_id) || botConfigured) statuses.discord = 'connected';
  statuses.lavalink = values.lavalink_host && values.lavalink_port
    ? 'connected'
    : botConfigured ? 'bot-side' : 'disconnected';
  statuses.valkey = values.valkey_url
    ? 'connected'
    : botConfigured ? 'bot-side' : 'disconnected';

  return {
    values,
    statuses,
    sources,
    environmentFallbacks,
    lockedFields: [...BOOTSTRAP_ONLY_FIELDS],
  };
}

export async function claimInstallationSettingsWriteLease(
  admin: AdminSupabase,
  scope: string,
  operationId: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc('claim_instance_settings_write_lease', {
    p_scope: scope,
    p_operation_id: operationId,
    p_lease_seconds: 300,
  });
  if (error) throw new Error('Failed to claim the installation settings write lease');
  return data === true;
}

export async function releaseInstallationSettingsWriteLease(
  admin: AdminSupabase,
  scope: string,
  operationId: string,
): Promise<void> {
  const { error } = await admin.rpc('release_instance_settings_write_lease', {
    p_scope: scope,
    p_operation_id: operationId,
  });
  if (error) throw new Error('Failed to release the installation settings write lease');
}
