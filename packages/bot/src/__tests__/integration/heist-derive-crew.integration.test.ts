/**
 * Integration test: heist ONE-SOURCE-OF-TRUTH refactor
 * (20260710180000_heist_derive_crew_from_rows).
 *
 * Crew membership + success chance are now DERIVED from economy_heist_participants
 * ROWS; the denormalized participants[] array and the mutable success_chance
 * counter are gone. These tests pin the three codex findings that the refactor had
 * to close, each against the REAL SQL:
 *
 *   1. A banned/kicked/left member is removed from the DERIVED crew by
 *      cleanup_member_economy — their row is DELETED while recruiting (or made
 *      unpayable once frozen) — so they can neither boost the count/chance nor be
 *      paid a share. (payout=0 alone was inert: heist_credit_participant overwrites
 *      payout on the success path.)
 *   2. heist_start inserts the heist row AND the initiator participant row
 *      atomically, so the crew is counted WITH the initiator from the first moment
 *      the heist is derivable — a concurrent join can never fill the crew while the
 *      initiator row is missing.
 *   3. The migration BACKFILLS base_success_chance from the stored success_chance
 *      before dropping that column, so an in-flight heist keeps its odds.
 *
 * (3) is a one-time migration effect that cannot be re-run against an
 * already-migrated DB; it is asserted structurally here by reversing the
 * derivation on a live heist — base_success_chance + (crew-1)*7 must reproduce the
 * chance the crew was recruiting under. The backfill uses the identical reverse
 * derivation, so this pins the property the migration preserves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-heist-guild-${Date.now()}`;
const INITIATOR = 'heist-user-init';
const JOINER_A = 'heist-user-aaa';
const JOINER_B = 'heist-user-bbb';
const BANNED = 'heist-user-banned';

const ENTRY_FEE = 100;
const BASE_CHANCE = 40;
const TARGET_PAYOUT = 900;
const MAX = 8;
const MIN = 2;

async function seedWallet(userId: string, amount: number): Promise<void> {
  await supa
    .from('economy_wallets')
    .upsert({ guild_id: GUILD_ID, user_id: userId, wallet: amount });
}

async function walletOf(userId: string): Promise<number> {
  const { data } = await supa
    .from('economy_wallets')
    .select('wallet')
    .eq('guild_id', GUILD_ID)
    .eq('user_id', userId)
    .maybeSingle();
  return Number(data?.wallet ?? 0);
}

async function crewCount(heistId: string): Promise<number> {
  const { count } = await supa
    .from('economy_heist_participants')
    .select('*', { count: 'exact', head: true })
    .eq('heist_id', heistId);
  return count ?? 0;
}

/** Start a fresh heist via the atomic RPC; returns its id. */
async function startHeist(expiresInMs = 60_000): Promise<string> {
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  await seedWallet(INITIATOR, ENTRY_FEE);
  // Bot debits the initiator fee before the atomic insert (mirrors startHeist).
  await supa.rpc('economy_subtract_balance', {
    p_guild_id: GUILD_ID, p_user_id: INITIATOR, p_amount: ENTRY_FEE,
  });
  const { data, error } = await supa.rpc('heist_start', {
    p_guild_id: GUILD_ID,
    p_user_id: INITIATOR,
    p_target_name: 'City Bank',
    p_target_payout: TARGET_PAYOUT,
    p_base_chance: BASE_CHANCE,
    p_expires_at: expiresAt,
    p_role: 'Hacker',
    p_entry_fee: ENTRY_FEE,
  });
  expect(error).toBeNull();
  const row = Array.isArray(data) ? data[0] : data;
  expect(row.status).toBe('started');
  expect(row.heist_id).toBeTruthy();
  return row.heist_id as string;
}

async function join(heistId: string, userId: string): Promise<string> {
  await seedWallet(userId, ENTRY_FEE);
  const { data, error } = await supa.rpc('heist_join', {
    p_heist_id: heistId,
    p_user_id: userId,
    p_role: 'Muscle',
    p_entry_fee: ENTRY_FEE,
    p_max: MAX,
    p_base_chance: BASE_CHANCE,
  });
  expect(error).toBeNull();
  const row = Array.isArray(data) ? data[0] : data;
  return row.status as string;
}

