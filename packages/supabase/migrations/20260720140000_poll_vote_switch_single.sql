-- Fix: single-choice polls could not switch a vote.
--
-- handlePollVote's single-choice branch calls poll_vote_single, which inserts
-- ONLY when the user has no existing vote on the poll (`WHERE NOT EXISTS`), so a
-- user who already voted is told "You already voted!" and can never move their
-- vote to a different option. The catalog contracts single-choice re-votes as a
-- SWITCH (the community-polls-predictions `switched` assertion).
--
-- poll_vote_switch_single replaces the prior vote atomically: in one statement
-- it removes the user's existing vote(s) on the poll and records the new choice,
-- returning the previous option so the caller can distinguish a switch from a
-- first vote and treat a same-option re-click as a no-op. uniq_poll_vote_per_option
-- (poll_id, option_id, user_id) cannot conflict because the delete precedes the
-- insert within the same transaction.

CREATE OR REPLACE FUNCTION public.poll_vote_switch_single(
  p_poll_id UUID,
  p_option_id UUID,
  p_user_id TEXT
)
RETURNS TABLE(vote_id UUID, previous_option_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prev UUID;
  v_new UUID;
BEGIN
  -- The prior choice on this poll (NULL when this is the user's first vote).
  SELECT pv.option_id INTO v_prev
    FROM public.poll_votes pv
    WHERE pv.poll_id = p_poll_id AND pv.user_id = p_user_id
    LIMIT 1;

  DELETE FROM public.poll_votes
    WHERE poll_id = p_poll_id AND user_id = p_user_id;

  INSERT INTO public.poll_votes (poll_id, option_id, user_id)
    VALUES (p_poll_id, p_option_id, p_user_id)
    RETURNING id INTO v_new;

  RETURN QUERY SELECT v_new, v_prev;
END;
$$;
