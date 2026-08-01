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
        -- Review 3691625811: a value like two bare stars passed every rule
        -- above (non-ASCII, short, no alphanumerics) yet is TWO reactions'
        -- worth of emoji — Discord reactions carry one, and the handler
        -- compares exactly, so such configs could never match and starboard
        -- silently never fired. Normalize them to the default.
        OR NOT (
        pg_catalog.char_length(starboard_emoji) = 1
        -- ANCHORED single-cluster shapes (review 3691834557: a containment
        -- test let star+VS16+star through because it CONTAINED a modifier).
        -- base + optional VS16 (presentation): e.g. red heart.
        OR starboard_emoji ~ ('^.' || pg_catalog.chr(65039) || '?$')
        -- base + optional VS16 + skin tone: e.g. thumbs up medium.
        OR starboard_emoji ~ (
          '^.' || pg_catalog.chr(65039) || '?['
              || pg_catalog.chr(127995) || '-' || pg_catalog.chr(127999) || ']$'
        )
        -- ZWJ sequence: 2-7 segments of base(+VS16/skin) joined end to end.
        OR starboard_emoji ~ (
          '^.' || pg_catalog.chr(65039) || '?['
              || pg_catalog.chr(127995) || '-' || pg_catalog.chr(127999) || ']?('
              || pg_catalog.chr(8205) || '.'
              || pg_catalog.chr(65039) || '?['
              || pg_catalog.chr(127995) || '-' || pg_catalog.chr(127999) || ']?){1,6}$'
        )
        -- Flags: exactly two regional indicators.
        OR starboard_emoji ~ (
          '^[' || pg_catalog.chr(127462) || '-' || pg_catalog.chr(127487) || ']{2}$'
        )
        -- Tag sequences (subdivision flags): base + 1-14 tag chars.
        OR starboard_emoji ~ (
          '^.[' || pg_catalog.chr(917536) || '-' || pg_catalog.chr(917631) || ']{1,14}$'
        )
      )
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
        -- Single emoji CLUSTER only (see the normalization above). Residual,
        -- stated: a multi-cluster string that happens to contain a joiner or
        -- modifier (e.g. star+VS16+star) still passes — full grapheme
        -- segmentation is not expressible here; the API-side validator
        -- remains the precise gate, and this blocks the common bare
        -- multi-emoji case.
        AND (
        pg_catalog.char_length(starboard_emoji) = 1
        -- ANCHORED single-cluster shapes (review 3691834557: a containment
        -- test let star+VS16+star through because it CONTAINED a modifier).
        -- base + optional VS16 (presentation): e.g. red heart.
        OR starboard_emoji ~ ('^.' || pg_catalog.chr(65039) || '?$')
        -- base + optional VS16 + skin tone: e.g. thumbs up medium.
        OR starboard_emoji ~ (
          '^.' || pg_catalog.chr(65039) || '?['
              || pg_catalog.chr(127995) || '-' || pg_catalog.chr(127999) || ']$'
        )
        -- ZWJ sequence: 2-7 segments of base(+VS16/skin) joined end to end.
        OR starboard_emoji ~ (
          '^.' || pg_catalog.chr(65039) || '?['
              || pg_catalog.chr(127995) || '-' || pg_catalog.chr(127999) || ']?('
              || pg_catalog.chr(8205) || '.'
              || pg_catalog.chr(65039) || '?['
              || pg_catalog.chr(127995) || '-' || pg_catalog.chr(127999) || ']?){1,6}$'
        )
        -- Flags: exactly two regional indicators.
        OR starboard_emoji ~ (
          '^[' || pg_catalog.chr(127462) || '-' || pg_catalog.chr(127487) || ']{2}$'
        )
        -- Tag sequences (subdivision flags): base + 1-14 tag chars.
        OR starboard_emoji ~ (
          '^.[' || pg_catalog.chr(917536) || '-' || pg_catalog.chr(917631) || ']{1,14}$'
        )
      )
      )
    )
  );

COMMIT;
