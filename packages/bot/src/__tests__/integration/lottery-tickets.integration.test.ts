/**
 * Integration test: Lottery ticket purchases — lottery_buy_tickets RPC.
 *
 * Validates the atomic ticket-purchase RPC against a real Supabase
 * instance: tickets are inserted with ticket_number in [0, 9999], the
 * jackpot is incremented in the same transaction, and the max-ticket
 * guard raises without leaving partial state.
 *
 * Regression coverage for 20260709160000_fix_lottery_buy_tickets_search_path:
 * the v7 definition called gen_random_bytes() unqualified under
 * SET search_path = '', so every purchase raised "function
 * gen_random_bytes(integer) does not exist" at runtime.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-lottery-guild-${Date.now()}`;
const USER_ID = 'lottery-user-aaa';
let drawingId: string;

beforeAll(async () => {
  supa = await requireSupabase();

  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Lottery Test Guild',
    owner_discord_id: '444555666',
  });
  await supa.from('guild_config').insert({ guild_id: GUILD_ID });

  const { data, error } = await supa
    .from('economy_lottery_drawings')
    .insert({ guild_id: GUILD_ID, status: 'active', jackpot: 0 })
    .select()
    .single();
  if (error) throw new Error(`Failed to create drawing: ${error.message}`);
  drawingId = data!.id;
});

afterAll(async () => {
  await supa.from('economy_lottery_tickets').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_lottery_drawings').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('lottery_buy_tickets RPC', () => {
  it('inserts tickets with ticket_number in [0, 9999] and returns the incremented jackpot', async () => {
    const { data: newJackpot, error } = await supa.rpc('lottery_buy_tickets', {
      p_drawing_id: drawingId,
      p_guild_id: GUILD_ID,
      p_user_id: USER_ID,
      p_count: 3,
      p_max: 10,
      p_cost: 300,
    });

    expect(error).toBeNull();
    expect(newJackpot).toBe(300);

    const { data: tickets } = await supa
      .from('economy_lottery_tickets')
      .select('ticket_number')
      .eq('drawing_id', drawingId)
      .eq('user_id', USER_ID);

    expect(tickets!.length).toBe(3);
    for (const t of tickets!) {
      expect(Number.isInteger(t.ticket_number)).toBe(true);
      expect(t.ticket_number).toBeGreaterThanOrEqual(0);
      expect(t.ticket_number).toBeLessThanOrEqual(9999);
    }

    const { data: drawing } = await supa
      .from('economy_lottery_drawings')
      .select('jackpot')
      .eq('id', drawingId)
      .single();

    expect(drawing!.jackpot).toBe(300);
  });

  it('accumulates tickets and jackpot across purchases', async () => {
    const { data: newJackpot, error } = await supa.rpc('lottery_buy_tickets', {
      p_drawing_id: drawingId,
      p_guild_id: GUILD_ID,
      p_user_id: USER_ID,
      p_count: 2,
      p_max: 10,
      p_cost: 200,
    });

    expect(error).toBeNull();
    expect(newJackpot).toBe(500); // 300 + 200

    const { data: tickets } = await supa
      .from('economy_lottery_tickets')
      .select('id')
      .eq('drawing_id', drawingId)
      .eq('user_id', USER_ID);

    expect(tickets!.length).toBe(5);
  });

  it('raises when the purchase would exceed max tickets, leaving no partial state', async () => {
    // User holds 5 tickets; 5 + 6 > 10 must be rejected
    const { error } = await supa.rpc('lottery_buy_tickets', {
      p_drawing_id: drawingId,
      p_guild_id: GUILD_ID,
      p_user_id: USER_ID,
      p_count: 6,
      p_max: 10,
      p_cost: 600,
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain('would exceed max tickets');

    // Transaction rolled back — no tickets inserted, jackpot unchanged
    const { data: tickets } = await supa
      .from('economy_lottery_tickets')
      .select('id')
      .eq('drawing_id', drawingId)
      .eq('user_id', USER_ID);

    expect(tickets!.length).toBe(5);

    const { data: drawing } = await supa
      .from('economy_lottery_drawings')
      .select('jackpot')
      .eq('id', drawingId)
      .single();

    expect(drawing!.jackpot).toBe(500);
  });

  it('raises for a nonexistent drawing', async () => {
    const { error } = await supa.rpc('lottery_buy_tickets', {
      p_drawing_id: '00000000-0000-0000-0000-000000000000',
      p_guild_id: GUILD_ID,
      p_user_id: USER_ID,
      p_count: 1,
      p_max: 10,
      p_cost: 100,
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain('not found');
  });
});
