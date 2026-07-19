-- =============================================================================
-- Extend the role-income wall to exact role-delivery intents.
--
-- The role-delivery protocol replaced broad terminal 'revoke_roles' payloads
-- with 'reconcile_entitlement_roles' carriers whose cleanup payloads carry no
-- role vector or member identity, and 20260711030000 quarantined every
-- pre-protocol revoke_roles queue row and DLQ copy (retired = true). Both
-- changes blinded the collection wall's queue and DLQ clauses: a member whose
-- paid entitlement went terminal could collect game income on the paid
-- Discord role while its removal was still pending or operator-owned.
--
-- public.commerce_role_delivery_intents is the durable removal evidence for
-- the current protocol, so the wall must block every role an unsettled paid
-- intent still accounts for. Settlement is the only intent state that proves
-- removal or a safe handoff to live-entitlement evidence, which the existing
-- entitlement clause already covers. A missing or non-live parent entitlement
-- behind an unsettled intent fails closed: absence of proof is not proof of
-- removal. Non-commerce carriers (manual/giveaway/automation) are excluded
-- exactly as non-purchase entitlements are: they are not real-money
-- provenance and must not gate the game economy.
--
-- This is a standalone redefinition rather than an edit to 20260711020000
-- because the intents table does not exist at that point in the chain.
-- =============================================================================

BEGIN;

-- The wall consults intents once per collection for one guild member; only
-- unsettled rows can ever block, matching this partial index exactly.
CREATE INDEX IF NOT EXISTS commerce_role_delivery_intents_member_unsettled
  ON public.commerce_role_delivery_intents (guild_id, discord_id)
  WHERE state <> 'settled';