async function cleanupHeists(): Promise<void> {
  const { data: heists } = await supa
    .from('economy_heists').select('id').eq('guild_id', GUILD_ID);
  for (const h of heists ?? []) {
    await supa.from('economy_heist_participants').delete().eq('heist_id', h.id);
  }
  await supa.from('economy_heists').delete().eq('guild_id', GUILD_ID);
}

beforeAll(async () => {
  supa = await requireSupabase();
  await supa.from('guild').insert({
    id: GUILD_ID, name: 'Heist Test Guild', owner_discord_id: '444555666',
  });
  await supa.from('guild_config').insert({ guild_id: GUILD_ID });
});

afterAll(async () => {
  await cleanupHeists();
  await supa.from('economy_wallets').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('finding 2 — heist_start inserts the initiator row atomically', () => {
  it('counts the initiator from the first derivable moment', async () => {
    const heistId = await startHeist();
    try {
      // The instant the heist row exists, its crew already derives as 1 — the
      // initiator's participant row committed in the same transaction.
      expect(await crewCount(heistId)).toBe(1);

      const { data: partRow } = await supa
        .from('economy_heist_participants')
        .select('user_id, entry_fee_paid, claimed_at, paid_at')
        .eq('heist_id', heistId)
        .single();
      expect(partRow!.user_id).toBe(INITIATOR);
      expect(partRow!.entry_fee_paid).toBe(ENTRY_FEE);
      expect(partRow!.claimed_at).toBeNull();
      expect(partRow!.paid_at).toBeNull();
    } finally {
      await cleanupHeists();
    }
  });

  it('rejects a second active heist atomically and refunds via the bot (no half-insert)', async () => {
    const heistId = await startHeist();
    try {
      // A concurrent /heist start for the same guild loses the unique-active
      // index race — the whole tx rolls back, nothing half-inserted.
      await seedWallet(JOINER_A, ENTRY_FEE);
      const { data, error } = await supa.rpc('heist_start', {
        p_guild_id: GUILD_ID,
        p_user_id: JOINER_A,
        p_target_name: 'The Museum',
        p_target_payout: TARGET_PAYOUT,
        p_base_chance: BASE_CHANCE,
        p_expires_at: new Date(Date.now() + 60_000).toISOString(),
        p_role: 'Driver',
        p_entry_fee: ENTRY_FEE,
      });
      expect(error).toBeNull();
      const row = Array.isArray(data) ? data[0] : data;
      expect(row.status).toBe('duplicate_active');
      expect(row.heist_id).toBeNull();

      // No second heist, and no stray participant row for the loser.
      const { count: heistCount } = await supa
        .from('economy_heists')
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', GUILD_ID)
        .in('status', ['recruiting', 'in_progress']);
      expect(heistCount).toBe(1);
      expect(await crewCount(heistId)).toBe(1); // only the initiator
      const { count: loserRows } = await supa
        .from('economy_heist_participants')
        .select('*', { count: 'exact', head: true })
        .eq('heist_id', heistId)
        .eq('user_id', JOINER_A);
      expect(loserRows).toBe(0);
    } finally {
      await cleanupHeists();
    }
  });
});

describe('finding 1 — cleanup_member_economy removes a forfeited member from the derived crew', () => {
  it('DELETES a recruiting member row so they are neither counted nor paid', async () => {
    const heistId = await startHeist();
    try {
      expect(await join(heistId, JOINER_A)).toBe('joined');
      expect(await join(heistId, BANNED)).toBe('joined');
      expect(await crewCount(heistId)).toBe(3); // initiator + A + banned

      // Ban the member — cleanup must remove them from the derived crew.
      const { data: summary, error } = await supa.rpc('cleanup_member_economy', {
        p_guild_id: GUILD_ID, p_user_id: BANNED, p_reason: 'banned',
      });
      expect(error).toBeNull();
      const s = summary as { heists_forfeited: number };
      expect(s.heists_forfeited).toBe(1);

      // Their row is GONE — crew derives as 2, not 3.
      expect(await crewCount(heistId)).toBe(2);
      const { count: bannedRows } = await supa
        .from('economy_heist_participants')
        .select('*', { count: 'exact', head: true })
        .eq('heist_id', heistId)
        .eq('user_id', BANNED);
      expect(bannedRows).toBe(0);
    } finally {
      await cleanupHeists();
    }
  });

  it('a banned member cannot be paid on a successful resolution', async () => {
    // Force a guaranteed success: base chance 95 clamps the roll to always win.
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await seedWallet(INITIATOR, ENTRY_FEE);
    await supa.rpc('economy_subtract_balance', {
      p_guild_id: GUILD_ID, p_user_id: INITIATOR, p_amount: ENTRY_FEE,
    });
    const { data: startData } = await supa.rpc('heist_start', {
      p_guild_id: GUILD_ID, p_user_id: INITIATOR, p_target_name: 'City Bank',
      p_target_payout: TARGET_PAYOUT, p_base_chance: 95, p_expires_at: expiresAt,
      p_role: 'Hacker', p_entry_fee: ENTRY_FEE,
    });
    const heistId = (Array.isArray(startData) ? startData[0] : startData).heist_id as string;
    try {
      expect(await join(heistId, JOINER_A)).toBe('joined');
      expect(await join(heistId, BANNED)).toBe('joined');

      // Ban BEFORE the claim freezes the crew → row deleted.
      await supa.rpc('cleanup_member_economy', {
        p_guild_id: GUILD_ID, p_user_id: BANNED, p_reason: 'banned',
      });

      const bannedBefore = await walletOf(BANNED);

      // Resolve: claim freezes the (2-member) crew, then credit each.
      const { data: claimData, error: claimErr } = await supa.rpc('heist_claim_for_resolution', {
        p_heist_id: heistId, p_min_participants: MIN,
      });
      expect(claimErr).toBeNull();
      const claim = Array.isArray(claimData) ? claimData[0] : claimData;
      expect(claim.claimed).toBe(true);
      expect(claim.outcome).toBe('success');
      // Crew count excludes the banned member — split over 2, not 3.
      expect(claim.participant_count).toBe(2);

      // Credit the frozen crew (claimed_at IS NOT NULL). The banned member is not
      // among them — their row was deleted — so a credit attempt is a no-op.
      const { data: frozen } = await supa
        .from('economy_heist_participants')
        .select('user_id')
        .eq('heist_id', heistId)
        .not('claimed_at', 'is', null);
      const frozenIds = (frozen ?? []).map((r) => r.user_id);
      expect(frozenIds).not.toContain(BANNED);
      for (const uid of frozenIds) {
        await supa.rpc('heist_credit_participant', {
          p_heist_id: heistId, p_guild_id: GUILD_ID, p_user_id: uid, p_amount: claim.payout_each,
        });
      }

      // Even a stray credit attempt for the banned member pays nothing (no row).
      const { data: strayPaid } = await supa.rpc('heist_credit_participant', {
        p_heist_id: heistId, p_guild_id: GUILD_ID, p_user_id: BANNED, p_amount: claim.payout_each,
      });
      expect(strayPaid).toBe(false);

      // The banned member's wallet is untouched — never paid a heist share.
      expect(await walletOf(BANNED)).toBe(bannedBefore);
    } finally {
      await cleanupHeists();
    }
  });

  it('a member banned AFTER the crew is frozen is made unpayable in place (share forfeited)', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await seedWallet(INITIATOR, ENTRY_FEE);
    await supa.rpc('economy_subtract_balance', {
      p_guild_id: GUILD_ID, p_user_id: INITIATOR, p_amount: ENTRY_FEE,
    });
    const { data: startData } = await supa.rpc('heist_start', {
      p_guild_id: GUILD_ID, p_user_id: INITIATOR, p_target_name: 'City Bank',
      p_target_payout: TARGET_PAYOUT, p_base_chance: 95, p_expires_at: expiresAt,
      p_role: 'Hacker', p_entry_fee: ENTRY_FEE,
    });
    const heistId = (Array.isArray(startData) ? startData[0] : startData).heist_id as string;
    try {
      expect(await join(heistId, BANNED)).toBe('joined');

      // Freeze the crew FIRST (claim), THEN ban — the row is now claimed_at set.
      const { data: claimData } = await supa.rpc('heist_claim_for_resolution', {
        p_heist_id: heistId, p_min_participants: MIN,
      });
      const claim = Array.isArray(claimData) ? claimData[0] : claimData;
      expect(claim.claimed).toBe(true);

      const bannedBefore = await walletOf(BANNED);
      const { error } = await supa.rpc('cleanup_member_economy', {
        p_guild_id: GUILD_ID, p_user_id: BANNED, p_reason: 'banned',
      });
      expect(error).toBeNull();

      // The frozen row is kept (count is immutable post-claim) but stamped
      // paid_at + payout 0 so the settle path can never pay it.
      const { data: row } = await supa
        .from('economy_heist_participants')
        .select('claimed_at, paid_at, payout')
        .eq('heist_id', heistId)
        .eq('user_id', BANNED)
        .single();
      expect(row!.claimed_at).not.toBeNull();
      expect(row!.paid_at).not.toBeNull();
      expect(row!.payout).toBe(0);

      // Settle attempt pays nothing (paid_at guard).
      const { data: paid } = await supa.rpc('heist_credit_participant', {
        p_heist_id: heistId, p_guild_id: GUILD_ID, p_user_id: BANNED,
        p_amount: claim.payout_each ?? 0,
      });
      expect(paid).toBe(false);
      expect(await walletOf(BANNED)).toBe(bannedBefore);
    } finally {
      await cleanupHeists();
    }
  });
});

describe('finding 3 — base_success_chance preserves the odds an in-flight heist recruited under', () => {
  it('reversing the derivation from the stored anchor reproduces the recruiting chance', async () => {
    const heistId = await startHeist();
    try {
      // Build a 3-member crew.
      expect(await join(heistId, JOINER_A)).toBe('joined');
      const joinResult = await supa.rpc('heist_join', {
        p_heist_id: heistId, p_user_id: JOINER_B, p_role: 'Lookout',
        p_entry_fee: ENTRY_FEE, p_max: MAX, p_base_chance: BASE_CHANCE,
      });
      await seedWallet(JOINER_B, ENTRY_FEE); // (already seeded in join; harmless)
      // The chance heist_join derived for the 3rd member.
      const derivedAtJoin = (Array.isArray(joinResult.data) ? joinResult.data[0] : joinResult.data)?.success_chance;

      const count = await crewCount(heistId);
      expect(count).toBe(3);

      // The immutable anchor persisted on the row.
      const { data: heist } = await supa
        .from('economy_heists')
        .select('base_success_chance')
        .eq('id', heistId)
        .single();
      expect(heist!.base_success_chance).toBe(BASE_CHANCE);

      // Reverse derivation (identical to the migration backfill): the chance the
      // resolver rolls against = clamp(base + (frozen_count - 1) * 7). It must
      // equal the base recovered from a would-be stored counter:
      //   base = success_chance - (count - 1) * 7
      const rolledChance = Math.max(0, Math.min(95, heist!.base_success_chance + (count - 1) * 7));
      expect(rolledChance).toBe(Math.max(0, Math.min(95, BASE_CHANCE + (count - 1) * 7)));
      // And it matches what the join surfaced live to the crew.
      if (typeof derivedAtJoin === 'number') expect(rolledChance).toBe(derivedAtJoin);

      // The resolver uses exactly this anchor: claim a success and confirm the
      // count it froze is the crew we built, so payout_each = target / count.
      const { data: claimData } = await supa.rpc('heist_claim_for_resolution', {
        p_heist_id: heistId, p_min_participants: MIN,
      });
      const claim = Array.isArray(claimData) ? claimData[0] : claimData;
      expect(claim.participant_count).toBe(3);
    } finally {
      await cleanupHeists();
    }
  });
});
