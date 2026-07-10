/**
 * Defense-in-depth allowlist for the admin-changes undo route.
 *
 * The undo route replays a stored `undo_payload` ({ table, data, match }) as a
 * Supabase `.from(table).update(data).match(match)`. Those field values are
 * read back from a database row, so a corrupted or tampered row could try to
 * steer the write at a sensitive table (e.g. `users`, `guild_secrets`) or at
 * columns the undo system never legitimately writes.
 *
 * This map is the single source of truth for what undo may touch. Each entry
 * splits its columns into two sets:
 *   - `data`  = the only columns undo may SET (the `.update(data)` payload).
 *               These are the mutable, dashboard-writable columns of the table.
 *               Identity / tenant columns (`id`, `guild_id`) and immutable
 *               `created_at` are deliberately excluded — undo replays a value
 *               change, it must never re-key a row or move it between tenants.
 *   - `match` = the only columns undo may MATCH on (the `.match(match)` filter).
 *               These are the identity / tenant columns used to locate the row.
 *
 * Splitting the two sets means a tampered payload cannot smuggle an identifier
 * or tenant key into `data` (which would let the service-role write re-point a
 * row) even though that same column is legitimately allowed in `match`.
 *
 * Column sets are derived from the real table schemas
 * (packages/shared/src/types/database.ts + packages/supabase/migrations) and
 * kept a complete superset of what the dashboard write routes actually set, so
 * legitimate undo payloads replay instead of being rejected. This is a
 * fail-closed security control: a column that is not listed here is rejected
 * even if it exists in the schema. The undo route must never trust the
 * table/column names carried in the stored payload.
 *
 * Backed by a `Map` (not a plain object) so a tampered `undo_payload.table` of
 * an inherited key such as `"__proto__"` or `"constructor"` resolves to
 * `undefined` and is rejected, instead of returning a prototype value that
 * would bypass the allowlist and crash the `.has()` check downstream.
 */
export interface UndoTableSpec {
  /** Columns undo may set via `.update(data)`. */
  readonly data: ReadonlySet<string>;
  /** Columns undo may filter on via `.match(match)`. */
  readonly match: ReadonlySet<string>;
}

/**
 * Common identity / tenant match keys. Most tables are located by their surrogate
 * primary key plus the guild (tenant) column; both are needed to safely target a
 * single row without crossing tenants.
 */
const ID_AND_GUILD: ReadonlySet<string> = new Set(["id", "guild_id"]);

export const UNDO_TABLE_COLUMNS: ReadonlyMap<string, UndoTableSpec> = new Map<
  string,
  UndoTableSpec
