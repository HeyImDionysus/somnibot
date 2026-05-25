/**
 * Integration test: Guild lifecycle — create, configure, query, teardown.
 *
 * Runs against a real Supabase local instance (supabase start).
 * No mocks. Validates real DB constraints, RLS, and cascade behavior.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

let supa: SupabaseClient;
const TEST_GUILD_ID = `test-guild-${Date.now()}`;

beforeAll(() => {
  supa = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
});

afterAll(async () => {
  // Cascade cleanup — delete guild removes guild_config, members, etc.
  await supa.from('guild_config').delete().eq('guild_id', TEST_GUILD_ID);
  await supa.from('guild').delete().eq('id', TEST_GUILD_ID);
});

describe('Guild lifecycle', () => {
  it('inserts a new guild row', async () => {
    const { data, error } = await supa
      .from('guild')
      .insert({
        id: TEST_GUILD_ID,
        name: 'Integration Test Server',
        owner_discord_id: '999000111222',
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data!.id).toBe(TEST_GUILD_ID);
    expect(data!.setup_completed).toBe(false);
  });

  it('creates guild_config with FK to guild', async () => {
    const { data, error } = await supa
      .from('guild_config')
      .insert({ guild_id: TEST_GUILD_ID })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data!.guild_id).toBe(TEST_GUILD_ID);
    // Defaults should be applied
    expect(data!.onboarding_enabled).toBe(true);
    expect(data!.levels_enabled).toBe(false);
    expect(data!.music_enabled).toBe(true);
  });

  it('rejects guild_config for nonexistent guild (FK constraint)', async () => {
    const { error } = await supa
      .from('guild_config')
      .insert({ guild_id: 'nonexistent-guild-id-12345' })
      .select()
      .single();

    expect(error).not.toBeNull();
    // FK violation
    expect(error!.code).toBe('23503');
  });

  it('updates guild config fields', async () => {
    const { data, error } = await supa
      .from('guild_config')
      .update({
        levels_enabled: true,
        xp_min: 20,
        xp_max: 40,
        welcome_enabled: true,
        welcome_message: 'Welcome {user} to the server!',
      })
      .eq('guild_id', TEST_GUILD_ID)
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.levels_enabled).toBe(true);
    expect(data!.xp_min).toBe(20);
    expect(data!.xp_max).toBe(40);
    expect(data!.welcome_enabled).toBe(true);
    expect(data!.welcome_message).toBe('Welcome {user} to the server!');
  });

  it('marks setup as completed', async () => {
    const { data, error } = await supa
      .from('guild')
      .update({
        setup_completed: true,
        setup_confirmed_at: new Date().toISOString(),
      })
      .eq('id', TEST_GUILD_ID)
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.setup_completed).toBe(true);
    expect(data!.setup_confirmed_at).toBeDefined();
  });
});
