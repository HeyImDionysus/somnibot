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
 *               Columns the dashboard never writes (bot-owned counters like
 *               `scheduled_messages.current_sends` / `last_sent_at`) are also
 *               excluded so a tampered undo can't rewind scheduler state.
 *   - `match` = the only columns undo may MATCH on (the `.match(match)` filter).
 *               These are the identity / tenant columns used to locate the row.
 *
 * Splitting the two sets means a tampered payload cannot smuggle an identifier
 * or tenant key into `data` (which would let the service-role write re-point a
 * row) even though that same column is legitimately allowed in `match`.
 *
 * The column allowlist alone is NOT enough to make the match safe, so each
 * entry also carries a tenancy contract enforced at apply time:
 *   - `requiredMatch` = identity key(s) that MUST be present in `match`. Without
 *     this a payload could match on the tenant key ALONE (e.g.
 *     `match: { guild_id }`) and the service-role `.update().match()` would
 *     rewrite EVERY row of that guild instead of the single undo target.
 *   - `guildScope` = how the write is confined to the caller's guild:
 *       · `{ kind: "column", column }` — the guild column must be present in
 *         `match` and its value must equal the caller's `ctx.guildId`. This
 *         blocks a tampered payload from naming another guild's id/tenant.
 *       · `{ kind: "lookup", ... }` — the table has NO guild column of its own
 *         (e.g. `product_license_config`, keyed by `product_id`). The route
 *         must resolve the row's owning guild through a parent table and verify
 *         it against `ctx.guildId` BEFORE applying. `validateUndoPayload`
 *         returns a `tenancyCheck` directive describing that lookup.
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
/**
 * How undo confines a write to the caller's guild.
 *
 * - `column`: the table has its own guild column. `match` must include it and
 *   its value must equal the caller's `ctx.guildId` (checked synchronously in
 *   `validateUndoPayload`).
 * - `lookup`: the table has NO guild column, so the owning guild is derived by
 *   joining a `localKey` value to a `foreignTable`'s `foreignKey` and reading
 *   its `foreignGuildColumn`. The undo route resolves and verifies this against
 *   `ctx.guildId` before applying the write.
 */
export type UndoGuildScope =
  | { readonly kind: "column"; readonly column: string }
  | {
      readonly kind: "lookup";
      /** Match key on THIS table whose value identifies the parent row. */
      readonly localKey: string;
      /** Parent table that carries the guild column. */
      readonly foreignTable: string;
      /** Parent-table column matched against the local key's value. */
      readonly foreignKey: string;
      /** Guild column on the parent table to compare against ctx.guildId. */
      readonly foreignGuildColumn: string;
    };

export interface UndoTableSpec {
  /** Columns undo may set via `.update(data)`. */
  readonly data: ReadonlySet<string>;
  /** Columns undo may filter on via `.match(match)`. */
  readonly match: ReadonlySet<string>;
  /**
   * Identity key(s) that MUST be present in `match`. Guards against a payload
   * that matches on the tenant key alone (which would update every row in the
   * guild). Every required key must also be a member of `match`.
   */
  readonly requiredMatch: ReadonlySet<string>;
  /** How the write is confined to the caller's guild (see UndoGuildScope). */
  readonly guildScope: UndoGuildScope;
}

/**
 * Common identity / tenant match keys. Most tables are located by their surrogate
 * primary key plus the guild (tenant) column; both are needed to safely target a
 * single row without crossing tenants.
 */
const ID_AND_GUILD: ReadonlySet<string> = new Set(["id", "guild_id"]);

/**
 * Tenancy contract for the common `{ id, guild_id }` shape: the surrogate `id`
 * must be present (so the write hits one row) and the write is scoped to the
 * caller's guild via the `guild_id` match value.
 */