>([
  [
    "guild_config",
    {
      // guild_config is keyed by guild_id (no surrogate id); everything else is
      // dashboard-settable config.
      data: new Set([
        "alert_channel_id",
        "anti_raid_account_age_days",
        "anti_raid_action",
        "anti_raid_ban_delete_seconds",
        "anti_raid_enabled",
        "anti_raid_join_threshold",
        "anti_raid_join_window_seconds",
        "anti_raid_log_channel_id",
        "currency_emoji",
        "currency_name",
        "custom_bot_statuses",
        "data_retention_days",
        "dj_role_id",
        "economy_achievements_enabled",
        "economy_adventure_daily_limit",
        "economy_adventure_max_scenes",
        "economy_adventure_ticket_cost",
        "economy_adventures_enabled",
        "economy_blackjack_max_bet",
        "economy_chat_income_cooldown_seconds",
        "economy_chat_income_enabled",
        "economy_chat_income_max",
        "economy_chat_income_min",
        "economy_coinflip_max_bet",
        "economy_crafting_cooldown_seconds",
        "economy_crafting_enabled",
        "economy_crime_fine_pct",
        "economy_crime_max",
        "economy_crime_min",
        "economy_crime_success_pct",
        "economy_daily_amount",
        "economy_daily_loss_limit",
        "economy_daily_quest_count",
        "economy_enabled",
        "economy_farm_grid_size",
        "economy_farming_enabled",
        "economy_farming_wilt_enabled",
        "economy_fertilizer_time_reduction_pct",
        "economy_fishing_cooldown_seconds",
        "economy_fishing_enabled",
        "economy_fishing_junk_chance_pct",
        "economy_fishing_treasure_chance_pct",
        "economy_games_enabled",
        "economy_gathering_cooldown_seconds",
        "economy_gathering_enabled",
        "economy_heist_base_payout",
        "economy_heist_cooldown_seconds",
        "economy_heist_enabled",
        "economy_heist_entry_fee",
        "economy_heist_join_window_secs",
        "economy_heist_max_participants",
        "economy_heist_min_participants",
        "economy_heist_success_base_pct",
        "economy_log_channel_id",
        "economy_lottery_enabled",
        "economy_lottery_max_tickets",
        "economy_lottery_schedule",
        "economy_lottery_ticket_price",
        "economy_market_enabled",
        "economy_market_fee_pct",
        "economy_market_listing_days",
        "economy_market_max_listings",
        "economy_max_bank",
        "economy_max_wallet",
        "economy_monthly_amount",
        "economy_passive_mode_allowed",
        "economy_pay_tax_pct",
        "economy_pet_battle_enabled",
        "economy_pet_decay_interval_hours",
        "economy_pet_decay_rate",
        "economy_pet_feed_cost",
        "economy_pet_low_stat_threshold",
        "economy_pet_notify_owner",
        "economy_pet_prestige_enabled",
        "economy_pet_train_cost",
        "economy_pets_enabled",
        "economy_prestige_enabled",
        "economy_prestige_min_level",
        "economy_prestige_min_net_worth",
        "economy_prestige_multiplier_pct",
        "economy_quest_reward_base",
        "economy_quests_enabled",
        "economy_rob_enabled",
        "economy_rob_fine_pct",
        "economy_rob_success_pct",
        "economy_slots_max_bet",
        "economy_starting_balance",
        "economy_streak_bonus_pct",
        "economy_trivia_base_payout",
        "economy_trivia_cooldown_seconds",
        "economy_trivia_enabled",
        "economy_trivia_hard_multiplier",
        "economy_trivia_streak_multiplier_pct",
        "economy_weekly_amount",
        "economy_weekly_quest_count",
        "economy_work_cooldown_seconds",
        "economy_work_max",
        "economy_work_min",
        "escalation_chain",
        "giveaways_enabled",
        "goodbye_channel_id",
        "goodbye_enabled",
        "goodbye_message",
        "grace_period_days",
        "infraction_expiry_days",
        "interest_role_mapping",
        "level_up_channel_id",
        "level_up_message",
        "levels_enabled",
        "member_role_id",
        "message_log_channel_id",
        "message_log_enabled",
        "mod_log_channel_id",
        "music_auto_destroy_minutes",
        "music_auto_leave_minutes",
        "music_default_volume",
        "music_enabled",
        "no_xp_role_id",
        "onboarding_config",
        "onboarding_enabled",
        "paypal_enabled",
        "polls_enabled",
        "predictions_enabled",
        "rank_card_accent_color",
        "rank_card_background",
        "returning_member_restore_entitlements",
        "returning_member_restore_levels",
        "returning_member_skip_welcome_dm",
        "scheduled_messages_enabled",
        "starboard_channel_id",
        "starboard_emoji",
        "starboard_enabled",
        "starboard_self_star",
        "starboard_threshold",
        "stats_enabled",
        "stats_update_interval_minutes",
        "store_enabled",
        "sync_auto_repair",
        "sync_auto_repair_everyone",
        "sync_enabled",
        "sync_interval_minutes",
        "temp_channels_enabled",
        "ticket_dm_transcript",
        "ticket_transcript_enabled",
        "updated_at",
        "voice_xp_enabled",
        "voice_xp_interval_minutes",
        "voice_xp_per_interval",
        "welcome_auto_roles",
        "welcome_card_background",
        "welcome_card_enabled",
        "welcome_channel_id",
        "welcome_dm_enabled",
        "welcome_dm_message",
        "welcome_enabled",
        "welcome_message",
        "xp_channel_list",
        "xp_channel_mode",
        "xp_cooldown_seconds",
        "xp_max",
        "xp_min",
        "xp_multiplier_mode",
      ]),
      match: new Set(["guild_id"]),
    },
  ],
  [
    "products",
    {
      data: new Set([
        "active",
        "currency",
        "delivery_type",
        "description",
        "granted_channel_ids",
        "granted_role_ids",
        "metadata",
        "name",
        "paypal_product_id",
        "price_cents",
        "sort_order",
        "type",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "product_files",
    {
      data: new Set([
        "description",
        "display_name",
        "download_count",
        "external_url",
        "file_name",
        "file_path",
        "file_size_bytes",
        "mime_type",
        "name",
        "size_bytes",
        "sort_order",
        "storage_bucket",
        "storage_path",
        "version",
      ]),
      // product_files is located by its id, its parent product, and its tenant.
      match: new Set(["id", "product_id", "guild_id"]),
    },
  ],
  [
    "product_license_config",
    {
      // Keyed by product_id (its primary key), not a surrogate id.
      data: new Set([
        "device_policy",
        "feature_flags",
        "heartbeat_interval_seconds",
        "license_mode",
        "max_devices",
        "offline_grace_period_seconds",
        "require_discord_guild_membership",
        "tier",
        "updated_at",
        "watermark_config",
      ]),
      match: new Set(["product_id"]),
    },
  ],
  [
    "level_rewards",
    {
      data: new Set(["announce", "level", "remove_at_level", "role_id"]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "xp_multipliers",
    {
      data: new Set(["multiplier", "role_id"]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "reaction_roles",
    {
      data: new Set([
        "active",
        "channel_id",
        "emoji",
        "exclusive_group",
        "log_actions",
        "max_per_group",
        "message_id",
        "remove_on_unreact",
        "require_level",
        "require_role",
        "role_id",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "automod_rules",
    {
      data: new Set([
        "action",
        "config",
        "enabled",
        "exempt_channels",
        "exempt_roles",
        "log_to_mod_channel",
        "mute_duration_minutes",
        "name",
        "priority",
        "sync_to_discord",
        "type",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "custom_commands",
    {
      data: new Set([
        "actions",
        "allowed_channels",
        "allowed_roles",
        "cooldown_seconds",
        "denied_channels",
        "denied_roles",
        "description",
        "discord_command_id",
        "enabled",
        "ephemeral",
        "name",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "ticket_panels",
    {
      data: new Set([
        "active",
        "channel_id",
        "closed_category_id",
        "dm_transcript_to_creator",
        "forum_config",
        "input_mode",
        "intake_form_enabled",
        "intake_form_fields",
        "introduction_message",
        "manager_roles",
        "max_open_per_user",
        "message_id",
        "name",
        "open_category_id",
        "panel_message",
        "ticket_types",
        "transcript_channel_id",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "embed_configs",
    {
      data: new Set([
        "author_icon_url",
        "author_name",
        "author_url",
        "color",
        "components_v2_data",
        "description",
        "fields",
        "footer_icon_url",
        "footer_text",
        "image_url",
        "include_timestamp",
        "name",
        "thumbnail_url",
        "title",
        "updated_at",
        "use_components_v2",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "scheduled_messages",
    {
      data: new Set([
        "active",
        "channel_id",
        "cron_expression",
        "current_sends",
        "embed_config_id",
        "end_date",
        "last_sent_at",
        "max_sends",
        "message",
        "name",
        "start_date",
        "timezone",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "automations",
    {
      data: new Set([
        "actions",
        "conditions",
        "description",
        "enabled",
        "exclude_channel_ids",
        "exclude_user_ids",
        "execution_count",
        "last_executed_at",
        "name",
        "rate_limit_per_user",
        "rate_limit_window_seconds",
        "target_channel_ids",
        "target_user_ids",
        "trigger_config",
        "trigger_type",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "economy_items",
    {
      data: new Set([
        "active",
        "category",
        "description",
        "durability",
        "emoji",
        "grant_role_id",
        "max_per_user",
        "name",
        "price",
        "require_role_id",
        "sell_price",
        "sort_order",
        "stock",
        "tradeable",
        "updated_at",
        "usable",
        "use_effect",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "stats_channels",
    {
      data: new Set([
        "active",
        "channel_id",
        "last_updated_at",
        "last_value",
        "name_format",
        "stat_config",
        "stat_type",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "temp_channel_hubs",
    {
      data: new Set([
        "active",
        "allow_text_channel",
        "category_id",
        "default_bitrate",
        "default_user_limit",
        "hub_channel_id",
        "keep_alive_minutes",
        "moderator_roles",
        "naming_format",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "channel_templates",
    {
      data: new Set([
        "base_template_id",
        "description",
        "is_builtin",
        "name",
        "overrides",
        "target_channel_type",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "giveaways",
    {
      data: new Set([
        "channel_id",
        "created_by",
        "ended_at",
        "ends_at",
        "entries",
        "message_id",
        "prize",
        "prize_license_count",
        "prize_product_id",
        "required_entitlement_product_id",
        "required_level",
        "required_role_id",
        "status",
        "winner_count",
        "winners",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "polls",
    {
      data: new Set([
        "allow_multiple",
        "channel_id",
        "closed_at",
        "creator_user_id",
        "description",
        "ends_at",
        "message_id",
        "status",
        "title",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "predictions",
    {
      data: new Set([
        "channel_id",
        "creator_user_id",
        "locked_at",
        "message_id",
        "resolved_at",
        "status",
        "title",
        "total_pool",
        "winning_option_id",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "tutorial_configs",
    {
      // Keyed by guild_id (its primary key), not a surrogate id.
      data: new Set(["auto_trigger", "enabled", "trigger_mode", "updated_at"]),
      match: new Set(["guild_id"]),
    },
  ],
  [
    "tutorial_steps",
    {
      data: new Set([
        "built_in_key",
        "description",
        "enabled",
        "image_url",
        "step_order",
        "title",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "role_templates",
    {
      data: new Set([
        "base_template_id",
        "description",
        "is_builtin",
        "name",
        "permission_details",
        "permissions",
        "tier",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "alerts",
    {
      data: new Set([
        "acknowledged",
        "acknowledged_at",
        "acknowledged_by",
        "alert_type",
        "auto_resolved",
        "details",
        "message",
        "metadata",
        "resolved",
        "resolved_at",
        "severity",
        "title",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
    },
  ],
  [
    "fraud_rules",
    {
      data: new Set([
        "action",
        "auto_action",
        "config",
        "description",
        "enabled",
        "last_triggered",
        "name",
        "rule_type",
        "trigger_count",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
    },
  ],
]);

/**
 * Tables the undo route may target — derived from UNDO_TABLE_COLUMNS so the two
 * allowlists can never drift apart.
 */
export const UNDOABLE_TABLES: ReadonlySet<string> = new Set(UNDO_TABLE_COLUMNS.keys());

/**
 * True only for a real, own-enumerable object (rejects null, arrays, and other
 * non-plain values that a tampered payload might smuggle in).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export type UndoValidation =
  | { ok: true; table: string; data: Record<string, unknown>; match: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Re-validate a resolved undo payload against the allowlist at APPLY time.
 *
 * Rejects (without any DB write) when:
 *   - table/data/match are not the expected shapes,
 *   - the table is not on the allowlist,
 *   - `match` is empty (an empty match would update every row in the table),
 *   - any column in `data` is not in the table's settable allowlist, or
 *   - any column in `match` is not in the table's match allowlist.
 *
 * `data` and `match` are validated against SEPARATE allowlists: identity/tenant
 * columns are match-only, so a tampered payload cannot set them.
 */
export function validateUndoPayload(payload: unknown): UndoValidation {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: "undo payload is not an object" };
  }

  const { table, data, match } = payload as Record<string, unknown>;

  if (typeof table !== "string") {
    return { ok: false, reason: "undo payload table is not a string" };
  }
  // Map.get performs an own-key lookup, so a tampered table of "__proto__" /
  // "constructor" resolves to undefined and is rejected here (never a prototype
  // value that would bypass the allowlist).
  const spec = UNDO_TABLE_COLUMNS.get(table);
  if (!spec) {
    return { ok: false, reason: `table "${table}" is not in the undo allowlist` };
  }

  if (!isPlainObject(data)) {
    return { ok: false, reason: "undo payload data is not an object" };
  }
  if (!isPlainObject(match)) {
    return { ok: false, reason: "undo payload match is not an object" };
  }
  if (Object.keys(match).length === 0) {
    return { ok: false, reason: "undo payload match is empty" };
  }

  for (const column of Object.keys(data)) {
    if (!spec.data.has(column)) {
      return {
        ok: false,
        reason: `column "${column}" is not settable by undo for table "${table}"`,
      };
    }
  }
  for (const column of Object.keys(match)) {
    if (!spec.match.has(column)) {
      return {
        ok: false,
        reason: `column "${column}" is not a valid match key for undo on table "${table}"`,
      };
    }
  }

  return { ok: true, table, data, match };
}
