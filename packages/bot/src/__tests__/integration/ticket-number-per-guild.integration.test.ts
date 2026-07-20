/**
 * Integration test: nextval_ticket assigns ticket numbers PER GUILD.
 *
 * Regression guard for the bug where nextval_ticket() was MAX(ticket_number)+1
 * over the ENTIRE ticket_transcripts table — a single global counter, so a second
 * guild's first ticket inherited the first guild's numbering (and only looked at
 * closed transcripts, so open tickets could be re-numbered).
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
    await supa.from('guild').delete().eq('id', g);
  }
});

async function nextTicket(guildId: string): Promise<number> {
  const { data, error } = await supa.rpc('nextval_ticket', { p_guild_id: guildId });
  expect(error).toBeNull();
  return data as number;
}

describe('nextval_ticket per-guild numbering', () => {
  it("does not leak one guild's ticket count into another guild's numbering", async () => {
    // Guild A has 5 closed transcripts (#1..#5).
    await supa.from('ticket_transcripts').insert(
      [1, 2, 3, 4, 5].map((n) => ({
        guild_id: GUILD_A,
        ticket_number: n,
        creator_id: 'creator',
        closed_by_id: 'closer',
        message_count: 1,
        html_content: '<html></html>',
      })),
    );

    // A advances past its own max; B — which has NO tickets — starts at 1, not 6.
    expect(await nextTicket(GUILD_A)).toBe(6);
    expect(await nextTicket(GUILD_B)).toBe(1);

    // An OPEN (not-yet-closed) ticket also counts: after B opens #1, B's next is 2.
    await supa.from('tickets').insert({
      guild_id: GUILD_B,
      channel_id: 'chan-b-1',
      ticket_number: 1,
      creator_id: 'creator',
      type: 'support',
      status: 'open',
      message_count: 0,
    });
    expect(await nextTicket(GUILD_B)).toBe(2);
    // A is unaffected by B's activity.
    expect(await nextTicket(GUILD_A)).toBe(6);
  });
});
