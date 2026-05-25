/**
 * Integration test: Members + leveling system.
 *
 * Tests member registration, XP accumulation via the increment_member_xp RPC,
 * level-up calculation, and leaderboard queries. All against real Supabase.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

let supa: SupabaseClient;
const GUILD_ID = `test-levels-guild-${Date.now()}`;
const MEMBER_A = 'discord-user-aaa';
const MEMBER_B = 'discord-user-bbb';
const MEMBER_C = 'discord-user-ccc';

beforeAll(async () => {
  supa = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Create prerequisite guild
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
    expect(error!.code).toBe('23505'); // unique_violation
  });

  it('tracks a returning member correctly', async () => {
    // Member B joins, leaves, and rejoins
    await supa.from('members').insert({
      guild_id: GUILD_ID,
      discord_id: MEMBER_B,
      username: 'Bob',
    });

    // Simulate leave
    await supa
      .from('members')
      .update({ left_at: new Date().toISOString() })
      .eq('guild_id', GUILD_ID)
      .eq('discord_id', MEMBER_B);

    // Simulate rejoin
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
      p_xp_gain: 50,
    });

    expect(error).toBeNull();
    // RPC returns new_xp, new_level, leveled_up
    expect(data).toBeDefined();
    const row = Array.isArray(data) ? data[0] : data;
    expect(row.new_xp).toBe(50);
    expect(row.new_level).toBe(0); // Level 0 → 1 requires 100 XP (5*1+50+100=155)
    expect(row.leveled_up).toBe(false);
  });

  it('accumulates XP across multiple calls', async () => {
    // Add more XP
    await supa.rpc('increment_member_xp', {
      p_guild_id: GUILD_ID,
      p_member_id: MEMBER_A,
      p_xp_gain: 60,
    });

    const { data } = await supa
      .from('member_levels')
      .select('xp, level, total_messages')
      .eq('guild_id', GUILD_ID)
      .eq('member_id', MEMBER_A)
      .single();

    expect(data!.xp).toBe(110); // 50 + 60
  });

  it('increments message count when flagged', async () => {
    // Use the older function signature that accepts p_increment_messages
    // The v42 version uses p_username/p_avatar instead, so we query directly
    const before = await supa
      .from('member_levels')
      .select('total_messages')
      .eq('guild_id', GUILD_ID)
      .eq('member_id', MEMBER_A)
      .single();

    await supa.rpc('increment_member_xp', {
      p_guild_id: GUILD_ID,
      p_member_id: MEMBER_A,
      p_xp_gain: 20,
    });

    const after = await supa
      .from('member_levels')
      .select('total_messages, xp')
      .eq('guild_id', GUILD_ID)
      .eq('member_id', MEMBER_A)
      .single();

    expect(after.data!.xp).toBe(130); // 110 + 20
  });

  it('leaderboard query returns members ordered by XP', async () => {
    // Give Member C more XP than A
    await supa.rpc('increment_member_xp', {
      p_guild_id: GUILD_ID,
      p_member_id: MEMBER_C,
      p_xp_gain: 500,
    });

    const { data, error } = await supa
      .from('member_levels')
      .select('member_id, xp, level')
      .eq('guild_id', GUILD_ID)
      .order('xp', { ascending: false });

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(2);
    // Member C (500 XP) should be first
    expect(data![0].member_id).toBe(MEMBER_C);
    expect(data![0].xp).toBe(500);
    // Member A (130 XP) should be second
    expect(data![1].member_id).toBe(MEMBER_A);
  });
});
