BEGIN;

-- Align the database boundary with the API's single-grapheme validation for
-- Unicode keycaps. The prior conservative rule rejected these valid emoji
-- because their base is an ASCII digit, #, or *.
UPDATE public.guild_config
   SET starboard_emoji = '⭐'
 WHERE starboard_emoji IS NULL
    OR starboard_emoji <> pg_catalog.btrim(starboard_emoji)
    OR pg_catalog.char_length(starboard_emoji) NOT BETWEEN 1 AND 64
    OR (
      starboard_emoji !~ '^<a?:[A-Za-z0-9_]{2,32}:[0-9]{17,20}>$'
      AND starboard_emoji !~ (
        '^[#*0-9]' || pg_catalog.chr(65039) || '?' || pg_catalog.chr(8419) || '$'
      )
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
      OR starboard_emoji ~ (
        '^[#*0-9]' || pg_catalog.chr(65039) || '?' || pg_catalog.chr(8419) || '$'
      )
      OR (
        pg_catalog.octet_length(starboard_emoji) > pg_catalog.char_length(starboard_emoji)
        AND pg_catalog.char_length(starboard_emoji) <= 16
        AND starboard_emoji !~ '[[:alnum:][:space:]]'
      )
    )
  );

COMMIT;
