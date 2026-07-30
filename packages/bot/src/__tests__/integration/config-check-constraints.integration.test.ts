/**
 * Integration test: config CHECK constraints against the REAL schema.
 *
 * Covers migration 20260727010000_config_check_constraints_sweep (which
 * completes the narrower 20260727004000). Every constraint added there is
 * asserted twice: a nonsense value must be REJECTED with Postgres 23514, and a
 * legitimate value must still be ACCEPTED.
 *
 * The "accepts" half is not padding. A CHECK violation surfaces to a server
 * owner as a bare 500 ("An internal error occurred" — dashboard
 * lib/api/response.ts dbError), so a constraint that is one notch too tight is
 * worse than no constraint at all: it turns a legitimate save into an
 * unexplained failure. Each accept case is therefore the loosest value the
 * dashboard's own Zod schema permits for that column.
 *
 * Three cases deliberately assert that a value IS accepted even though the bot
 * mishandles it — the sentinels (0 = "no cap") and the columns whose write
 * route validates .min(0) while the consumer needs >= 1. Those are reported as
 * application bugs, not fixed by tightening the database underneath a UI that
 * still offers the value.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-cfgcheck-guild-${Date.now()}`;
const MEMBER_ID = 'cfgcheck-member-1';

const CHECK_VIOLATION = '23514';

beforeAll(async () => {
  supa = await requireSupabase();
  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Config Constraint Test Guild',
    owner_discord_id: '111222333',
  });
  const { error } = await supa.from('guild_config').insert({ guild_id: GUILD_ID });
  expect(error).toBeNull();
});

afterAll(async () => {
  await supa.from('member_rank_settings').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_role_income').delete().eq('guild_id', GUILD_ID);
  await supa.from('ticket_panels').delete().eq('guild_id', GUILD_ID);
  await supa.from('temp_channel_hubs').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

/** Apply a partial guild_config patch and return the PostgREST error (if any). */
async function patchConfig(patch: Record<string, unknown>) {
  const { error } = await supa.from('guild_config').update(patch).eq('guild_id', GUILD_ID);
  return error;
}

