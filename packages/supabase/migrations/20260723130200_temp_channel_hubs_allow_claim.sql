-- Temp channel allow-claim control storage.
--
-- The catalog (community.json allow-claim, default true) lets an owner turn off
-- /voice claim so a remaining member cannot take ownership after the owner
-- leaves. There was no allow_claim column, no dashboard field, and the /voice
-- claim handler never read any toggle — so an owner who disabled claiming still
-- had claims succeed. Back the control with storage (default true = current
-- behaviour) so the toggle is enforceable.

ALTER TABLE public.temp_channel_hubs
  ADD COLUMN IF NOT EXISTS allow_claim boolean NOT NULL DEFAULT true;
