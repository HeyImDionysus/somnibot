-- Prediction bet limits: back the prediction-min-bet / prediction-max-bet controls.
--
-- The catalog (community.json) declares prediction-min-bet (default 1) and
-- prediction-max-bet (default 0 = uncapped), but guild_config had no column for
-- either and PollsManager.placeBet enforced no floor/cap — the only guards were
-- the slash-command setMinValue(1) and the prediction_bets amount>0 CHECK. So a
-- raised minimum (e.g. 100) could never take effect. Add the columns with the
-- catalog defaults so the controls are actually honored.

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS prediction_min_bet integer NOT NULL DEFAULT 1
    CHECK (prediction_min_bet >= 1),
  ADD COLUMN IF NOT EXISTS prediction_max_bet integer NOT NULL DEFAULT 0
    CHECK (prediction_max_bet >= 0);
