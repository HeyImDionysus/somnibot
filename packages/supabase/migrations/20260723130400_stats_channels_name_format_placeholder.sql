-- Stats channel name_format value-placeholder guard (defense in depth).
--
-- The catalog (community.json community-statistics-channels-invalid) contracts
-- that a name format missing the value placeholder is rejected atomically and
-- never persists — otherwise the channel renders a static name that never
-- reflects the live number. The stat_type half is enforced by a CHECK; the
-- placeholder half was enforced nowhere. Primary enforcement lives in the
-- dashboard Zod schema; this CHECK is a belt-and-suspenders guard at the DB so
-- no write path can persist a placeholder-less format. render substitutes both
-- {value} and {count}, so either is accepted.

ALTER TABLE public.stats_channels
  ADD CONSTRAINT stats_channels_name_format_placeholder_check
    CHECK (name_format LIKE '%{value}%' OR name_format LIKE '%{count}%');
