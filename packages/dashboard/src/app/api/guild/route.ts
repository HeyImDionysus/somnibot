/**
 * GET /api/guild — Fetch guild info, bot status, and config.
 * PATCH /api/guild — Update guild config.
 *
 * SECURITY (Phase A):
 * - Uses requireGuildOwner() — no fallback to "any guild".
 * - PATCH validates fields against a Zod schema + allowlist.
 * - Rate-limited (V17 Behavioral Audit — Item 8).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';

const guildConfigPatchSchema = z.object({
  mod_log_channel_id: z.string().nullable().optional(),
  welcome_channel_id: z.string().nullable().optional(),
  goodbye_channel_id: z.string().nullable().optional(),
  level_up_channel_id: z.string().nullable().optional(),
  music_enabled: z.boolean().optional(),
  music_default_volume: z.number().int().min(0).max(150).optional(),
  dj_role_id: z.string().nullable().optional(),
  stats_enabled: z.boolean().optional(),
  temp_channels_enabled: z.boolean().optional(),
  scheduled_messages_enabled: z.boolean().optional(),
  giveaways_enabled: z.boolean().optional(),
  // V17: New fields
  no_xp_role_id: z.string().nullable().optional(),
  anti_raid_enabled: z.boolean().optional(),
  anti_raid_join_threshold: z.number().int().min(2).max(100).optional(),
  anti_raid_join_window_seconds: z.number().int().min(5).max(120).optional(),
  anti_raid_account_age_days: z.number().int().min(0).max(365).optional(),
  anti_raid_action: z.enum(['kick', 'ban', 'lockdown']).optional(),
  anti_raid_log_channel_id: z.string().nullable().optional(),
  starboard_enabled: z.boolean().optional(),
  starboard_channel_id: z.string().nullable().optional(),
  starboard_threshold: z.number().int().min(1).max(100).optional(),
  starboard_emoji: z.string().max(64).optional(),
  starboard_self_star: z.boolean().optional(),
  message_log_enabled: z.boolean().optional(),
  message_log_channel_id: z.string().nullable().optional(),
  // V26: Commerce toggles
  store_enabled: z.boolean().optional(),
  paypal_enabled: z.boolean().optional(),
  // V26: Bot presence
  custom_bot_statuses: z.array(z.string().max(128)).max(20).optional(),
  // V26: Onboarding
  onboarding_config: z.record(z.unknown()).nullable().optional(),
  // V26: Stats update interval
  stats_update_interval_minutes: z.number().int().min(1).max(60).optional(),
  // V26: Ticket defaults
  ticket_transcript_enabled: z.boolean().optional(),
  ticket_dm_transcript: z.boolean().optional(),
  // V28: Commerce grace period (was in schema + bot but never exposed in dashboard)
  grace_period_days: z.number().int().min(0).max(90).optional(),
  // V31: Economy Core
  economy_enabled: z.boolean().optional(),
  currency_name: z.string().min(1).max(32).optional(),
  currency_emoji: z.string().min(1).max(64).optional(),
  economy_starting_balance: z.number().int().min(0).max(1_000_000).optional(),
  economy_daily_amount: z.number().int().min(0).max(1_000_000).optional(),
  economy_weekly_amount: z.number().int().min(0).max(10_000_000).optional(),
  economy_monthly_amount: z.number().int().min(0).max(100_000_000).optional(),
  economy_streak_bonus_pct: z.number().int().min(0).max(100).optional(),
  economy_work_cooldown_seconds: z.number().int().min(60).max(86400).optional(),
  economy_work_min: z.number().int().min(0).max(1_000_000).optional(),
  economy_work_max: z.number().int().min(0).max(10_000_000).optional(),
  economy_crime_success_pct: z.number().int().min(1).max(100).optional(),
  economy_crime_fine_pct: z.number().int().min(0).max(100).optional(),
  economy_crime_min: z.number().int().min(0).max(1_000_000).optional(),
  economy_crime_max: z.number().int().min(0).max(10_000_000).optional(),
  economy_chat_income_enabled: z.boolean().optional(),
  economy_chat_income_min: z.number().int().min(0).max(10_000).optional(),
  economy_chat_income_max: z.number().int().min(0).max(100_000).optional(),
  economy_chat_income_cooldown_seconds: z.number().int().min(1).max(3600).optional(),
  economy_rob_enabled: z.boolean().optional(),
  economy_rob_success_pct: z.number().int().min(1).max(100).optional(),
  economy_rob_fine_pct: z.number().int().min(0).max(100).optional(),
  economy_heist_enabled: z.boolean().optional(),
  economy_passive_mode_allowed: z.boolean().optional(),
  economy_pay_tax_pct: z.number().int().min(0).max(50).optional(),
  economy_max_wallet: z.number().int().min(0).optional(),
  economy_max_bank: z.number().int().min(0).optional(),
  economy_log_channel_id: z.string().nullable().optional(),

  // V31 PR #43 — Gathering, Crafting, Farming
  economy_gathering_enabled: z.boolean().optional(),
  economy_gathering_cooldown_seconds: z.number().int().min(10).max(86400).optional(),
  economy_crafting_enabled: z.boolean().optional(),
  economy_crafting_cooldown_seconds: z.number().int().min(0).max(86400).optional(),
  economy_farming_enabled: z.boolean().optional(),
  economy_farm_grid_size: z.number().int().min(1).max(25).optional(),
  economy_farming_wilt_enabled: z.boolean().optional(),
  economy_fertilizer_time_reduction_pct: z.number().int().min(0).max(90).optional(),
  // Fishing
  economy_fishing_enabled: z.boolean().optional(),
  economy_fishing_cooldown_seconds: z.number().int().min(5).max(3600).optional(),
  economy_fishing_junk_chance_pct: z.number().int().min(0).max(100).optional(),
  economy_fishing_treasure_chance_pct: z.number().int().min(0).max(100).optional(),
  // Adventures
  economy_adventures_enabled: z.boolean().optional(),
  economy_adventure_daily_limit: z.number().int().min(1).max(50).optional(),
  economy_adventure_ticket_cost: z.number().int().min(0).max(1000000).optional(),
  economy_adventure_max_scenes: z.number().int().min(3).max(30).optional(),
  // Market
  economy_market_enabled: z.boolean().optional(),
  economy_market_fee_pct: z.number().int().min(0).max(50).optional(),
  economy_market_listing_days: z.number().int().min(1).max(30).optional(),
  economy_market_max_listings: z.number().int().min(1).max(50).optional(),
  // PR #45 — Trivia
  economy_trivia_enabled: z.boolean().optional(),
  economy_trivia_cooldown_seconds: z.number().int().min(5).max(3600).optional(),
  economy_trivia_base_payout: z.number().int().min(0).max(1000000).optional(),
  economy_trivia_streak_multiplier_pct: z.number().int().min(0).max(100).optional(),
  economy_trivia_hard_multiplier: z.number().min(1).max(10).optional(),
  // PR #45 — Mini-Games
  economy_games_enabled: z.boolean().optional(),
  economy_daily_loss_limit: z.number().int().min(0).max(100000000).optional(),
  economy_coinflip_max_bet: z.number().int().min(0).max(100000000).optional(),
  economy_slots_max_bet: z.number().int().min(0).max(100000000).optional(),
  economy_blackjack_max_bet: z.number().int().min(0).max(100000000).optional(),
  // PR #45 — Lottery
  economy_lottery_enabled: z.boolean().optional(),
  economy_lottery_schedule: z.enum(['daily', 'weekly', 'biweekly', 'monthly']).optional(),
  economy_lottery_ticket_price: z.number().int().min(1).max(1000000).optional(),
  economy_lottery_max_tickets: z.number().int().min(1).max(100).optional(),
  // PR #45 — Polls & Predictions
  polls_enabled: z.boolean().optional(),
  predictions_enabled: z.boolean().optional(),

  // PR #46 — Pets, Quests, Achievements, Prestige
  economy_pets_enabled: z.boolean().optional(),
  economy_pet_decay_rate: z.number().int().min(0).max(100).optional(),
  economy_pet_battle_enabled: z.boolean().optional(),
  economy_pet_prestige_enabled: z.boolean().optional(),
  economy_pet_feed_cost: z.number().int().min(0).optional(),
  economy_pet_train_cost: z.number().int().min(0).optional(),
  economy_quests_enabled: z.boolean().optional(),
  economy_daily_quest_count: z.number().int().min(1).max(10).optional(),
  economy_weekly_quest_count: z.number().int().min(1).max(5).optional(),
  economy_quest_reward_base: z.number().int().min(0).optional(),
  economy_achievements_enabled: z.boolean().optional(),
  economy_prestige_enabled: z.boolean().optional(),
  economy_prestige_multiplier_pct: z.number().int().min(1).max(100).optional(),
  economy_prestige_min_level: z.number().int().min(1).optional(),
  economy_prestige_min_net_worth: z.number().int().min(0).optional(),
}).strict();

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const admin = createAdminSupabase();

  const { data: guild } = await admin
    .from('guild')
    .select('*, guild_config(*)')
    .eq('id', guildId)
    .single();

  if (!guild) {
    return NextResponse.json({ error: 'Guild not found' }, { status: 404 });
  }

  // Get desired state
  const { data: desiredState } = await admin
    .from('guild_desired_state')
    .select('*')
    .eq('guild_id', guildId)
    .single();

  return NextResponse.json({
    success: true,
    guild,
    config: guild.guild_config?.[0] ?? null,
    desiredState,
    totalRoles: guild.total_roles ?? null,
  });
}

export async function PATCH(request: NextRequest) {
  // Rate limit: write preset (30 req/min)
  const limited = await checkAdminRateLimit(request, 'write');
  if (limited) return limited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  // Validate with Zod
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = guildConfigPatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  const admin = createAdminSupabase();
  const { error } = await admin
    .from('guild_config')
    .upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Notify the bot so it hot-reloads the changed config immediately.
  // Fields in this schema span multiple feature areas — use 'all' to cover them.
  await notifyBot('all', updates);

  return NextResponse.json({ success: true });
}
