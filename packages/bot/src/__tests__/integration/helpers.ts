/**
 * Integration test helpers — Supabase local setup and seed utilities.
 *
 * V5 Audit Fix #2 — Real DB, zero mocks.
 *
 * Uses Supabase local instance (npx supabase start).
 * Default local credentials from Supabase CLI:
 *   URL:  http://127.0.0.1:54321
 *   Key:  service_role key from `npx supabase status`
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Supabase local defaults (from `npx supabase start`)
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
// Service role key from Supabase local (safe — this is a local dev instance)
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

let _supabase: SupabaseClient | null = null;

/**
 * Get a Supabase admin client for integration tests.
 * Uses service_role key to bypass RLS for setup/teardown.
 */
export function getTestSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _supabase;
}

const TEST_GUILD_ID = 'integration-test-guild-001';
const TEST_USER_ID = 'integration-test-user-001';
const TEST_USER_ID_2 = 'integration-test-user-002';

export { TEST_GUILD_ID, TEST_USER_ID, TEST_USER_ID_2 };

/**
 * Seed minimal guild config for tests.
 */
export async function seedGuildConfig(supabase: SupabaseClient): Promise<void> {
  await supabase.from('guild_config').upsert(
    {
      guild_id: TEST_GUILD_ID,
      economy_enabled: true,
      levels_enabled: true,
      store_enabled: true,
    },
    { onConflict: 'guild_id' },
  );
}

/**
 * Seed a license key for testing.
 */
export async function seedLicenseKey(
  supabase: SupabaseClient,
  opts: { key: string; productId: string; maxActivations?: number },
): Promise<string> {
  const { data } = await supabase
    .from('license_keys')
    .upsert(
      {
        guild_id: TEST_GUILD_ID,
        product_id: opts.productId,
        key_hash: opts.key, // In real code this is hashed, for tests we use plaintext
        license_key: opts.key,
        max_activations: opts.maxActivations ?? 3,
        status: 'active',
        created_by: TEST_USER_ID,
      },
      { onConflict: 'guild_id,license_key' },
    )
    .select('id')
    .single();

  return data?.id ?? '';
}

/**
 * Seed an economy wallet for testing.
 */
export async function seedWallet(
  supabase: SupabaseClient,
  userId: string,
  balance = 1000,
): Promise<void> {
  await supabase.from('economy_wallets').upsert(
    {
      guild_id: TEST_GUILD_ID,
      user_id: userId,
      wallet: balance,
      bank: 0,
      suspended: false,
    },
    { onConflict: 'guild_id,user_id' },
  );
}

/**
 * Clean up all test data (call in afterAll).
 */
export async function cleanupTestData(supabase: SupabaseClient): Promise<void> {
  const tables = [
    'economy_wallets',
    'economy_transactions',
    'license_keys',
    'license_sessions',
    'guild_config',
    'audit_log',
  ];

  for (const table of tables) {
    await supabase.from(table).delete().eq('guild_id', TEST_GUILD_ID);
  }
}
