/**
 * Integration test: nextval_ticket assigns ticket numbers PER GUILD, atomically.
 *
 * Regression guard for two bugs:
 *  1. nextval_ticket() was a single GLOBAL MAX(ticket_number)+1 counter, so a
 *     second guild's first ticket inherited the first guild's numbering.
 *  2. Even once per-guild, MAX+1 was non-atomic with no unique backstop, so two
 *     draws in one guild before either row committed both returned the same
 *     number. It is now a durable per-guild counter (guild_ticket_counters) drawn
 *     via an atomic INSERT ... ON CONFLICT DO UPDATE, with a unique index on
 *     tickets(guild_id, ticket_number).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const GUILD_A = `test-tnum-A-${Date.now()}`;
const GUILD_B = `test-tnum-B-${Date.now()}`;

beforeAll(async () => {
  supa = await requireSupabase();
  await supa.from('guild').insert([
    { id: GUILD_A, name: 'Ticket Num A', owner_discord_id: '1' },
    { id: GUILD_B, name: 'Ticket Num B', owner_discord_id: '2' },
  ]);
});

afterAll(async () => {
  for (const g of [GUILD_A, GUILD_B]) {
    await supa.from('tickets').delete().eq('guild_id', g);
    await supa.from('ticket_transcripts').delete().eq('guild_id', g);
    await supa.from('guild_ticket_counters').delete().eq('guild_id', g);
    await supa.from('guild').delete().eq('id', g);
  }
});

async function nextTicket(guildId: string): Promise<number> {
  const { data, error } = await supa.rpc('nextval_ticket', { p_guild_id: guildId });
  expect(error).toBeNull();
  return data as number;
}

describe('nextval_ticket per-guild atomic numbering', () => {
  it('assigns distinct sequential numbers per guild, independent across guilds', async () => {
    // Two draws in GUILD_A BEFORE any ticket row exists must be distinct — the
    // old MAX+1 read returned the same number for both under this race.
    const a1 = await nextTicket(GUILD_A);
    const a2 = await nextTicket(GUILD_A);
    expect(a1).toBe(1);
    expect(a2).toBe(2);

    // A brand-new guild starts its OWN sequence, unaffected by GUILD_A's draws.
    expect(await nextTicket(GUILD_B)).toBe(1);
    expect(await nextTicket(GUILD_B)).toBe(2);

    // GUILD_A continues its own sequence, unaffected by GUILD_B.
    expect(await nextTicket(GUILD_A)).toBe(3);
  });

  it('never reissues a number under concurrent draws', async () => {
    const draws = await Promise.all(Array.from({ length: 10 }, () => nextTicket(GUILD_A)));
    // All draws are distinct (the atomic counter serializes concurrent callers).
    expect(new Set(draws).size).toBe(draws.length);
  });
});
