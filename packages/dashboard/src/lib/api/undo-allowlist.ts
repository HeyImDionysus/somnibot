/**
 * Defense-in-depth allowlist for the admin-changes undo route.
 *
 * The undo route replays a stored `undo_payload` ({ table, data, match }) as a
 * Supabase `.from(table).update(data).match(match)`. Those field values are
 * read back from a database row, so a corrupted or tampered row could try to
 * steer the write at a sensitive table (e.g. `users`, `guild_secrets`) or at
 * columns the undo system never legitimately writes.
 *
 * This map is the single source of truth for what undo may touch:
 *   - keys        = the only tables undo may target.
 *   - value Set   = the only columns undo may set (`data`) or match on (`match`)
 *                   for that table.
 *
 * Column sets are derived from the real table schemas in
 * packages/supabase/migrations. This is a fail-closed security control: a
 * column that is not listed here is rejected even if it exists in the schema.
 * The undo route must never trust the table/column names carried in the
 * stored payload.
 */
export const UNDO_TABLE_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = {
  guild_config: new Set([
    "alert_channel_id",
    "allow_duplicates",
    "anti_raid_account_age_days",
    "anti_raid_action",
    "anti_raid_ban_delete_seconds",
    "anti_raid_enabled",
    "anti_raid_join_threshold",
    "anti_raid_join_window_seconds",
    "anti_raid_log_channel_id",
    "custom_bot_statuses",
    "data_retention_days",
    "default_volume",
    "dj_role_id",
    "economy_enabled",
    "economy_gathering_enabled",
    "economy_pet_decay_interval_hours",
    "economy_pets_enabled",
    "escalation_chain",
    "goodbye_channel_id",
    "goodbye_message",
    "grace_period_days",
    "guild_id",
    "infraction_expiry_days",
    "interest_role_mapping",
    "level_up_channel_id",
    "level_up_message",
    "max_queue_length",
    "message_log_channel_id",
    "message_log_enabled",
    "music_auto_destroy_minutes",
    "music_auto_leave_minutes",
    "music_default_volume",
    "music_enabled",
    "no_xp_role_id",
    "onboarding_config",
    "onboarding_enabled",
    "paypal_enabled",
    "rank_card_accent_color",
    "rank_card_background",
    "returning_member_restore_entitlements",
    "returning_member_restore_levels",
    "returning_member_skip_welcome_dm",
    "starboard_channel_id",
    "starboard_emoji",
    "starboard_enabled",
    "starboard_self_star",
    "starboard_threshold",
    "stats_category_id",
    "stats_update_interval_minutes",
    "store_channel_id",
    "sync_auto_repair",
    "sync_auto_repair_everyone",
    "sync_interval_minutes",
    "ticket_dm_transcript",
    "ticket_satisfaction_survey",
    "voice_xp_enabled",
    "voice_xp_interval_minutes",
    "voice_xp_per_interval",
    "welcome_auto_roles",
    "welcome_card_background",
    "welcome_card_enabled",
    "welcome_channel_id",
    "welcome_dm_enabled",
    "welcome_dm_message",
    "welcome_message",
    "xp_channel_list",
    "xp_channel_mode",
    "xp_cooldown_seconds",
    "xp_max",
    "xp_min",
    "xp_multiplier_mode",
  ]),
  products: new Set([
    "active",
    "created_at",
    "currency",
    "delivery_type",
    "description",
    "granted_channel_ids",
    "granted_role_ids",
    "guild_id",
    "id",
    "metadata",
    "name",
    "paypal_product_id",
    "price_cents",
    "sort_order",
    "type",
    "updated_at",
  ]),
  product_files: new Set([
    "created_at",
    "description",
    "download_count",
    "external_url",
    "file_path",
    "file_size_bytes",
    "guild_id",
    "id",
    "mime_type",
    "name",
    "product_id",
    "size_bytes",
    "sort_order",
  ]),
  product_license_config: new Set([
    "created_at",
    "device_policy",
    "feature_flags",
    "heartbeat_interval_seconds",
    "license_mode",
    "max_devices",
    "offline_grace_period_seconds",
    "product_id",
    "require_discord_guild_membership",
    "tier",
    "updated_at",
    "watermark_config",
  ]),
  level_rewards: new Set([
    "announce",
    "created_at",
    "guild_id",
    "id",
    "level",
    "remove_at_level",
    "role_id",
  ]),
  xp_multipliers: new Set([
    "created_at",
    "guild_id",
    "id",
    "multiplier",
    "role_id",
  ]),
  reaction_roles: new Set([
    "active",
    "channel_id",
    "created_at",
    "emoji",
    "exclusive_group",
    "guild_id",
    "id",
    "log_actions",
    "max_per_group",
    "message_id",
    "remove_on_unreact",
    "require_level",
    "require_role",
    "role_id",
  ]),
  automod_rules: new Set([
    "action",
    "config",
    "created_at",
    "enabled",
    "exempt_channels",
    "exempt_roles",
    "guild_id",
    "id",
    "log_to_mod_channel",
    "mute_duration_minutes",
    "name",
    "priority",
    "sync_to_discord",
    "type",
    "updated_at",
  ]),
  custom_commands: new Set([
    "actions",
    "allowed_channels",
    "allowed_roles",
    "cooldown_seconds",
    "created_at",
    "denied_channels",
    "denied_roles",
    "description",
    "discord_command_id",
    "enabled",
    "ephemeral",
    "guild_id",
    "id",
    "name",
    "updated_at",
  ]),
  ticket_panels: new Set([
    "active",
    "channel_id",
    "closed_category_id",
    "created_at",
    "dm_transcript_to_creator",
    "forum_config",
    "guild_id",
    "id",
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
  embed_configs: new Set([
    "author_icon_url",
    "author_name",
    "author_url",
    "color",
    "components_v2_data",
    "created_at",
    "description",
    "fields",
    "footer_icon_url",
    "footer_text",
    "guild_id",
    "id",
    "image_url",
    "include_timestamp",
    "name",
    "thumbnail_url",
    "title",
    "updated_at",
    "use_components_v2",
  ]),
  scheduled_messages: new Set([
    "active",
    "channel_id",
    "created_at",
    "cron_expression",
    "current_sends",
    "embed_config_id",
    "end_date",
    "guild_id",
    "id",
    "last_sent_at",
    "max_sends",
    "message",
    "name",
    "start_date",
    "timezone",
    "updated_at",
  ]),
  automations: new Set([
    "actions",
    "conditions",
    "created_at",
    "description",
    "enabled",
    "exclude_channel_ids",
    "exclude_user_ids",
    "execution_count",
    "guild_id",
    "id",
    "last_executed_at",
    "name",
    "rate_limit_per_user",
    "rate_limit_window_seconds",
    "target_channel_ids",
    "trigger_config",
    "trigger_type",
    "updated_at",
  ]),
  economy_items: new Set([
    "active",
    "category",
    "created_at",
    "description",
    "emoji",
    "guild_id",
    "id",
    "name",
    "price",
    "sell_price",
    "sort_order",
    "updated_at",
  ]),
  stats_channels: new Set([
    "active",
    "channel_id",
    "created_at",
    "guild_id",
    "id",
    "last_updated_at",
    "last_value",
    "name_format",
    "stat_config",
    "stat_type",
    "updated_at",
  ]),
  temp_channel_hubs: new Set([
    "active",
    "allow_text_channel",
    "category_id",
    "created_at",
    "default_bitrate",
    "default_user_limit",
    "guild_id",
    "hub_channel_id",
    "id",
    "keep_alive_minutes",
    "moderator_roles",
    "naming_format",
    "updated_at",
  ]),
  channel_templates: new Set([
    "base_template_id",
    "created_at",
    "description",
    "guild_id",
    "id",
    "is_builtin",
    "name",
    "overrides",
    "target_channel_type",
    "updated_at",
  ]),
  giveaways: new Set([
    "channel_id",
    "created_at",
    "created_by",
    "ended_at",
    "ends_at",
    "entries",
    "guild_id",
    "id",
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
  polls: new Set([
    "allow_multiple",
    "channel_id",
    "closed_at",
    "created_at",
    "creator_user_id",
    "description",
    "ends_at",
    "guild_id",
    "id",
    "message_id",
    "status",
    "title",
  ]),
  predictions: new Set([
    "channel_id",
    "created_at",
    "creator_user_id",
    "guild_id",
    "id",
    "locked_at",
    "message_id",
    "resolved_at",
    "status",
    "title",
    "total_pool",
    "winning_option_id",
  ]),
  tutorial_configs: new Set([
    "auto_trigger",
    "enabled",
    "guild_id",
    "trigger_mode",
    "updated_at",
  ]),
  tutorial_steps: new Set([
    "built_in_key",
    "created_at",
    "description",
    "guild_id",
    "id",
    "image_url",
    "step_order",
    "title",
  ]),
  role_templates: new Set([
    "base_template_id",
    "created_at",
    "description",
    "guild_id",
    "id",
    "is_builtin",
    "name",
    "permission_details",
    "permissions",
    "tier",
    "updated_at",
  ]),
  alerts: new Set([
    "acknowledged",
    "acknowledged_at",
    "acknowledged_by",
    "alert_type",
    "auto_resolved",
    "created_at",
    "details",
    "guild_id",
    "id",
    "message",
    "metadata",
    "resolved",
    "resolved_at",
    "severity",
    "title",
    "updated_at",
  ]),
  fraud_rules: new Set([
    "action",
    "auto_action",
    "config",
    "created_at",
    "description",
    "enabled",
    "guild_id",
    "id",
    "last_triggered",
    "name",
    "rule_type",
    "trigger_count",
    "updated_at",
  ]),
};

/**
 * Tables the undo route may target — derived from UNDO_TABLE_COLUMNS so the two
 * allowlists can never drift apart.
 */
export const UNDOABLE_TABLES: ReadonlySet<string> = new Set(Object.keys(UNDO_TABLE_COLUMNS));

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
 *   - any column in `data` or `match` is not allowlisted for that table.
 */
export function validateUndoPayload(payload: unknown): UndoValidation {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: "undo payload is not an object" };
  }

  const { table, data, match } = payload as Record<string, unknown>;

  if (typeof table !== "string") {
    return { ok: false, reason: "undo payload table is not a string" };
  }
  const columns = UNDO_TABLE_COLUMNS[table];
  if (!columns) {
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

  for (const column of [...Object.keys(data), ...Object.keys(match)]) {
    if (!columns.has(column)) {
      return {
        ok: false,
        reason: `column "${column}" is not allowlisted for table "${table}"`,
      };
    }
  }

  return { ok: true, table, data, match };
}
