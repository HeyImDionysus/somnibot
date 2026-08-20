ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS economy_trivia_question_source TEXT NOT NULL DEFAULT 'mixed';

ALTER TABLE public.guild_config
  DROP CONSTRAINT IF EXISTS guild_config_economy_trivia_question_source_check;

ALTER TABLE public.guild_config
  ADD CONSTRAINT guild_config_economy_trivia_question_source_check
  CHECK (economy_trivia_question_source IN ('mixed', 'open-trivia-db', 'local'));

COMMENT ON COLUMN public.guild_config.economy_trivia_question_source IS
  'Question source: Open Trivia DB with local fallback, Open Trivia DB only, or local built-in/custom questions.';
