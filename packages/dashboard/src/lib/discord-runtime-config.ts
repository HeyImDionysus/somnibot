import { decryptCloudCredential } from '@/lib/cloud-credential-crypto';
import { createAdminSupabase } from '@/lib/supabase/admin';

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

export type DiscordOAuthRuntimeConfig = Pick<
  DiscordRuntimeConfig,
  'applicationId' | 'clientSecret'
> & {
  sources: Pick<DiscordRuntimeConfig['sources'], 'applicationId' | 'clientSecret'>;
};

export type DiscordBotRuntimeConfig = Pick<DiscordRuntimeConfig, 'botToken'> & {
  sources: Pick<DiscordRuntimeConfig['sources'], 'botToken'>;
};

type SavedDiscordSetting = { key: string; value: string };

async function readSavedDiscordSettings(keys: readonly string[]): Promise<SavedDiscordSetting[]> {
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from('instance_settings')
    .select('key, value')
    .in('key', [...keys])
    .limit(1000);
  if (error) throw new Error(`saved Discord settings query failed: ${error.message}`);
  if (!Array.isArray(data)) throw new Error('saved Discord settings query returned an invalid result');
  return data;
}

function decryptSavedDiscordSecret(
  data: readonly SavedDiscordSetting[],
  rowKey: string,
  baseKey: string,
): string | null {
  const encryptedValue = data.find((row) => row.key === rowKey)?.value;
  if (!encryptedValue) return null;
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
    baseKey,
    bootstrapSecret,
    new URL(supabaseUrl).origin,
  );
  if (!savedSecret) throw new Error(`saved ${baseKey} could not be decrypted`);
  return savedSecret;
}

export async function getDiscordOAuthRuntimeConfig(): Promise<DiscordOAuthRuntimeConfig> {
  const config: DiscordOAuthRuntimeConfig = {
    applicationId: process.env.DISCORD_APPLICATION_ID?.trim() ?? '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() ?? '',
    sources: {
      applicationId: process.env.DISCORD_APPLICATION_ID ? 'env' : 'missing',
      clientSecret: process.env.DISCORD_CLIENT_SECRET ? 'env' : 'missing',
    },
  };
  const data = await readSavedDiscordSettings([
    'discord_application_id',
    'discord_client_secret_encrypted',
  ]);

  const savedApplicationId = data.find((row) => row.key === 'discord_application_id')?.value?.trim();
  if (savedApplicationId) {
    config.applicationId = savedApplicationId;
    config.sources.applicationId = 'saved';
  }

  const savedClientSecret = decryptSavedDiscordSecret(
    data,
    'discord_client_secret_encrypted',
    'discord_client_secret',
  );
  if (savedClientSecret) {
    config.clientSecret = savedClientSecret;
    config.sources.clientSecret = 'saved';
  }

  return config;
}

export async function getDiscordBotRuntimeConfig(): Promise<DiscordBotRuntimeConfig> {
  const config: DiscordBotRuntimeConfig = {
    botToken: process.env.DISCORD_TOKEN?.trim() ?? '',
    sources: {
      botToken: process.env.DISCORD_TOKEN ? 'env' : 'missing',
    },
  };
  const data = await readSavedDiscordSettings(['discord_bot_token_encrypted']);
  const savedBotToken = decryptSavedDiscordSecret(
    data,
    'discord_bot_token_encrypted',
    'discord_bot_token',
  );
  if (savedBotToken) {
    config.botToken = savedBotToken;
    config.sources.botToken = 'saved';
  }
  return config;
}

export async function getDiscordRuntimeConfig(): Promise<DiscordRuntimeConfig> {
  const [oauth, bot] = await Promise.all([
    getDiscordOAuthRuntimeConfig(),
    getDiscordBotRuntimeConfig(),
  ]);
  return {
    applicationId: oauth.applicationId,
    botToken: bot.botToken,
    clientSecret: oauth.clientSecret,
    sources: { ...oauth.sources, ...bot.sources },
  };
}
