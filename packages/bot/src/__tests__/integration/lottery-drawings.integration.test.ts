/**
 * Integration test: Lottery drawings — stable-winner claim + idempotent payout.
 *
 * lottery_claim_drawing(p_drawing_id UUID) atomically claims an active
 * drawing AND stores the winning ticket on the row, so retries and
 * concurrent workers can never re-roll the winner.
 * lottery_award_jackpot(p_drawing_id UUID) credits the STORED winner and
 * finalises the drawing (status='drawn', winner_paid_at) in one
 * transaction, so a payout that landed can never be repeated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-lottery-guild-${Date.now()}`;
const USER_A = 'lottery-user-aaa';
const USER_B = 'lottery-user-bbb';

// Set by the claim tests, consumed by the payout tests below.
let drawingId: string;
let storedWinner: string;
let storedNumber: number;

async function createDrawing(jackpot: number): Promise<string> {
  const { data, error } = await supa
    .from('economy_lottery_drawings')
    .insert({ guild_id: GUILD_ID, status: 'active', jackpot })
    .select()
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function insertTickets(drawingId: string, userId: string, numbers: number[]): Promise<void> {
  const { error } = await supa.from('economy_lottery_tickets').insert(
    numbers.map((n) => ({ drawing_id: drawingId, guild_id: GUILD_ID, user_id: userId, ticket_number: n })),
  );
  expect(error).toBeNull();
}

async function walletOf(userId: string): Promise<number> {
  const { data } = await supa
    .from('economy_wallets')
    .select('wallet')
    .eq('guild_id', GUILD_ID)
    .eq('user_id', userId)
    .maybeSingle();
  return data?.wallet ?? 0;
}

beforeAll(async () => {
  supa = await requireSupabase();

  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Lottery Test Guild',
    owner_discord_id: '444555666',
  });
  await supa.from('guild_config').insert({ guild_id: GUILD_ID });

  drawingId = await createDrawing(500);
  await insertTickets(drawingId, USER_A, [11, 12, 13]);
  await insertTickets(drawingId, USER_B, [21, 22]);
});

afterAll(async () => {
  await supa.from('economy_lottery_tickets').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_lottery_drawings').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_wallets').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('lottery_claim_drawing RPC', () => {
  it('claims an active drawing and stores the winning ticket on the row', async () => {
    const { data, error } = await supa.rpc('lottery_claim_drawing', {
      p_drawing_id: drawingId,
    });

    expect(error).toBeNull();
    const claimed = Array.isArray(data) ? data : [data];
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(drawingId);
    expect(claimed[0].jackpot).toBe(500);
    expect([USER_A, USER_B]).toContain(claimed[0].winner_user_id);
    storedWinner = claimed[0].winner_user_id;
    storedNumber = claimed[0].winning_number;

    // The winning ticket must be one the winner actually holds.
    const expectedNumbers = storedWinner === USER_A ? [11, 12, 13] : [21, 22];
    expect(expectedNumbers).toContain(storedNumber);

    // Winner is persisted on the row, payout still pending.
    const { data: row } = await supa
      .from('economy_lottery_drawings')
      .select('status, winner_user_id, winning_number, winner_paid_at')
      .eq('id', drawingId)
      .single();
    expect(row!.status).toBe('drawing');
    expect(row!.winner_user_id).toBe(storedWinner);
    expect(row!.winning_number).toBe(storedNumber);
    expect(row!.winner_paid_at).toBeNull();
  });

  it('does not re-claim or re-roll the winner on a retry', async () => {
    const { data, error } = await supa.rpc('lottery_claim_drawing', {
      p_drawing_id: drawingId,
    });

    expect(error).toBeNull();
    const rows = Array.isArray(data) ? data : [];
    expect(rows.length).toBe(0);

    // Stored winner is untouched — retries are deterministic.
    const { data: row } = await supa
      .from('economy_lottery_drawings')
      .select('winner_user_id, winning_number')
      .eq('id', drawingId)
      .single();
    expect(row!.winner_user_id).toBe(storedWinner);
    expect(row!.winning_number).toBe(storedNumber);
  });

  it('claims exactly once under concurrent workers', async () => {
    const raceDrawing = await createDrawing(300);
    await insertTickets(raceDrawing, USER_A, [31, 32]);
    await insertTickets(raceDrawing, USER_B, [41]);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        supa.rpc('lottery_claim_drawing', { p_drawing_id: raceDrawing }),
      ),
    );

    for (const { error } of results) expect(error).toBeNull();
    const winners = results.flatMap(({ data }) => (Array.isArray(data) ? data : []));
    expect(winners.length).toBe(1);
    expect([USER_A, USER_B]).toContain(winners[0].winner_user_id);
  });

  it('leaves a ticketless drawing active', async () => {
    const emptyDrawing = await createDrawing(0);

    const { data, error } = await supa.rpc('lottery_claim_drawing', {
      p_drawing_id: emptyDrawing,
    });

    expect(error).toBeNull();
    expect((Array.isArray(data) ? data : []).length).toBe(0);

    const { data: row } = await supa
      .from('economy_lottery_drawings')
      .select('status, winner_user_id')
      .eq('id', emptyDrawing)
      .single();
    expect(row!.status).toBe('active');
    expect(row!.winner_user_id).toBeNull();
  });
});

describe('lottery_award_jackpot RPC', () => {
  it('pays exactly the stored winner and finalises the drawing', async () => {
    const before = await walletOf(storedWinner);

    const { data, error } = await supa.rpc('lottery_award_jackpot', {
      p_drawing_id: drawingId,
    });

    expect(error).toBeNull();
    const awarded = Array.isArray(data) ? data : [data];
    expect(awarded.length).toBe(1);
    expect(awarded[0].winner_user_id).toBe(storedWinner);
    expect(awarded[0].winning_number).toBe(storedNumber);
    expect(awarded[0].jackpot).toBe(500);

    expect(await walletOf(storedWinner)).toBe(before + 500);

    const { data: row } = await supa
      .from('economy_lottery_drawings')
      .select('status, winner_paid_at, drawn_at')
      .eq('id', drawingId)
      .single();
    expect(row!.status).toBe('drawn');
    expect(row!.winner_paid_at).not.toBeNull();
    expect(row!.drawn_at).not.toBeNull();
  });

  it('does not repeat a payout that already succeeded', async () => {
    const before = await walletOf(storedWinner);

    const { data, error } = await supa.rpc('lottery_award_jackpot', {
      p_drawing_id: drawingId,
    });

    expect(error).toBeNull();
    expect((Array.isArray(data) ? data : []).length).toBe(0);
    expect(await walletOf(storedWinner)).toBe(before);
  });

  it('pays nothing for an unclaimed drawing', async () => {
    const unclaimed = await createDrawing(900);
    await insertTickets(unclaimed, USER_A, [51]);

    const { data, error } = await supa.rpc('lottery_award_jackpot', {
      p_drawing_id: unclaimed,
    });

    expect(error).toBeNull();
    expect((Array.isArray(data) ? data : []).length).toBe(0);

    const { data: row } = await supa
      .from('economy_lottery_drawings')
      .select('status')
      .eq('id', unclaimed)
      .single();
    expect(row!.status).toBe('active');
  });

  it('pays exactly once under concurrent workers', async () => {
    const raceDrawing = await createDrawing(250);
    await insertTickets(raceDrawing, USER_B, [61, 62]);

    const { data: claimed } = await supa.rpc('lottery_claim_drawing', {
      p_drawing_id: raceDrawing,
    });
    expect((Array.isArray(claimed) ? claimed : []).length).toBe(1);

    const before = await walletOf(USER_B);
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        supa.rpc('lottery_award_jackpot', { p_drawing_id: raceDrawing }),
      ),
    );

    for (const { error } of results) expect(error).toBeNull();
    const payouts = results.flatMap(({ data }) => (Array.isArray(data) ? data : []));
    expect(payouts.length).toBe(1);
    expect(await walletOf(USER_B)).toBe(before + 250);
  });
});

/**
 * 20260709190000_lottery_buy_reject_closed_drawing: lottery_buy_tickets
 * re-checks status AFTER acquiring the drawing row lock, so a purchase that
 * was blocked on the lock while lottery_claim_drawing claimed the drawing
 * aborts instead of appending tickets that can never win. (The function is
 * re-created from the 20260709160000 definition, so the schema-qualified
 * extensions.gen_random_bytes fix is exercised here too.)
 */
