-- ══════════════════════════════════════════════════════════════
-- V50 AUDIT FIXES
-- ══════════════════════════════════════════════════════════════
--
-- C4: Restore giveaway_add_entry / giveaway_remove_entry return types
--     (V42 erroneously changed them from TABLE(entries TEXT[]) to void,
--      breaking the bot's giveaway entry/withdraw flow entirely)
--
-- M2: Add giveaway_atomic_end RPC — gates status flip on 'active'
--     so concurrent checkExpired + manual endGiveaway cannot double-select winners
--
-- M3: Add unique constraint on poll_votes(poll_id, option_id, user_id)
--     + RPC for single-vote poll insert with atomicity
--
-- M4: Add giveaway_atomic_reroll RPC — atomic array extension
--
-- ══════════════════════════════════════════════════════════════

-- ── C4: Restore giveaway_add_entry ────────────────────────────
-- The V42 migration changed the return type to void but the bot
-- relies on RETURNING entries to update the giveaway message.
-- We must DROP first because Postgres cannot ALTER a function's
-- return type via CREATE OR REPLACE.

DROP FUNCTION IF EXISTS giveaway_add_entry(UUID, TEXT);

CREATE OR REPLACE FUNCTION giveaway_add_entry(p_giveaway_id UUID, p_user_id TEXT)
RETURNS TABLE(entries TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.giveaways
  SET entries = array_append(public.giveaways.entries, p_user_id)
  WHERE id = p_giveaway_id
    AND status = 'active'
    AND NOT (p_user_id = ANY(public.giveaways.entries))
  RETURNING public.giveaways.entries;
END;
$$;

-- ── C4: Restore giveaway_remove_entry ─────────────────────────

DROP FUNCTION IF EXISTS giveaway_remove_entry(UUID, TEXT);

CREATE OR REPLACE FUNCTION giveaway_remove_entry(p_giveaway_id UUID, p_user_id TEXT)
RETURNS TABLE(entries TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.giveaways
  SET entries = array_remove(public.giveaways.entries, p_user_id)
  WHERE id = p_giveaway_id
  RETURNING public.giveaways.entries;
END;
$$;

-- ── M2: giveaway_atomic_end ───────────────────────────────────
-- Atomically flips status to 'ended' only if still 'active'.
-- Returns the row only when THIS caller won the race.

CREATE OR REPLACE FUNCTION giveaway_atomic_end(
  p_giveaway_id UUID,
  p_winners TEXT[],
  p_ended_at TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE(
  id UUID,
  entries TEXT[],
  winner_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.giveaways g
  SET status    = 'ended',
      winners   = p_winners,
      ended_at  = p_ended_at
  WHERE g.id = p_giveaway_id
    AND g.status = 'active'
  RETURNING g.id, g.entries, g.winner_count;
END;
$$;

-- ── M3: Unique constraint on poll_votes ───────────────────────
-- Prevents the same user from voting twice for the same option.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_poll_vote_per_option
  ON poll_votes(poll_id, option_id, user_id);

-- ── M3: Atomic single-vote poll insert ────────────────────────
-- For single-vote polls, inserts a vote only if the user has no
-- existing vote on this poll. Returns the inserted row or empty set
-- if the user already voted (race-safe).

CREATE OR REPLACE FUNCTION poll_vote_single(
  p_poll_id UUID,
  p_option_id UUID,
  p_user_id TEXT
)
RETURNS TABLE(vote_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  INSERT INTO public.poll_votes (poll_id, option_id, user_id)
  SELECT p_poll_id, p_option_id, p_user_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.poll_votes pv
    WHERE pv.poll_id = p_poll_id AND pv.user_id = p_user_id
  )
  ON CONFLICT (poll_id, option_id, user_id) DO NOTHING
  RETURNING public.poll_votes.id AS vote_id;
END;
$$;

-- ── M4: giveaway_atomic_reroll ────────────────────────────────
-- Appends new winners atomically. Returns the updated winners array
-- only if the giveaway was still 'ended' (prevents double reroll
-- from overwriting each other's picks).

CREATE OR REPLACE FUNCTION giveaway_atomic_reroll(
  p_giveaway_id UUID,
  p_new_winners TEXT[]
)
RETURNS TABLE(winners TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.giveaways g
  SET winners = g.winners || p_new_winners
  WHERE g.id = p_giveaway_id
    AND g.status = 'ended'
  RETURNING g.winners;
END;
$$;

-- ── Lock down new RPCs ────────────────────────────────────────

DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'giveaway_add_entry(uuid, text)',
    'giveaway_remove_entry(uuid, text)',
    'giveaway_atomic_end(uuid, text[], timestamptz)',
    'poll_vote_single(uuid, uuid, text)',
    'giveaway_atomic_reroll(uuid, text[])'
  ])
  LOOP
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn);      EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM public', fn);    EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END;
$$;
