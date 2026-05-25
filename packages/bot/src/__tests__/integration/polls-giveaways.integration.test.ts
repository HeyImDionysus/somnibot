/**
 * Integration test: Polls + Giveaways — create, vote, end lifecycle.
 *
 * Tests the full lifecycle of polls (create → vote → close → tally)
 * and giveaways (create → enter → end → winners). Real Supabase.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa: SupabaseClient;
const GUILD_ID = `test-polls-guild-${Date.now()}`;

beforeAll(async () => {
  supa = await requireSupabase();

  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Polls Test Guild',
    owner_discord_id: '777888999',
  });
  await supa.from('guild_config').insert({ guild_id: GUILD_ID });
});

afterAll(async () => {
  const { data: pollRows } = await supa.from('polls').select('id').eq('guild_id', GUILD_ID);
  const pollIds = (pollRows ?? []).map((p) => p.id);
  if (pollIds.length > 0) {
    await supa.from('poll_votes').delete().in('poll_id', pollIds);
    await supa.from('poll_options').delete().in('poll_id', pollIds);
  }
  await supa.from('polls').delete().eq('guild_id', GUILD_ID);
  await supa.from('giveaways').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('Polls lifecycle', () => {
  let pollId: string;
  let optionAId: string;
  let optionBId: string;

  it('creates a poll', async () => {
    const { data, error } = await supa
      .from('polls')
      .insert({
        guild_id: GUILD_ID,
        channel_id: 'channel-001',
        creator_user_id: 'user-poll-creator',
        title: 'Best programming language?',
        description: 'Vote for your favorite',
        allow_multiple: false,
        ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.title).toBe('Best programming language?');
    expect(data!.status).toBe('active');
    pollId = data!.id;
  });

  it('adds options to the poll', async () => {
    const { data, error } = await supa
      .from('poll_options')
      .insert([
        { poll_id: pollId, label: 'TypeScript', emoji: '🔷', sort_order: 0 },
        { poll_id: pollId, label: 'Rust', emoji: '🦀', sort_order: 1 },
        { poll_id: pollId, label: 'Python', emoji: '🐍', sort_order: 2 },
      ])
      .select();

    expect(error).toBeNull();
    expect(data!.length).toBe(3);
    optionAId = data!.find((o) => o.label === 'TypeScript')!.id;
    optionBId = data!.find((o) => o.label === 'Rust')!.id;
  });

  it('records votes from different users', async () => {
    const votes = [
      { poll_id: pollId, option_id: optionAId, user_id: 'voter-1' },
      { poll_id: pollId, option_id: optionAId, user_id: 'voter-2' },
      { poll_id: pollId, option_id: optionBId, user_id: 'voter-3' },
    ];

    const { error } = await supa.from('poll_votes').insert(votes);
    expect(error).toBeNull();
  });

  it('enforces unique vote per user per option (UNIQUE constraint)', async () => {
    const { error } = await supa.from('poll_votes').insert({
      poll_id: pollId,
      option_id: optionAId,
      user_id: 'voter-1',
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('23505');
  });

  it('tallies votes correctly', async () => {
    const { data: tsVotes } = await supa
      .from('poll_votes')
      .select('id')
      .eq('poll_id', pollId)
      .eq('option_id', optionAId);

    const { data: rustVotes } = await supa
      .from('poll_votes')
      .select('id')
      .eq('poll_id', pollId)
      .eq('option_id', optionBId);

    expect(tsVotes!.length).toBe(2);
    expect(rustVotes!.length).toBe(1);
  });

  it('closes a poll', async () => {
    const { data, error } = await supa
      .from('polls')
      .update({
        status: 'closed',
        closed_at: new Date().toISOString(),
      })
      .eq('id', pollId)
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.status).toBe('closed');
    expect(data!.closed_at).toBeDefined();
  });
});

describe('Giveaways lifecycle', () => {
  let giveawayId: string;

  it('creates a giveaway', async () => {
    const { data, error } = await supa
      .from('giveaways')
      .insert({
        guild_id: GUILD_ID,
        channel_id: 'channel-giveaway',
        prize: 'Nitro Classic (1 month)',
        winner_count: 1,
        ends_at: new Date(Date.now() + 3600_000).toISOString(),
        status: 'active',
        created_by: 'admin-giveaway',
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.prize).toBe('Nitro Classic (1 month)');
    expect(data!.status).toBe('active');
    expect(data!.entries).toEqual([]);
    giveawayId = data!.id;
  });

  it('adds entries to the giveaway', async () => {
    const { data, error } = await supa
      .from('giveaways')
      .update({
        entries: ['user-ga-1', 'user-ga-2', 'user-ga-3'],
      })
      .eq('id', giveawayId)
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.entries).toHaveLength(3);
    expect(data!.entries).toContain('user-ga-1');
  });

  it('ends a giveaway with a winner', async () => {
    const { data, error } = await supa
      .from('giveaways')
      .update({
        status: 'ended',
        ended_at: new Date().toISOString(),
        winners: ['user-ga-2'],
      })
      .eq('id', giveawayId)
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.status).toBe('ended');
    expect(data!.winners).toEqual(['user-ga-2']);
  });

  it('rejects invalid giveaway status (CHECK constraint)', async () => {
    const { error } = await supa
      .from('giveaways')
      .insert({
        guild_id: GUILD_ID,
        channel_id: 'ch-invalid',
        prize: 'Bad Prize',
        winner_count: 1,
        ends_at: new Date().toISOString(),
        status: 'invalid_status',
        created_by: 'admin',
      });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('23514');
  });
});