describe('lottery_buy_tickets status guard', () => {
  it('sells tickets for an ACTIVE drawing (qualified pgcrypto randomness intact)', async () => {
    const active = await createDrawing(0);

    const { data: newJackpot, error } = await supa.rpc('lottery_buy_tickets', {
      p_drawing_id: active,
      p_guild_id: GUILD_ID,
      p_user_id: USER_A,
      p_count: 2,
      p_max: 10,
      p_cost: 200,
    });

    expect(error).toBeNull();
    expect(newJackpot).toBe(200);

    const { data: tickets } = await supa
      .from('economy_lottery_tickets')
      .select('ticket_number')
      .eq('drawing_id', active)
      .eq('user_id', USER_A);
    expect(tickets!.length).toBe(2);
    for (const t of tickets!) {
      expect(t.ticket_number).toBeGreaterThanOrEqual(0);
      expect(t.ticket_number).toBeLessThanOrEqual(9999);
    }
  });

  it('rejects a purchase once the drawing is claimed, leaving no partial state', async () => {
    const claimedDrawing = await createDrawing(100);
    await insertTickets(claimedDrawing, USER_A, [71]);

    // Scheduler claims the drawing — winner is now selected and stored.
    const { data: claimed } = await supa.rpc('lottery_claim_drawing', {
      p_drawing_id: claimedDrawing,
    });
    expect((Array.isArray(claimed) ? claimed : []).length).toBe(1);

    // A buy that resumes after the claim must be rejected with the typed
    // 'is not active' error the bot maps to a refund + "drawing just closed".
    const { error } = await supa.rpc('lottery_buy_tickets', {
      p_drawing_id: claimedDrawing,
      p_guild_id: GUILD_ID,
      p_user_id: USER_B,
      p_count: 2,
      p_max: 10,
      p_cost: 200,
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain('is not active');

    // Transaction rolled back: no tickets appended, jackpot untouched, and
    // the stored winner is unaffected.
    const { data: lateTickets } = await supa
      .from('economy_lottery_tickets')
      .select('id')
      .eq('drawing_id', claimedDrawing)
      .eq('user_id', USER_B);
    expect(lateTickets!.length).toBe(0);

    const { data: row } = await supa
      .from('economy_lottery_drawings')
      .select('status, jackpot, winner_user_id')
      .eq('id', claimedDrawing)
      .single();
    expect(row!.status).toBe('drawing');
    expect(row!.jackpot).toBe(100);
    expect(row!.winner_user_id).toBe(USER_A);
  });

  it('rejects a purchase for a cancelled drawing', async () => {
    const cancelled = await createDrawing(0);
    await supa
      .from('economy_lottery_drawings')
      .update({ status: 'cancelled', drawn_at: new Date().toISOString() })
      .eq('id', cancelled);

    const { error } = await supa.rpc('lottery_buy_tickets', {
      p_drawing_id: cancelled,
      p_guild_id: GUILD_ID,
      p_user_id: USER_B,
      p_count: 1,
      p_max: 10,
      p_cost: 100,
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain('is not active');
  });
});
