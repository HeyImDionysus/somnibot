-- =============================================================================
-- Automod owner-tunable evaluation budgets.
--
-- The catalog exposes regex-eval-budget-ms (50-250, default 250) and
-- message-rule-budget-ms (100-2000, default 500) as owner controls, but both
-- were hardcoded constants in automod-engine.ts (MESSAGE_RULE_BUDGET_MS = 500,
-- VM timeout = 250) with no storage column — the controls were inert. Values
-- happen to equal the catalog defaults, so this is functionally safe, but an
-- owner cannot tune them.
--
-- Add the columns with the catalog defaults + range checks; loadModConfig now
-- reads them and threads them into processMessage / checkWordFilter.
-- =============================================================================

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS automod_regex_budget_ms integer NOT NULL DEFAULT 250
    CHECK (automod_regex_budget_ms BETWEEN 50 AND 250),
  ADD COLUMN IF NOT EXISTS automod_message_budget_ms integer NOT NULL DEFAULT 500
    CHECK (automod_message_budget_ms BETWEEN 100 AND 2000);
