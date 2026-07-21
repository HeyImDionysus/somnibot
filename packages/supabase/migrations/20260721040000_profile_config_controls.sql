-- Profile config controls: back the six advertised controls with storage.
--
-- guild_config had none of the profile controls, and ProfilesManager applied no
-- server-side validation: setTitle/setBio persisted the raw option verbatim, and
-- viewProfile always rendered the game-stat fields with no visibility gate. Add
-- the columns with catalog defaults so the controls actually take effect.

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS profiles_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS title_max_length integer NOT NULL DEFAULT 64
    CHECK (title_max_length BETWEEN 1 AND 64),
  ADD COLUMN IF NOT EXISTS bio_max_length integer NOT NULL DEFAULT 256
    CHECK (bio_max_length BETWEEN 1 AND 256),
  ADD COLUMN IF NOT EXISTS profile_visibility text NOT NULL DEFAULT 'everyone'
    CHECK (profile_visibility IN ('everyone', 'members-after-onboarding')),
  ADD COLUMN IF NOT EXISTS content_filter_mode text NOT NULL DEFAULT 'lenient'
    CHECK (content_filter_mode IN ('lenient', 'strict')),
  ADD COLUMN IF NOT EXISTS show_game_stats boolean NOT NULL DEFAULT true;
