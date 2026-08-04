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
import { parseBody } from '@/lib/api/validation';
import { dbError } from '@/lib/api/response';
import { readGuildConfigBefore, recordGuildConfigChange } from '@/lib/admin-changes';
import { discordEmojiSchema, discordSnowflakeSchema } from '@/lib/api/discord-values';

const guildConfigPatchSchema = z.object({
  mod_log_channel_id: discordSnowflakeSchema.nullable().optional(),
  welcome_channel_id: discordSnowflakeSchema.nullable().optional(),
  goodbye_channel_id: discordSnowflakeSchema.nullable().optional(),
  level_up_channel_id: discordSnowflakeSchema.nullable().optional(),
  music_enabled: z.boolean().optional(),
  music_default_volume: z.number().int().min(0).max(150).optional(),
  dj_role_id: discordSnowflakeSchema.nullable().optional(),
  stats_enabled: z.boolean().optional(),
  temp_channels_enabled: z.boolean().optional(),
  scheduled_messages_enabled: z.boolean().optional(),
  max_schedules_per_guild: z.number().int().min(1).max(200).optional(),
  default_timezone: z.string().min(1).max(64).optional(),
  missed_run_policy: z.enum(['skip-missed', 'send-latest']).optional(),
  allow_embeds: z.boolean().optional(),
  variables_enabled: z.boolean().optional(),
  giveaways_enabled: z.boolean().optional(),
  // Diagnostics alert thresholds. Ranges MUST mirror the guild_config CHECK
  // constraints (migration 20260727000000) or a valid-looking payload dies as
  // a raw 23514 instead of a readable validation error.
  // Team invitation controls (migration 20260723193000). Ranges mirror the DB
  // CHECKs so an out-of-range value is a readable 400, not a raw 23514.
  team_direct_assignment_enabled: z.boolean().optional(),
  team_invite_dm_enabled: z.boolean().optional(),
  team_max_pending_invitations: z.number().int().min(1).max(100).optional(),
  team_invitation_expiry_ms: z.number().int().min(3_600_000).max(2_592_000_000).optional(),
  // Fraud notification routing (migration 20260723120100). The bot mirrors
  // critical fraud signals to this channel and optionally DMs the owner.
  fraud_staff_alert_channel_id: discordSnowflakeSchema.nullable().optional(),
  fraud_owner_dm_on_critical: z.boolean().optional(),
  diagnostics_guided_mode: z.boolean().optional(),
  memory_alert_threshold_mb: z.number().int().min(64).max(16384).optional(),
  ws_ping_alert_threshold_ms: z.number().int().min(50).max(10000).optional(),
  webhook_error_rate_threshold: z.number().min(0).max(1).optional(),
  audit_export_row_limit: z.number().int().min(1).max(100_000).optional(),
  audit_flush_interval_ms: z.number().int().min(1_000).max(60_000).optional(),
  automation_dm_cooldown_seconds: z.number().int().min(0).max(86_400).optional(),
  automation_max_chain_depth: z.number().int().min(1).max(10).optional(),
  automation_preview_required: z.boolean().optional(),
  automation_user_fire_limit_per_minute: z.number().int().min(1).max(100).optional(),
  custom_commands_max_per_guild: z.number().int().min(1).max(10_000).optional(),
  diagnostics_snapshot_interval_ms: z.number().int().min(10_000).max(3_600_000).optional(),
  incidents_auto_create_from_critical_alerts: z.boolean().optional(),
  incidents_default_severity: z.enum(['info', 'warning', 'critical', 'outage']).optional(),
  incidents_list_page_size: z.number().int().min(1).max(100).optional(),
  rbac_custom_role_priority_default: z.number().int().min(0).max(999).optional(),
  rbac_max_permissions_per_role: z.number().int().min(1).max(500).optional(),
  // V17: New fields
  no_xp_role_id: discordSnowflakeSchema.nullable().optional(),
  anti_raid_enabled: z.boolean().optional(),
  anti_raid_join_threshold: z.number().int().min(2).max(100).optional(),
  anti_raid_join_window_seconds: z.number().int().min(5).max(120).optional(),
  anti_raid_account_age_days: z.number().int().min(0).max(365).optional(),
  anti_raid_action: z.enum(['kick', 'ban', 'lockdown']).optional(),
  anti_raid_auto_unban: z.boolean().optional(),
  anti_raid_containment_ladder: z.array(z.object({
    stage: z.number().int().min(1).max(10),
    action: z.enum(['kick', 'ban', 'lockdown']),
    ban_delete_seconds: z.number().int().min(0).max(604800).optional(),
  })).max(10).optional(),
  anti_raid_raid_cooldown_minutes: z.number().int().min(1).max(60).optional(),
  anti_raid_log_channel_id: discordSnowflakeSchema.nullable().optional(),
  starboard_enabled: z.boolean().optional(),
  starboard_channel_id: discordSnowflakeSchema.nullable().optional(),
  starboard_threshold: z.number().int().min(1).max(100).optional(),
  starboard_emoji: discordEmojiSchema.optional(),
  starboard_self_star: z.boolean().optional(),
  message_log_enabled: z.boolean().optional(),
  message_log_channel_id: discordSnowflakeSchema.nullable().optional(),
  message_log_edits_enabled: z.boolean().optional(),
  message_log_deletes_enabled: z.boolean().optional(),
  message_log_ignored_channel_ids: z.array(discordSnowflakeSchema).max(100).optional(),
  message_log_config_cache_ttl_ms: z.number().int().min(0).max(3_600_000).optional(),
  data_export_enabled: z.boolean().optional(),
  automod_enabled: z.boolean().optional(),
  automod_mode: z.enum(['observe', 'enforce']).optional(),
  automod_message_budget_ms: z.number().int().min(100).max(2_000).optional(),
  automod_regex_budget_ms: z.number().int().min(50).max(250).optional(),
  appeals_enabled: z.boolean().optional(),
  appeal_cooldown_hours: z.number().int().min(1).max(168).optional(),
  appeal_review_channel_id: discordSnowflakeSchema.nullable().optional(),
  dm_on_action: z.boolean().optional(),
  max_queue_length: z.number().int().min(1).max(5_000).optional(),
  allow_duplicates: z.boolean().optional(),
  per_user_queue_cap: z.number().int().min(1).max(500).optional(),
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
  grace_period_days: z.number().int().min(1).max(30).optional(),
  // Commerce core PayPal policy. Environment is intentionally explicit and
  // defaults to sandbox in the database; selecting live never supplies
  // credentials or performs a live-money call by itself.
  paypal_legacy_usd_sale_tolerance: z.boolean().optional(),
  paypal_environment: z.enum(['sandbox', 'live']).optional(),
  paypal_refund_strategy: z.enum(['provider-first', 'local-first']).optional(),
  paypal_webhook_stale_processing_ms: z.number().int().min(60000).max(86400000).optional(),
  paypal_webhook_verify_attempts: z.number().int().min(1).max(10).optional(),
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
  economy_heist_min_participants: z.number().int().min(1).max(20).optional(),
  economy_heist_max_participants: z.number().int().min(2).max(50).optional(),
  economy_heist_join_window_secs: z.number().int().min(10).max(600).optional(),
  economy_heist_cooldown_seconds: z.number().int().min(0).max(86400).optional(),
  economy_heist_base_payout: z.number().int().min(0).max(100_000_000).optional(),
  economy_heist_success_base_pct: z.number().int().min(1).max(99).optional(),
  economy_heist_entry_fee: z.number().int().min(0).max(100_000_000).optional(),
  economy_passive_mode_allowed: z.boolean().optional(),
  economy_pay_tax_pct: z.number().int().min(0).max(50).optional(),
  economy_max_wallet: z.number().int().min(0).optional(),
  economy_max_bank: z.number().int().min(0).optional(),
  economy_log_channel_id: discordSnowflakeSchema.nullable().optional(),

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
  economy_fishing_collection_reward_enabled: z.boolean().optional(),
  economy_fishing_collection_reward_coins: z.number().int().min(1).max(2_147_483_647).optional(),
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
  economy_market_max_price_per_unit: z.number().int().min(1).max(2_147_483_647).optional(),
  // PR #45 — Trivia
  economy_trivia_enabled: z.boolean().optional(),
  economy_trivia_cooldown_seconds: z.number().int().min(5).max(3600).optional(),
  economy_trivia_base_payout: z.number().int().min(0).max(1000000).optional(),
  economy_trivia_streak_multiplier_pct: z.number().int().min(0).max(100).optional(),
  economy_trivia_hard_multiplier: z.number().min(1).max(10).optional(),
  // Scheduled / hosted trivia cadence
  economy_trivia_schedule_enabled: z.boolean().optional(),
  economy_trivia_schedule_interval_minutes: z.number().int().min(5).max(10080).optional(),
  economy_trivia_schedule_channel_id: discordSnowflakeSchema.nullable().optional(),
  economy_trivia_schedule_category: z.string().max(64).nullable().optional(),
  economy_trivia_schedule_difficulty: z.enum(['easy', 'medium', 'hard']).nullable().optional(),
  // PR #45 — Mini-Games
  economy_games_enabled: z.boolean().optional(),
  economy_daily_loss_limit: z.number().int().min(0).max(100000000).optional(),
  economy_coinflip_max_bet: z.number().int().min(0).max(100000000).optional(),
  economy_slots_max_bet: z.number().int().min(0).max(100000000).optional(),
  economy_blackjack_max_bet: z.number().int().min(0).max(100000000).optional(),
  // PR #45 — Lottery
  economy_lottery_enabled: z.boolean().optional(),
  economy_lottery_schedule: z.enum(['6h', '12h', 'daily', 'weekly', 'biweekly', 'monthly']).optional(),
  economy_lottery_ticket_price: z.number().int().min(1).max(1000000).optional(),
  economy_lottery_max_tickets: z.number().int().min(1).max(100).optional(),
  // PR #45 — Polls & Predictions
  polls_enabled: z.boolean().optional(),
  predictions_enabled: z.boolean().optional(),
  max_poll_options: z.number().int().min(2).max(10).optional(),
  allow_multiple_default: z.boolean().optional(),
  prediction_min_bet: z.number().int().min(1).max(1_000_000).optional(),
  prediction_max_bet: z.number().int().min(0).max(100_000_000).optional(),
  reaction_roles_enabled: z.boolean().optional(),
  default_style: z.enum(['reaction', 'buttons', 'select-menu']).optional(),
  default_max_per_group: z.number().int().min(0).max(25).optional(),
  default_require_level: z.number().int().min(0).max(1000).optional(),
  default_remove_on_unreact: z.boolean().optional(),
  level_curve: z.object({ base: z.number().finite().positive().max(1_000_000), exponent: z.number().finite().min(0.1).max(5) }).optional(),

  // PR #46 — Pets, Quests, Achievements, Prestige
  economy_pets_enabled: z.boolean().optional(),
  economy_pet_decay_rate: z.number().int().min(0).max(100).optional(),
  economy_pet_battle_enabled: z.boolean().optional(),
  economy_pet_prestige_enabled: z.boolean().optional(),
  economy_pet_feed_cost: z.number().int().min(0).optional(),
  economy_pet_train_cost: z.number().int().min(0).optional(),
  economy_pet_decay_interval_hours: z.number().int().min(1).max(168).optional(),
  economy_pet_low_stat_threshold: z.number().int().min(0).max(100).optional(),
  economy_pet_notify_owner: z.boolean().optional(),
  economy_quests_enabled: z.boolean().optional(),
  economy_daily_quest_count: z.number().int().min(1).max(10).optional(),
  economy_weekly_quest_count: z.number().int().min(1).max(5).optional(),
  economy_quest_reward_base: z.number().int().min(0).optional(),
  economy_achievements_enabled: z.boolean().optional(),
  economy_prestige_enabled: z.boolean().optional(),
  economy_prestige_multiplier_pct: z.number().int().min(1).max(100).optional(),
  economy_prestige_min_level: z.number().int().min(1).optional(),
  economy_prestige_min_net_worth: z.number().int().min(0).optional(),
  economy_prestige_max_level: z.number().int().min(1).max(2_147_483_647).optional(),
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

  // Validate with Zod via centralized parseBody
  const parsed = await parseBody(request, guildConfigPatchSchema);
  if (!parsed.ok) return parsed.response;

  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  const admin = createAdminSupabase();
  const before = await readGuildConfigBefore(admin, guildId, Object.keys(updates));

  const { error } = await admin
    .from('guild_config')
    .upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' });

  if (error) return dbError(error, 'guild');

  // Notify the bot so it hot-reloads the changed config immediately.
  // Fields in this schema span multiple feature areas — use 'all' to cover them.
  await notifyBot(guildId, 'all', updates);

  await recordGuildConfigChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'guild.config_updated',
    area: 'server settings',
    updates,
    before,
  }, admin);

  return NextResponse.json({ success: true });
}
