BEGIN;

CREATE OR REPLACE FUNCTION public.is_discord_snowflake(value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT value IS NOT NULL AND value ~ '^[0-9]{17,20}$';
$$;

CREATE OR REPLACE FUNCTION public.is_discord_snowflake_array(value TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT value IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.unnest(value) AS item
        WHERE NOT public.is_discord_snowflake(item)
     );
$$;

DO $normalize_scalar_references$
DECLARE
  config_column TEXT;
BEGIN
  FOREACH config_column IN ARRAY ARRAY[
    'member_role_id',
    'welcome_channel_id',
    'goodbye_channel_id',
    'mod_log_channel_id',
    'level_up_channel_id',
    'dj_role_id',
    'no_xp_role_id',
    'anti_raid_log_channel_id',
    'starboard_channel_id',
    'message_log_channel_id',
    'economy_log_channel_id',
    'economy_trivia_schedule_channel_id',
    'alert_channel_id',
    'fraud_staff_alert_channel_id'
  ]
  LOOP
    IF EXISTS (
      SELECT 1
        FROM information_schema.columns AS cols
       WHERE cols.table_schema = 'public'
         AND cols.table_name = 'guild_config'
         AND cols.column_name = config_column
    ) THEN
      EXECUTE pg_catalog.format(
        'UPDATE public.guild_config SET %1$I = NULL WHERE %1$I IS NOT NULL AND NOT public.is_discord_snowflake(%1$I)',
        config_column
      );
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.guild_config DROP CONSTRAINT IF EXISTS %1$I',
        'guild_config_' || config_column || '_snowflake_check'
      );
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.guild_config ADD CONSTRAINT %1$I CHECK (%2$I IS NULL OR public.is_discord_snowflake(%2$I))',
        'guild_config_' || config_column || '_snowflake_check',
        config_column
      );
    END IF;
  END LOOP;
END
$normalize_scalar_references$;

DO $normalize_array_references$
DECLARE
  config_column TEXT;
BEGIN
  FOREACH config_column IN ARRAY ARRAY[
    'welcome_auto_roles',
    'xp_channel_list',
    'message_log_ignored_channel_ids'
  ]
  LOOP
    IF EXISTS (
      SELECT 1
        FROM information_schema.columns AS cols
       WHERE cols.table_schema = 'public'
         AND cols.table_name = 'guild_config'
         AND cols.column_name = config_column
    ) THEN
      EXECUTE pg_catalog.format(
        'UPDATE public.guild_config cfg SET %1$I = (
           SELECT COALESCE(array_agg(item ORDER BY ordinal), ARRAY[]::TEXT[])
             FROM pg_catalog.unnest(cfg.%1$I) WITH ORDINALITY AS refs(item, ordinal)
            WHERE public.is_discord_snowflake(item)
         ) WHERE NOT public.is_discord_snowflake_array(cfg.%1$I)',
        config_column
      );
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.guild_config DROP CONSTRAINT IF EXISTS %1$I',
        'guild_config_' || config_column || '_snowflake_check'
      );
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.guild_config ADD CONSTRAINT %1$I CHECK (public.is_discord_snowflake_array(%2$I))',
        'guild_config_' || config_column || '_snowflake_check',
        config_column
      );
    END IF;
  END LOOP;
END
$normalize_array_references$;

UPDATE public.guild_config
   SET starboard_emoji = '⭐'
 WHERE starboard_emoji IS NULL
    OR starboard_emoji <> pg_catalog.btrim(starboard_emoji)
    OR pg_catalog.char_length(starboard_emoji) NOT BETWEEN 1 AND 64
    OR (
      starboard_emoji !~ '^<a?:[A-Za-z0-9_]{2,32}:[0-9]{17,20}>$'
      AND pg_catalog.octet_length(starboard_emoji) = pg_catalog.char_length(starboard_emoji)
    );

ALTER TABLE public.guild_config
  DROP CONSTRAINT IF EXISTS guild_config_starboard_emoji_shape_check;
ALTER TABLE public.guild_config
  ADD CONSTRAINT guild_config_starboard_emoji_shape_check CHECK (
    starboard_emoji = pg_catalog.btrim(starboard_emoji)
    AND pg_catalog.char_length(starboard_emoji) BETWEEN 1 AND 64
    AND (
      starboard_emoji ~ '^<a?:[A-Za-z0-9_]{2,32}:[0-9]{17,20}>$'
      OR pg_catalog.octet_length(starboard_emoji) > pg_catalog.char_length(starboard_emoji)
    )
  );

UPDATE public.guild_config
   SET welcome_card_background = NULL
 WHERE welcome_card_background IS NOT NULL
   AND welcome_card_background !~ '^https?://[^[:space:]]+$';
UPDATE public.guild_config
   SET rank_card_background = NULL
 WHERE rank_card_background IS NOT NULL
   AND rank_card_background !~ '^https?://[^[:space:]]+$';

ALTER TABLE public.guild_config
  DROP CONSTRAINT IF EXISTS guild_config_welcome_card_background_url_check;
ALTER TABLE public.guild_config
  ADD CONSTRAINT guild_config_welcome_card_background_url_check CHECK (
    welcome_card_background IS NULL
    OR (
      pg_catalog.char_length(welcome_card_background) <= 512
      AND welcome_card_background ~ '^https?://[^[:space:]]+$'
    )
  );
ALTER TABLE public.guild_config
  DROP CONSTRAINT IF EXISTS guild_config_rank_card_background_url_check;
ALTER TABLE public.guild_config
  ADD CONSTRAINT guild_config_rank_card_background_url_check CHECK (
    rank_card_background IS NULL
    OR (
      pg_catalog.char_length(rank_card_background) <= 512
      AND rank_card_background ~ '^https?://[^[:space:]]+$'
    )
  );

REVOKE ALL ON FUNCTION public.is_discord_snowflake(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_discord_snowflake_array(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_discord_snowflake(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_discord_snowflake_array(TEXT[]) TO service_role;

COMMIT;