CREATE OR REPLACE FUNCTION public.economy_collect_role_income(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_discord_role_ids TEXT[],
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_existing JSONB;
  v_blocked_role_ids TEXT[] := ARRAY[]::TEXT[];
  v_credited_role_ids TEXT[] := ARRAY[]::TEXT[];
  v_total BIGINT := 0;
  v_balance BIGINT;
  v_next_available_at TIMESTAMPTZ;
  v_result JSONB;
  v_rule RECORD;
  v_claim_due TIMESTAMPTZ;
  v_has_cooldown BOOLEAN := false;
BEGIN
  IF p_guild_id IS NULL OR btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'economy_collect_role_income: p_guild_id is required';
  END IF;
  IF p_user_id IS NULL OR btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'economy_collect_role_income: p_user_id is required';
  END IF;
  IF p_request_id IS NULL OR btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'economy_collect_role_income: p_request_id is required';
  END IF;

  -- Serialize every collection and wallet initialization for one guild member.
  -- The durable request row handles replays; this lock handles distinct IDs
  -- and the missing-wallet race.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'economy-role-income:' || p_guild_id || ':' || p_user_id,
      0
    )
  );

  SELECT r.result
    INTO v_existing
    FROM public.economy_role_income_requests AS r
   WHERE r.guild_id = p_guild_id
     AND r.user_id = p_user_id
     AND r.request_id = p_request_id;

  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- Discord interactions cannot be replayed after their short validity
  -- window.  Keep a generous seven-day idempotency horizon while bounding
  -- request-ledger growth for active members.
  DELETE FROM public.economy_role_income_requests AS stale
   WHERE stale.guild_id = p_guild_id
     AND stale.user_id = p_user_id
     AND stale.created_at < v_now - interval '7 days';

  -- Build the paid-role exclusion set from exact, guild- and user-scoped
  -- provenance.  Product metadata and product-global order history are not
  -- consulted because neither proves how this user's Discord role was gained.
  SELECT COALESCE(array_agg(DISTINCT held.role_id ORDER BY held.role_id), ARRAY[]::TEXT[])
    INTO v_blocked_role_ids
    FROM unnest(COALESCE(p_discord_role_ids, ARRAY[]::TEXT[])) AS held(role_id)
   WHERE EXISTS (
           SELECT 1
             FROM public.customers AS c
             JOIN public.entitlements AS e
               ON e.customer_id = c.id
              AND e.guild_id = c.guild_id
            WHERE c.guild_id = p_guild_id
              AND c.discord_id = p_user_id
              AND (
                e.source IS NULL
                OR e.source NOT IN ('giveaway', 'manual', 'automation')
              )
              AND e.status IN ('active', 'pending', 'grace_period', 'suspended')
              AND held.role_id = ANY(COALESCE(e.granted_role_ids, ARRAY[]::TEXT[]))
         )
      OR EXISTS (
           SELECT 1
             FROM public.temp_role_grants AS t
            WHERE t.guild_id = p_guild_id
              AND t.user_id = p_user_id
              AND t.role_id = held.role_id
               -- `economy_purchase` is the legacy commerce label used before
               -- 20260710050000. Rows whose product identity could not be
               -- resolved were deliberately preserved for reconciliation, so
               -- they remain paid-role evidence until that issue is resolved.
               AND t.source IN ('commerce_purchase', 'economy_purchase', 'purchase')
         )
      OR EXISTS (
           SELECT 1
             FROM public.bot_action_queue AS q
            WHERE q.guild_id = p_guild_id
              AND q.action = 'revoke_roles'
              AND (
                q.status IN ('pending', 'processing')
                OR (
                  q.status = 'failed'
                  AND NOT EXISTS (
                    SELECT 1
                      FROM public.action_queue_dlq AS retried_dead_letter
                     WHERE retried_dead_letter.original_id = q.id::TEXT
                       AND COALESCE(retried_dead_letter.retried, false) = true
                  )
                )
              )
              AND q.payload ->> 'discord_id' = p_user_id
              AND jsonb_typeof(q.payload -> 'role_ids') = 'array'
              AND EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements_text(q.payload -> 'role_ids') AS queued(role_id)
                     WHERE queued.role_id = held.role_id
                  )
         )
      OR EXISTS (
           SELECT 1
             FROM public.action_queue_dlq AS d
            WHERE d.guild_id = p_guild_id
              AND d.action = 'revoke_roles'
              AND COALESCE(d.retried, false) = false
              -- Multiple failure paths historically could preserve more than
              -- one DLQ copy for the same queue row. Once any sibling has been
              -- retried, none of those old copies is current revoke evidence;
              -- a failed retry receives a new queue id and its own fresh DLQ.
              AND (
                d.original_id IS NULL
                OR NOT EXISTS (
                  SELECT 1
                    FROM public.action_queue_dlq AS retried_sibling
                   WHERE retried_sibling.original_id = d.original_id
                     AND COALESCE(retried_sibling.retried, false) = true
                )
              )
              AND d.payload ->> 'discord_id' = p_user_id
              AND jsonb_typeof(d.payload -> 'role_ids') = 'array'
              AND EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements_text(d.payload -> 'role_ids') AS dead(role_id)
                     WHERE dead.role_id = held.role_id
                  )
         )
      -- Exact role-delivery intents are the removal evidence of the current
      -- protocol: its 'reconcile_entitlement_roles' cleanup carriers hold no
      -- role vector, so the queue/DLQ clauses above cannot see them. Every
      -- role an unsettled paid intent reserved, completed, or still owns
      -- remains paid-role evidence while cleanup is pending, operator-owned,
      -- or mid-mutation, and while the parent entitlement is not provably
      -- live. Settlement alone proves removal or a safe handoff; a live
      -- parent is already covered by the entitlement clause above.
      OR EXISTS (
           SELECT 1
             FROM public.commerce_role_delivery_intents AS intent
            WHERE intent.guild_id = p_guild_id
              AND intent.discord_id = p_user_id
              AND intent.contract_kind = 'paid'
              AND intent.state <> 'settled'
              AND (
                held.role_id = ANY(intent.owned_role_ids)
                OR held.role_id = ANY(intent.reserved_role_ids)
                OR held.role_id = ANY(intent.completed_role_ids)
              )
              AND (
                intent.state IN ('cleanup_required', 'operator_required')
                OR intent.cleanup_mutation_token IS NOT NULL
                OR NOT EXISTS (
                      SELECT 1
                        FROM public.entitlements AS parent
                       WHERE parent.id = intent.entitlement_id
                         AND parent.status IN (
                           'active', 'pending', 'grace_period', 'suspended'
                         )
                    )
              )
         );

  -- Deterministic ordering makes both the credited-role list and the single
  -- transaction record stable across retries and query-plan changes.
  FOR v_rule IN
    SELECT i.role_id, i.amount, i.interval_minutes
      FROM public.economy_role_income AS i
     WHERE i.guild_id = p_guild_id
       AND i.role_id = ANY(COALESCE(p_discord_role_ids, ARRAY[]::TEXT[]))
       AND i.amount > 0
       AND i.interval_minutes > 0
       AND NOT (i.role_id = ANY(v_blocked_role_ids))
     ORDER BY i.role_id
  LOOP
    SELECT c.next_available_at
      INTO v_claim_due
      FROM public.economy_role_income_claims AS c
     WHERE c.guild_id = p_guild_id
       AND c.user_id = p_user_id
       AND c.role_id = v_rule.role_id;

    IF FOUND AND v_claim_due > v_now THEN
      v_has_cooldown := true;
      IF v_next_available_at IS NULL OR v_claim_due < v_next_available_at THEN
        v_next_available_at := v_claim_due;
      END IF;
      CONTINUE;
    END IF;

    INSERT INTO public.economy_role_income_claims (
      guild_id,
      user_id,
      role_id,
      next_available_at,
      last_request_id,
      updated_at
    ) VALUES (
      p_guild_id,
      p_user_id,
      v_rule.role_id,
      v_now + make_interval(mins => v_rule.interval_minutes),
      p_request_id,
      v_now
    )
    ON CONFLICT (guild_id, user_id, role_id)
    DO UPDATE SET
      next_available_at = EXCLUDED.next_available_at,
      last_request_id = EXCLUDED.last_request_id,
      updated_at = EXCLUDED.updated_at;

    v_total := v_total + v_rule.amount;
    v_credited_role_ids := array_append(v_credited_role_ids, v_rule.role_id);
  END LOOP;

  IF v_total > 0 THEN
    PERFORM public.economy_get_or_create_wallet(p_guild_id, p_user_id);

    UPDATE public.economy_wallets
       SET wallet = wallet + v_total,
           total_earned = total_earned + v_total,
           updated_at = v_now
     WHERE guild_id = p_guild_id
       AND user_id = p_user_id
    RETURNING wallet INTO v_balance;

    INSERT INTO public.economy_transactions (
      guild_id,
      user_id,
      type,
      amount,
      balance_after,
      description,
      metadata
    ) VALUES (
      p_guild_id,
      p_user_id,
      'role_income',
      v_total,
      v_balance,
      'Role income collection',
      jsonb_build_object(
        'request_id', p_request_id,
        'role_ids', to_jsonb(v_credited_role_ids)
      )
    );

    v_result := jsonb_build_object(
      'status', 'credited',
      'amount_cents', v_total,
      'balance_cents', v_balance,
      'credited_role_ids', to_jsonb(v_credited_role_ids),
      'blocked_role_ids', to_jsonb(v_blocked_role_ids),
      'next_available_at', NULL
    );
  ELSE
    v_result := jsonb_build_object(
      'status', CASE WHEN v_has_cooldown THEN 'cooldown' ELSE 'no_eligible_roles' END,
      'amount_cents', 0,
      'balance_cents', NULL,
      'credited_role_ids', '[]'::JSONB,
      'blocked_role_ids', to_jsonb(v_blocked_role_ids),
      'next_available_at', v_next_available_at
    );
  END IF;

  INSERT INTO public.economy_role_income_requests (guild_id, user_id, request_id, result)
  VALUES (p_guild_id, p_user_id, p_request_id, v_result);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_collect_role_income(TEXT, TEXT, TEXT[], TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_collect_role_income(TEXT, TEXT, TEXT[], TEXT)
  TO service_role;

COMMIT;
