BEGIN;

-- The earlier shape check rejected plain ASCII but still allowed arbitrary
-- prose containing one emoji. Keep the database conservative: custom Discord
-- emoji use their exact wire format; Unicode values must be short and contain
-- no alphanumeric or whitespace characters. The API additionally enforces one
-- Unicode grapheme cluster.
UPDATE public.guild_config
   SET starboard_emoji = '⭐'
 WHERE starboard_emoji IS NULL
    OR starboard_emoji <> pg_catalog.btrim(starboard_emoji)
    OR pg_catalog.char_length(starboard_emoji) NOT BETWEEN 1 AND 64
    OR (
      starboard_emoji !~ '^<a?:[A-Za-z0-9_]{2,32}:[0-9]{17,20}>$'
      AND (
        pg_catalog.octet_length(starboard_emoji) = pg_catalog.char_length(starboard_emoji)
        OR pg_catalog.char_length(starboard_emoji) > 16
        OR starboard_emoji ~ '[[:alnum:][:space:]]'
      )
    );

ALTER TABLE public.guild_config
  DROP CONSTRAINT IF EXISTS guild_config_starboard_emoji_shape_check;
ALTER TABLE public.guild_config
  ADD CONSTRAINT guild_config_starboard_emoji_shape_check CHECK (
    starboard_emoji = pg_catalog.btrim(starboard_emoji)
    AND pg_catalog.char_length(starboard_emoji) BETWEEN 1 AND 64
    AND (
      starboard_emoji ~ '^<a?:[A-Za-z0-9_]{2,32}:[0-9]{17,20}>$'
      OR (
        pg_catalog.octet_length(starboard_emoji) > pg_catalog.char_length(starboard_emoji)
        AND pg_catalog.char_length(starboard_emoji) <= 16
        AND starboard_emoji !~ '[[:alnum:][:space:]]'
      )
    )
  );

COMMIT;
