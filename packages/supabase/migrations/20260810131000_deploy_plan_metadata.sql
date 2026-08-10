ALTER TABLE public.guild_desired_state
  ADD COLUMN categories JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN deploy_mode TEXT NOT NULL DEFAULT 'safe';

ALTER TABLE public.guild_desired_state
  ADD CONSTRAINT guild_desired_state_categories_array
    CHECK (jsonb_typeof(categories) = 'array'),
  ADD CONSTRAINT guild_desired_state_deploy_mode
    CHECK (deploy_mode IN ('safe', 'destructive'));

COMMENT ON COLUMN public.guild_desired_state.categories IS
  'Exact category names and positions for the explicit server deployment plan.';

COMMENT ON COLUMN public.guild_desired_state.deploy_mode IS
  'Destructive for the first confirmed deployment; safe reconciliation for reruns.';
