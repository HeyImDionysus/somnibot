import { decryptCloudCredential } from '@/lib/cloud-credential-crypto';
import { createAdminSupabase } from '@/lib/supabase/admin';

export async function getSavedInstallationRuntimeSecret(key: string): Promise<string | null> {
  const bootstrapSecret = process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || '';
  const supabaseUrl = process.env.SUPABASE_URL
    || process.env.NEXT_PUBLIC_SUPABASE_URL
    || '';
  if (!bootstrapSecret || !supabaseUrl) return null;

  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from('instance_settings')
    .select('key, value')
    .eq('key', `${key}_encrypted`)
    .maybeSingle();
  if (error) throw new Error(`saved ${key} query failed: ${error.message}`);
  if (!data?.value) return null;

  const decrypted = decryptCloudCredential(
    data.value,
    key,
    bootstrapSecret,
    new URL(supabaseUrl).origin,
  );
  if (!decrypted) throw new Error(`saved ${key} could not be decrypted`);
  return decrypted.trim();
}

export async function getInstallationRuntimeSecret(
  key: string,
  environmentNames: string[],
): Promise<string> {
  const saved = await getSavedInstallationRuntimeSecret(key);
  if (saved) return saved;
  return environmentNames
    .map((name) => process.env[name]?.trim())
    .find((value): value is string => Boolean(value)) ?? '';
}
