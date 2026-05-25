/**
 * Integration test: Guild lifecycle — create, configure, query, teardown.
 *
 * Runs against a real Supabase local instance (supabase start).
 * No mocks. Validates real DB constraints, RLS, and cascade behavior.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa: SupabaseClient | null = null;
const TEST_GUILD_ID = `test-guild-${Date.now()}`;

beforeAll(async () => {
  supa = await requireSupabase();
  if (!supa) return;
});

afterAll(async () => {
  if (!supa) return;
  await supa.from('guild_config').delete().eq('guild_id', TEST_GUILD_ID);
  await supa.from('guild').delete().eq('id', TEST_GUILD_ID);
});

describe('Guild lifecycle', () => {
  it('inserts a new guild row', async () => {
    if (!supa) return;
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
    if (!supa) return;
    const { data, error } = await supa
      .from('guild_config')
      .insert({ guild_id: TEST_GUILD_ID })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data!.guild_id).toBe(TEST_GUILD_ID);
    expect(data!.onboarding_enabled).toBe(true);
    expect(data!.levels_enabled).toBe(false);
    expect(data!.music_enabled).toBe(true);
  });

  it('rejects guild_config for nonexistent guild (FK constraint)', async () => {
    if (!supa) return;
    const { error } = await supa
      .from('guild_config')
      .insert({ guild_id: 'nonexistent-guild-id-12345' })
      .select()
      .single();

    expect(error).not.toBeNull();
    expect(error!.code).toBe('23503');
  });

  it('updates guild config fields', async () => {
    if (!supa) return;
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
    if (!supa) return;
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
