/**
 * Integration test: Members + leveling system.
 *
 * Tests member registration, XP accumulation via the increment_member_xp RPC,
 * level-up calculation, and leaderboard queries. All against real Supabase.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-levels-guild-${Date.now()}`;
const MEMBER_A = 'discord-user-aaa';
const MEMBER_B = 'discord-user-bbb';
const MEMBER_C = 'discord-user-ccc';

beforeAll(async () => {
  supa = await requireSupabase();

  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Levels Test Guild',
    owner_discord_id: '999888777',
  });
});

afterAll(async () => {
  await supa.from('member_levels').delete().eq('guild_id', GUILD_ID);
  await supa.from('members').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('Members', () => {
  it('registers a new member with correct defaults', async () => {
    const { data, error } = await supa
      .from('members')
      .insert({
        guild_id: GUILD_ID,
        discord_id: MEMBER_A,
        username: 'Alice',
        joined_at: new Date().toISOString(),
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.guild_id).toBe(GUILD_ID);
    expect(data!.discord_id).toBe(MEMBER_A);
    expect(data!.username).toBe('Alice');
    expect(data!.onboarding_completed).toBe(false);
    expect(data!.is_returning).toBe(false);
    expect(data!.roles).toEqual([]);
  });

  it('enforces unique (guild_id, discord_id) constraint', async () => {
    const { error } = await supa.from('members').insert({
      guild_id: GUILD_ID,
      discord_id: MEMBER_A,
      username: 'Alice Duplicate',
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('23505');
  });

  it('tracks a returning member correctly', async () => {
    await supa.from('members').insert({
      guild_id: GUILD_ID,
      discord_id: MEMBER_B,
      username: 'Bob',
    });

    await supa
      .from('members')
      .update({ left_at: new Date().toISOString() })
      .eq('guild_id', GUILD_ID)
      .eq('discord_id', MEMBER_B);

    const { data } = await supa
      .from('members')
      .update({
        left_at: null,
        is_returning: true,
        joined_at: new Date().toISOString(),
      })
      .eq('guild_id', GUILD_ID)
      .eq('discord_id', MEMBER_B)
      .select()
      .single();

    expect(data!.is_returning).toBe(true);
    expect(data!.left_at).toBeNull();
  });
});

describe('Leveling (increment_member_xp RPC)', () => {
  it('creates a level record on first XP gain', async () => {
    const { data, error } = await supa.rpc('increment_member_xp', {
      p_guild_id: GUILD_ID,
      p_member_id: MEMBER_A,
      p_xp_amount: 50,
    });

    expect(error).toBeNull();
    expect(data).toBeDefined();
    const row = Array.isArray(data) ? data[0] : data;
    expect(row.new_xp).toBe(50);
    expect(row.new_level).toBe(0);
    expect(row.leveled_up).toBe(false);
  });

  it('accumulates XP and levels up at 100 XP per level', async () => {
    // Add 60 more XP → 110 total → level 1
    const { data, error } = await supa.rpc('increment_member_xp', {
      p_guild_id: GUILD_ID,
      p_member_id: MEMBER_A,
      p_xp_amount: 60,
    });

    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : data;
    expect(row.new_xp).toBe(110);
    expect(row.new_level).toBe(1);     // floor(110 / 100) = 1
    expect(row.leveled_up).toBe(true);
  });

  it('leaderboard query returns members ordered by XP', async () => {
    // Give Member C more XP than A
    await supa.rpc('increment_member_xp', {
      p_guild_id: GUILD_ID,
      p_member_id: MEMBER_C,
      p_xp_amount: 500,
    });

    const { data, error } = await supa
      .from('member_levels')
      .select('member_id, xp, level')
      .eq('guild_id', GUILD_ID)
      .order('xp', { ascending: false });

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(2);
    expect(data![0].member_id).toBe(MEMBER_C);
    expect(data![0].xp).toBe(500);
    expect(data![1].member_id).toBe(MEMBER_A);
    expect(data![1].xp).toBe(110);
  });

  it('tracks a message tick and voice minutes on the member row (the real bot contract)', async () => {
    const MEMBER_D = 'discord-user-ddd';
    // A message-XP grant increments total_messages by one and adds XP.
    await supa.rpc('increment_member_xp', {
      p_guild_id: GUILD_ID,
      p_member_id: MEMBER_D,
      p_xp_amount: 25,
      p_increment_messages: true,
      p_voice_minutes: 0,
    });
    // A voice-XP grant adds voice minutes (no message tick).
    const { data, error } = await supa.rpc('increment_member_xp', {
      p_guild_id: GUILD_ID,
      p_member_id: MEMBER_D,
      p_xp_amount: 40,
      p_increment_messages: false,
      p_voice_minutes: 15,
    });

    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : data;
    expect(row.new_xp).toBe(65);

    const { data: stored } = await supa
      .from('member_levels')
      .select('xp, total_messages, voice_minutes')
      .eq('guild_id', GUILD_ID)
      .eq('member_id', MEMBER_D)
      .single();
    expect(stored!.xp).toBe(65);
    expect(stored!.total_messages).toBe(1);
    expect(stored!.voice_minutes).toBe(15);
  });

  it('floors XP at zero on an /xp remove (negative amount)', async () => {
    const MEMBER_E = 'discord-user-eee';
    await supa.rpc('increment_member_xp', {
      p_guild_id: GUILD_ID,
      p_member_id: MEMBER_E,
      p_xp_amount: 150,
    });
    const { data, error } = await supa.rpc('increment_member_xp', {
      p_guild_id: GUILD_ID,
      p_member_id: MEMBER_E,
      p_xp_amount: -1000, // remove more than the member has
    });

    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : data;
    expect(row.new_xp).toBe(0); // floored, never negative
    expect(row.new_level).toBe(0);
    expect(row.leveled_up).toBe(false);
  });
});