const ID_AND_GUILD_SCOPE = {
  requiredMatch: new Set(["id"]) as ReadonlySet<string>,
  guildScope: { kind: "column", column: "guild_id" } as UndoGuildScope,
};

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
      // guild_id IS the primary key here, so it is both the required identity
      // key and the guild scope column.
      match: new Set(["guild_id"]),
      requiredMatch: new Set(["guild_id"]),
      guildScope: { kind: "column", column: "guild_id" },
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
      ...ID_AND_GUILD_SCOPE,
    },
  ],
  [
    "product_files",
    {
      // File LOCATORS (external_url, file_path, storage_path, storage_bucket)
      // and the immutable upload metadata that travels with them (file_name,
      // mime_type, file_size_bytes, size_bytes, version) are deliberately
      // EXCLUDED. They are assigned once by the upload/create routes
      // (store/files + store/products/[id]/files POST) and never edited by any
      // dashboard UPDATE path — the dashboard only ever inserts or deletes a
      // file row. The download endpoint later TRUSTS file_path / external_url to
      // issue signed URLs or redirect paid downloads
      // (downloads/[productId]/[fileId] route), so letting a tampered undo
      // rewrite them on an existing row could repoint a paid download to an
      // attacker-controlled object or URL, bypassing upload validation.
      // download_count is a system counter owned by the download RPC.
      // Only display metadata a dashboard admin could legitimately re-edit
      // remains settable.
      data: new Set([
        "description",
        "display_name",
        "name",
        "sort_order",
      ]),
      // product_files is located by its id, its parent product, and its tenant.
      match: new Set(["id", "product_id", "guild_id"]),
      requiredMatch: new Set(["id"]),
      guildScope: { kind: "column", column: "guild_id" },
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
      // product_license_config is keyed by product_id and has NO guild column,
      // so its owning guild must be resolved through products.guild_id and
      // verified against ctx.guildId before the undo is applied. Without this,
      // a tampered undo row in guild A could rewrite guild B's license config
      // by naming B's product UUID.
      match: new Set(["product_id"]),
      requiredMatch: new Set(["product_id"]),
      guildScope: {
        kind: "lookup",
        localKey: "product_id",
        foreignTable: "products",
        foreignKey: "id",
        foreignGuildColumn: "guild_id",
      },
    },
  ],
  [
    "level_rewards",
    {
      data: new Set(["announce", "level", "remove_at_level", "role_id"]),
      match: ID_AND_GUILD,
      ...ID_AND_GUILD_SCOPE,
    },
  ],
  [
    "xp_multipliers",
    {
      data: new Set(["multiplier", "role_id"]),
      match: ID_AND_GUILD,
      ...ID_AND_GUILD_SCOPE,
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
      ...ID_AND_GUILD_SCOPE,
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
      ...ID_AND_GUILD_SCOPE,
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
      ...ID_AND_GUILD_SCOPE,
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
      ...ID_AND_GUILD_SCOPE,
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
      ...ID_AND_GUILD_SCOPE,
    },
  ],
  [
    "scheduled_messages",
    {
      // NOTE: current_sends / last_sent_at are deliberately excluded — they are
      // owned by the bot's scheduler runner (packages/bot/src/features/
      // scheduled-messages/runner.ts), not written by the dashboard route
      // (packages/dashboard/src/app/api/scheduled-messages/route.ts only sets
      // the config fields below). Letting undo rewind those counters could
      // duplicate sends or prematurely exhaust max_sends.
      data: new Set([
        "active",
        "channel_id",
        "cron_expression",
        "embed_config_id",
        "end_date",
        "max_sends",
        "message",
        "name",
        "start_date",
        "timezone",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
      ...ID_AND_GUILD_SCOPE,
    },
  ],
  [
    "automations",
    {
      // Runtime/execution metadata is EXCLUDED. execution_count and
      // last_executed_at are maintained by the bot's execution-logger
      // (increment_automation_count RPC, with a last_executed_at fallback), and
      // rate_limit_per_user / rate_limit_window_seconds are consumed by the
      // bot's automation-loader. None are written by the dashboard PUT/POST
      // (which only sets the config fields below via typedPick + updated_at), so
      // a tampered undo must not reset execution history or alter rate limiting.
      data: new Set([
        "actions",
        "conditions",
        "description",
        "enabled",
        "exclude_channel_ids",
        "exclude_user_ids",
        "name",
        "target_channel_ids",
        "target_user_ids",
        "trigger_config",
        "trigger_type",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
      ...ID_AND_GUILD_SCOPE,
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
      ...ID_AND_GUILD_SCOPE,
    },
  ],
  [
    "stats_channels",
    {
      // Bot-owned runtime fields are EXCLUDED. The bot's stats-manager creates
      // the Discord channel and writes channel_id, then writes last_value /
      // last_updated_at on every stats tick. The dashboard PUT only sets
      // stat_type, name_format, stat_config, active (typedPick) + updated_at.
      // Letting undo set channel_id could repoint the bot to rename an arbitrary
      // guild channel on the next tick; rewinding last_value / last_updated_at
      // corrupts the runtime state the bot maintains.
      data: new Set([
        "active",
        "name_format",
        "stat_config",
        "stat_type",
        "updated_at",
      ]),
      match: ID_AND_GUILD,
      ...ID_AND_GUILD_SCOPE,
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
      ...ID_AND_GUILD_SCOPE,
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
      ...ID_AND_GUILD_SCOPE,
    },
  ],
  [
    "giveaways",
    {
      // entries (the entrant list) is EXCLUDED — it is owned by the bot via the
      // atomic giveaway_add_entry / giveaway_remove_entry RPCs and read by the
      // giveaway-manager to select winners. The dashboard PUT only edits
      // admin-controlled fields (prize, winner_count, status, winners, …) and
      // never touches entries. Letting a tampered undo inject or remove
      // participants would change who is eligible for prizes / product
      // entitlements before the bot ends the giveaway.
      data: new Set([
        "channel_id",
        "created_by",
        "ended_at",
        "ends_at",
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
      ...ID_AND_GUILD_SCOPE,
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
      ...ID_AND_GUILD_SCOPE,
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
      ...ID_AND_GUILD_SCOPE,
    },
  ],
  [
    "tutorial_configs",
    {
      // Keyed by guild_id (its primary key), not a surrogate id.
      data: new Set(["auto_trigger", "enabled", "trigger_mode", "updated_at"]),
      match: new Set(["guild_id"]),
      requiredMatch: new Set(["guild_id"]),
      guildScope: { kind: "column", column: "guild_id" },
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
      ...ID_AND_GUILD_SCOPE,
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
      ...ID_AND_GUILD_SCOPE,
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
      ...ID_AND_GUILD_SCOPE,
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
      ...ID_AND_GUILD_SCOPE,
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

/**
 * A tenancy check the undo route must run against the DB before applying a
 * write to a table that has no guild column of its own. Resolve the row named
 * by `keyValue` in `foreignTable` and confirm its `foreignGuildColumn` equals
 * the caller's guild; reject the undo otherwise.
 */
export interface UndoTenancyCheck {
  readonly foreignTable: string;
  readonly foreignKey: string;
  readonly keyValue: unknown;
  readonly foreignGuildColumn: string;
}

export type UndoValidation =
  | {
      ok: true;
      table: string;
      data: Record<string, unknown>;
      match: Record<string, unknown>;
      /**
       * Present only for tables scoped via a parent lookup (no own guild
       * column). The route MUST resolve this and verify it equals ctx.guildId
       * before writing. Absent when the guild scope was already verified
       * synchronously against a guild match column.
       */
      tenancyCheck?: UndoTenancyCheck;
    }
  | { ok: false; reason: string };

/** Caller context needed to scope an undo write to a single tenant. */
export interface UndoContext {
  readonly guildId: string;
}

/**
 * Re-validate a resolved undo payload against the allowlist at APPLY time.
 *
 * Rejects (without any DB write) when:
 *   - table/data/match are not the expected shapes,
 *   - the table is not on the allowlist,
 *   - `match` is empty (an empty match would update every row in the table),
 *   - any column in `data` is not in the table's settable allowlist,
 *   - any column in `match` is not in the table's match allowlist,
 *   - a required identity key is missing from `match` (a tenant-only match
 *     would update every row in the guild), or
 *   - the table has a guild column whose match value does not equal
 *     `ctx.guildId` (a tampered payload naming another guild).
 *
 * `data` and `match` are validated against SEPARATE allowlists: identity/tenant
 * columns are match-only, so a tampered payload cannot set them.
 *
 * For a table scoped via a parent lookup (no own guild column), the guild can't
 * be verified here; the returned `tenancyCheck` tells the route which parent
 * row to resolve and confirm against `ctx.guildId` before applying.
 */
export function validateUndoPayload(
  payload: unknown,
  ctx: UndoContext,
): UndoValidation {
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

  // Require every identity key so the write can only ever hit a single row.
  // Without this a payload could match on the tenant key alone (or, for lookup
  // tables, omit the parent key) and the service-role update would rewrite
  // every matching row instead of the one undo target.
  for (const key of spec.requiredMatch) {
    if (!Object.prototype.hasOwnProperty.call(match, key)) {
      return {
        ok: false,
        reason: `undo match for table "${table}" is missing required identity key "${key}"`,
      };
    }
  }

  // Confine the write to the caller's guild.
  if (spec.guildScope.kind === "column") {
    const { column } = spec.guildScope;
    // requiredMatch guarantees presence for guild-keyed tables; belt-and-braces
    // for id-keyed tables whose guild column is present-but-optional in match.
    if (!Object.prototype.hasOwnProperty.call(match, column)) {
      return {
        ok: false,
        reason: `undo match for table "${table}" is missing guild scope key "${column}"`,
      };
    }
    if (match[column] !== ctx.guildId) {
      return {
        ok: false,
        reason: `undo match for table "${table}" targets a different guild`,
      };
    }
    return { ok: true, table, data, match };
  }

  // Lookup-scoped: no guild column on this table. Hand the route a directive to
  // resolve the owning guild through the parent table and verify it.
  const { localKey, foreignTable, foreignKey, foreignGuildColumn } = spec.guildScope;
  return {
    ok: true,
    table,
    data,
    match,
    tenancyCheck: {
      foreignTable,
      foreignKey,
      keyValue: match[localKey],
      foreignGuildColumn,
    },
  };
}
