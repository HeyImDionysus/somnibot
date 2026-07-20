/**
 * Integration test: member numbering (get_next_member_number + recordMemberJoin).
 *
 * Guards two regressions:
 *   1. get_next_member_number read a non-existent relation (public.guild_members)
 *      → 42P01 on every call, so numbering always fell to a non-atomic fallback.
 *   2. Under a race two joins drew the same number; the uniq_member_number_per_guild
 *      index rejected the loser (23505) and recordMemberJoin returned null — the
 *      member got no row, number, or welcome. recordMemberJoin now retries.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { GuildMember } from 'discord.js';
import { requireSupabase } from './helpers.js';
import { recordMemberJoin } from '../../features/welcome/member-service.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-membernum-${Date.now()}`;

function mockMember(discordId: string, tag: string): GuildMember {
  return {
    id: discordId,
    guild: { id: GUILD_ID },
    user: { tag, displayAvatarURL: () => `https://cdn.example/${discordId}.png` },
  } as unknown as GuildMember;
}

beforeAll(async () => {
  supa = await requireSupabase();
  await supa.from('guild').insert({ id: GUILD_ID, name: 'Member Num Test', owner_discord_id: '1' });
});

afterAll(async () => {
  await supa.from('members').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('member numbering', () => {
  it('get_next_member_number returns MAX+1 without erroring (relation fixed)', async () => {
    await supa.from('members').insert({ guild_id: GUILD_ID, discord_id: 'seed', username: 'seed', member_number: 3 });
    const { data, error } = await supa.rpc('get_next_member_number', { p_guild_id: GUILD_ID });
    expect(error).toBeNull(); // pre-fix: 42P01 relation "public.guild_members" does not exist
    expect(Number(data)).toBe(4);
    await supa.from('members').delete().eq('guild_id', GUILD_ID).eq('discord_id', 'seed');
  });

  it('concurrent joins each get a distinct number — no dropped join', async () => {
    const joiners = ['aaa', 'bbb', 'ccc', 'ddd'].map((id) => mockMember(id, `user-${id}`));
    const results = await Promise.all(joiners.map((m) => recordMemberJoin(supa, m, false)));

    // Every join produced a member row (pre-fix: the race dropped losers to null).
    expect(results.every((r) => r !== null)).toBe(true);
    const numbers = results.map((r) => r!.member_number as number);
    expect(new Set(numbers).size).toBe(numbers.length); // all distinct

    const { data: rows } = await supa
      .from('members')
      .select('discord_id, member_number')
      .eq('guild_id', GUILD_ID);
    expect((rows ?? []).length).toBe(joiners.length);
  });
});