// ── guild_config ────────────────────────────────────────────────────────────
// [column, bad value (must be rejected), good value (must be accepted)]
const REJECTED_AND_ACCEPTED: Array<[string, unknown, unknown]> = [
  // Levels / XP — negative XP is a silent drain that de-levels members with no
  // announcement and no role revocation.
  ['xp_min', -1, 0],
  ['xp_max', -1, 10_000],
  ['xp_cooldown_seconds', -1, 0], // 0 accepted: /api/levels validates .min(0)
  ['voice_xp_per_interval', -1, 0],
  // numToHex() renders out-of-range ints as invalid CSS; canvas silently
  // ignores the assignment and the progress bar renders permanently empty.
  ['rank_card_accent_color', -1, 16_777_215],
  ['rank_card_accent_color', 16_777_216, 0],

  // Message templates — over 2000 chars Discord returns 50035 and every call
  // site swallows it.
  ['welcome_message', 'x'.repeat(2001), 'x'.repeat(2000)],
  ['welcome_dm_message', 'x'.repeat(2001), 'Welcome, {user}!'],
  ['goodbye_message', 'x'.repeat(2001), 'Bye {user}'],
  ['level_up_message', 'x'.repeat(2001), '{user} reached level {level}'],

  // Moderation / anti-raid.
  ['infraction_expiry_days', 0, 1], // 0 => every infraction born expired
  ['anti_raid_join_threshold', 1, 2], // 1 => kicks the very first joiner
  ['anti_raid_join_window_seconds', 0, 5], // 0 => flood detection dead
  ['anti_raid_account_age_days', -1, 0],

  // Community surfaces handed to Discord.
  ['starboard_threshold', 0, 1],
  ['starboard_emoji', 'x'.repeat(65), '⭐'],
  ['giveaway_entry_button_label', '', 'Count me in!'],
  ['giveaway_entry_button_label', 'x'.repeat(81), 'x'.repeat(80)],
  ['store_brand_name', 'x'.repeat(65), 'x'.repeat(64)],

  // Node timer delays. Both ends of each range are the same runaway: any delay
  // above 2^31 ms is silently reset to 1 ms.
  ['sync_interval_minutes', 0, 5],
  ['sync_interval_minutes', 1441, 1440],
  ['music_auto_leave_minutes', 0, 1],
  ['music_auto_destroy_minutes', 0, 120],

  // Real-money store: subscription grace.
  ['grace_period_days', -1, 0],
  ['grace_period_days', 91, 90],

  // Game economy — currency identity is interpolated into embed titles.
  ['currency_name', '', 'Coins'],
  ['currency_name', 'x'.repeat(33), 'x'.repeat(32)],
  ['currency_emoji', '', '🪙'],
  ['currency_emoji', 'x'.repeat(65), 'x'.repeat(64)],

  // Game economy — payouts. A negative amount makes creditWallet return null,
  // which routes /daily into the false "outage" lane.
  ['economy_starting_balance', -1, 0],
  ['economy_daily_amount', -1, 0],
  ['economy_weekly_amount', -1, 0],
  ['economy_monthly_amount', -1, 0],
  ['economy_work_min', -1, 0],
  ['economy_chat_income_min', -1, 0],

  // Game economy — percentages fed to chance(): out of range never throws, it
  // just makes crime/rob always fail or always succeed.
  ['economy_streak_bonus_pct', -1, 100],
  ['economy_crime_success_pct', 0, 1],
  ['economy_crime_success_pct', 101, 100],
  ['economy_rob_success_pct', 0, 1],
  ['economy_crime_fine_pct', 101, 100],
  ['economy_rob_fine_pct', -1, 0],
  ['economy_pay_tax_pct', 101, 100], // economy_pay RPC RAISEs outside [0,100]

  // Game economy — Valkey SET ... PX/EX rejects a non-positive expiry, and the
  // throw is log-only, so the command dies guild-wide with no visible cause.
  ['economy_work_cooldown_seconds', 0, 1],
  ['economy_chat_income_cooldown_seconds', 0, 1],
  ['economy_gathering_cooldown_seconds', 0, 1],
  ['economy_fishing_cooldown_seconds', 0, 1],

  // Game economy — a negative ticket price runs `wallet = wallet - p_cost`
  // upward: a coin-minting exploit the wallet >= 0 CHECK cannot catch.
  ['economy_lottery_ticket_price', 0, 1],
  ['economy_lottery_max_tickets', 0, 1],

  // Heist.
  ['economy_heist_min_participants', 0, 1],
  ['economy_heist_join_window_secs', 9, 10], // setTimeout delay
  ['economy_heist_join_window_secs', 601, 600],
  ['economy_heist_base_payout', -1, 0],
  ['economy_heist_entry_fee', -1, 0],
  ['economy_heist_success_base_pct', 0, 1],

  // Farming: grid size is both a loop bound and the plot-slot validator;
  // fertilizer >= 100 makes grow time zero or negative.
  ['economy_farm_grid_size', 0, 1],
  ['economy_farm_grid_size', 26, 25],
  ['economy_fertilizer_time_reduction_pct', 100, 99],

  // Fishing chances (individual bounds; the cross-column sum has its own test).
  ['economy_fishing_junk_chance_pct', -1, 0],
  ['economy_fishing_treasure_chance_pct', 101, 100],
  ['economy_fishing_collection_reward_coins', 0, 1],

  // Adventures / market / quests / prestige / pets.
  ['economy_adventure_daily_limit', 0, 1],
  ['economy_adventure_max_scenes', 2, 3],
  ['economy_market_fee_pct', 101, 100],
  ['economy_market_listing_days', 0, 1],
  ['economy_market_max_listings', 0, 1],
  ['economy_daily_quest_count', -1, 0], // 0 is the documented "disabled" value
  ['economy_quest_reward_base', -1, 0],
  ['economy_prestige_multiplier_pct', 0, 1],
  ['economy_prestige_min_level', 0, 1],
  ['economy_prestige_max_level', 0, 1],
  ['economy_pet_decay_rate', 101, 100],
  ['economy_pet_low_stat_threshold', -1, 0],
  ['economy_pet_decay_interval_hours', 0, 1], // setInterval delay: 0 => 1ms spin
  ['economy_pet_decay_interval_hours', 169, 168], // >596h overflows to the same spin
];

describe('guild_config CHECK constraints', () => {
  it.each(REJECTED_AND_ACCEPTED)(
    '%s rejects %p and accepts %p',
    async (column, badValue, goodValue) => {
      const rejected = await patchConfig({ [column]: badValue });
      expect(rejected?.code).toBe(CHECK_VIOLATION);

      const accepted = await patchConfig({ [column]: goodValue });
      expect(accepted).toBeNull();
    },
  );
});

describe('guild_config cross-column invariants', () => {
  // fishing-manager.ts:451-453 partitions ONE roll over [0,100):
  //   roll < junk -> junk | roll < junk+treasure -> treasure | else -> a fish
  // Above 100 the fish branch is unreachable, so no species is ever caught and
  // the collection reward can never fire. Zod validates the two independently
  // and never checks the sum, so this pair passes dashboard validation today.
  it('rejects fishing junk + treasure chances that sum above 100', async () => {
    await patchConfig({
      economy_fishing_junk_chance_pct: 0,
      economy_fishing_treasure_chance_pct: 0,
    });

    const rejected = await patchConfig({
      economy_fishing_junk_chance_pct: 60,
      economy_fishing_treasure_chance_pct: 50,
    });
    expect(rejected?.code).toBe(CHECK_VIOLATION);

    const accepted = await patchConfig({
      economy_fishing_junk_chance_pct: 60,
      economy_fishing_treasure_chance_pct: 40,
    });
    expect(accepted).toBeNull();
  });
});

