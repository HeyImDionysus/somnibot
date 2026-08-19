import { decryptCloudCredential } from '@/lib/cloud-credential-crypto';
import { createAdminSupabase } from '@/lib/supabase/admin';

const DISCORD_RUNTIME_SETTING_KEYS = [
  'discord_application_id',
  'discord_client_secret_encrypted',
] as const;

export interface DiscordRuntimeConfig {
  applicationId: string;
  clientSecret: string;
  sources: {
    applicationId: 'env' | 'saved' | 'missing';
    clientSecret: 'env' | 'saved' | 'missing';
  };
}

export async function getDiscordRuntimeConfig(): Promise<DiscordRuntimeConfig> {
  const config: DiscordRuntimeConfig = {
    applicationId: process.env.DISCORD_APPLICATION_ID?.trim() ?? '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() ?? '',
    sources: {
      applicationId: process.env.DISCORD_APPLICATION_ID ? 'env' : 'missing',
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

  const encryptedSecret = data.find((row) => row.key === 'discord_client_secret_encrypted')?.value;
  if (encryptedSecret) {
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
      encryptedSecret,
      'discord_client_secret',
      bootstrapSecret,
      new URL(supabaseUrl).origin,
    );
    if (!savedSecret) throw new Error('saved Discord client secret could not be decrypted');
    config.clientSecret = savedSecret;
    config.sources.clientSecret = 'saved';
  }

  return config;
}
