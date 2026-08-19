import { decryptCloudCredential } from '@/lib/cloud-credential-crypto';
import { createAdminSupabase } from '@/lib/supabase/admin';

const DISCORD_RUNTIME_SETTING_KEYS = [
  'discord_application_id',
  'discord_bot_token_encrypted',
  'discord_client_secret_encrypted',
] as const;

export interface DiscordRuntimeConfig {
  applicationId: string;
  botToken: string;
  clientSecret: string;
  sources: {
    applicationId: 'env' | 'saved' | 'missing';
    botToken: 'env' | 'saved' | 'missing';
    clientSecret: 'env' | 'saved' | 'missing';
  };
}

export async function getDiscordRuntimeConfig(): Promise<DiscordRuntimeConfig> {
  const config: DiscordRuntimeConfig = {
    applicationId: process.env.DISCORD_APPLICATION_ID?.trim() ?? '',
    botToken: process.env.DISCORD_TOKEN?.trim() ?? '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() ?? '',
    sources: {
      applicationId: process.env.DISCORD_APPLICATION_ID ? 'env' : 'missing',
      botToken: process.env.DISCORD_TOKEN ? 'env' : 'missing',
      clientSecret: process.env.DISCORD_CLIENT_SECRET ? 'env' : 'missing',
    },
  };

  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from('instance_settings')
    .select('key, value')
    .in('key', [...DISCORD_RUNTIME_SETTING_KEYS])
    .limit(1000);
  if (error) throw new Error(`saved Discord settings query failed: ${error.message}`);
  if (!Array.isArray(data)) throw new Error('saved Discord settings query returned an invalid result');

  const savedApplicationId = data.find((row) => row.key === 'discord_application_id')?.value?.trim();
  if (savedApplicationId) {
    config.applicationId = savedApplicationId;
    config.sources.applicationId = 'saved';
  }

  const encryptedSecrets = [
    { rowKey: 'discord_bot_token_encrypted', baseKey: 'discord_bot_token', target: 'botToken' },
    { rowKey: 'discord_client_secret_encrypted', baseKey: 'discord_client_secret', target: 'clientSecret' },
  ] as const;
  for (const encryptedSecret of encryptedSecrets) {
    const encryptedValue = data.find((row) => row.key === encryptedSecret.rowKey)?.value;
    if (!encryptedValue) continue;
    const bootstrapSecret = process.env.SUPABASE_SECRET_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '';
    const supabaseUrl = process.env.SUPABASE_URL
      || process.env.NEXT_PUBLIC_SUPABASE_URL
      || '';
    if (!bootstrapSecret || !supabaseUrl) {
      throw new Error('Supabase bootstrap credentials are required to decrypt saved Discord settings');
    }
    const savedSecret = decryptCloudCredential(
      encryptedValue,
      encryptedSecret.baseKey,
      bootstrapSecret,
      new URL(supabaseUrl).origin,
    );
    if (!savedSecret) throw new Error(`saved ${encryptedSecret.baseKey} could not be decrypted`);
    config[encryptedSecret.target] = savedSecret;
    config.sources[encryptedSecret.target] = 'saved';
  }

  return config;
}