describe('guild_config sentinel values stay writable', () => {
  // These 0s are load-bearing, not oversights. economy_max_wallet is documented
  // `0 = no cap` at 20260522700000_v44_audit_fixes.sql:60, and games-manager.ts
  // :397 reads `if (limit <= 0) return true // no limit`. A `> 0` floor would
  // silently impose a cap on every guild running on the shipped defaults.
  it.each([
    ['economy_max_wallet', 0],
    ['economy_daily_loss_limit', 0],
    ['economy_coinflip_max_bet', 0],
    ['economy_slots_max_bet', 0],
    ['economy_blackjack_max_bet', 0],
    ['economy_weekly_quest_count', 0],
    ['economy_crafting_cooldown_seconds', 0],
    ['economy_pet_feed_cost', 0],
    ['economy_pet_train_cost', 0],
    ['economy_heist_cooldown_seconds', 0],
  ])('%s still accepts %p', async (column, value) => {
    expect(await patchConfig({ [column]: value })).toBeNull();
  });

  it.each([
    ['economy_max_wallet', -1],
    ['economy_daily_loss_limit', -1],
    ['economy_coinflip_max_bet', -1],
    ['economy_pet_feed_cost', -1],
    ['economy_crafting_cooldown_seconds', -1],
    ['economy_heist_cooldown_seconds', -1],
  ])('%s still rejects the negative %p', async (column, value) => {
    expect((await patchConfig({ [column]: value }))?.code).toBe(CHECK_VIOLATION);
  });
});

// ── Sibling per-guild config tables ─────────────────────────────────────────

describe('member_rank_settings CHECK constraints', () => {
  // Same numToHex path as rank_card_accent_color, and reachable: /rank
  // customize parses the option with parseInt(hex, 16) and never range-checks.
  it.each([
    ['accent_color', -1, 16_777_215],
    ['accent_color', 16_777_216, 0],
    ['progress_bar_color', -1, 0],
    ['overlay_opacity', 1.5, 1],
    ['overlay_opacity', -0.1, 0],
  ])('%s rejects %p and accepts %p', async (column, badValue, goodValue) => {
    const rejected = await supa
      .from('member_rank_settings')
      .upsert({ guild_id: GUILD_ID, member_id: MEMBER_ID, [column]: badValue },
        { onConflict: 'guild_id,member_id' });
    expect(rejected.error?.code).toBe(CHECK_VIOLATION);

    const accepted = await supa
      .from('member_rank_settings')
      .upsert({ guild_id: GUILD_ID, member_id: MEMBER_ID, [column]: goodValue },
        { onConflict: 'guild_id,member_id' });
    expect(accepted.error).toBeNull();
  });
});

describe('economy_role_income CHECK constraints', () => {
  // economy_collect_role_income filters `interval_minutes > 0`, so a rule at 0
  // is silently skipped forever: the dashboard lists it, the member is never
  // paid, and nothing errors on any surface.
  it('rejects a non-positive interval and accepts a positive one', async () => {
    const rejected = await supa.from('economy_role_income').insert({
      guild_id: GUILD_ID, role_id: 'role-a', amount: 100, interval_minutes: 0,
    });
    expect(rejected.error?.code).toBe(CHECK_VIOLATION);

    const accepted = await supa.from('economy_role_income').insert({
      guild_id: GUILD_ID, role_id: 'role-a', amount: 100, interval_minutes: 1,
    });
    expect(accepted.error).toBeNull();
  });
});

describe('ticket_panels CHECK constraints', () => {
  const basePanel = {
    guild_id: GUILD_ID,
    name: 'Support',
    channel_id: 'chan-tickets',
    panel_message: {},
    input_mode: 'buttons',
    open_category_id: 'cat-open',
  };

  it('rejects max_open_per_user below 1 and accepts 1', async () => {
    const rejected = await supa
      .from('ticket_panels')
      .insert({ ...basePanel, max_open_per_user: 0 });
    expect(rejected.error?.code).toBe(CHECK_VIOLATION);

    const accepted = await supa
      .from('ticket_panels')
      .insert({ ...basePanel, max_open_per_user: 1 });
    expect(accepted.error).toBeNull();
  });

  it('keeps 0 inactivity hours writable (the UI\'s "disabled" value)', async () => {
    const { error } = await supa.from('ticket_panels').insert({
      ...basePanel,
      channel_id: 'chan-tickets-2',
      inactivity_warn_hours: 0,
      inactivity_close_hours: 0,
    });
    expect(error).toBeNull();
  });
});

describe('temp_channel_hubs CHECK constraints', () => {
  // keep_alive_minutes is the legacy fallback for the empty-room grace period
  // (`empty_grace_seconds ?? keep_alive_minutes * 60`); a negative deletes the
  // room the instant it empties.
  it('rejects a negative keep_alive and accepts the UI range', async () => {
    const rejected = await supa.from('temp_channel_hubs').insert({
      guild_id: GUILD_ID, hub_channel_id: 'hub-1', category_id: 'cat-1',
      keep_alive_minutes: -1,
    });
    expect(rejected.error?.code).toBe(CHECK_VIOLATION);

    const accepted = await supa.from('temp_channel_hubs').insert({
      guild_id: GUILD_ID, hub_channel_id: 'hub-1', category_id: 'cat-1',
      keep_alive_minutes: 1440,
    });
    expect(accepted.error).toBeNull();
  });
});
