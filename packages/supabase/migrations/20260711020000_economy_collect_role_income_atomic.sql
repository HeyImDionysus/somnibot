-- =============================================================================
-- Atomic role-income collection with commerce-role exclusion.
--
-- Real-money commerce roles must never earn wagerable game currency.  The
-- previous bot implementation verified provenance with several independent
-- reads, claimed cooldowns in Valkey, and only then credited the wallet.  That
-- allowed concurrent double collection and could burn cooldowns when the
-- wallet write failed.
--
-- This migration makes verification, cooldown claims, wallet credit, and
-- request replay one serializable database operation.  Provenance is limited
-- to user-specific durable evidence: entitlement snapshots, commerce temporary
-- grants, and outstanding role-revocation work.  Mutable product metadata and
-- unrelated order history are deliberately not sale evidence.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.economy_role_income_claims (
  guild_id          TEXT        NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  user_id           TEXT        NOT NULL,
  role_id           TEXT        NOT NULL,
  next_available_at TIMESTAMPTZ NOT NULL,
  last_request_id   TEXT        NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id, role_id)
);

CREATE TABLE IF NOT EXISTS public.economy_role_income_requests (
  guild_id   TEXT        NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  user_id    TEXT        NOT NULL,
  request_id TEXT        NOT NULL,
  result     JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_economy_role_income_claims_due
  ON public.economy_role_income_claims (guild_id, user_id, next_available_at);

CREATE INDEX IF NOT EXISTS idx_economy_role_income_requests_created
  ON public.economy_role_income_requests (created_at);

CREATE INDEX IF NOT EXISTS idx_action_queue_dlq_original_retry
  ON public.action_queue_dlq (original_id, retried)
  WHERE original_id IS NOT NULL;

ALTER TABLE public.economy_role_income_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.economy_role_income_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_all ON public.economy_role_income_claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON public.economy_role_income_requests
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.economy_role_income_claims
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.economy_role_income_requests
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.economy_role_income_claims
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.economy_role_income_requests
  TO service_role;

-- Restate the complete current member-purge contract while extending it for
-- the two new user-scoped ledgers. Migration 20260710180000 accidentally
-- reintroduced a DELETE from the already-dropped economy_trivia_sessions table
-- and omitted the grace-alert resolution added in 20260710070000; merely
-- wrapping that function would preserve a runtime-aborting privacy RPC.
CREATE OR REPLACE FUNCTION public.purge_member_data(
  p_guild_id TEXT,
  p_user_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted JSONB := '{}'::JSONB;
  v_count INTEGER;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'purge_member_data: p_guild_id is required';
  END IF;
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'purge_member_data: p_user_id is required';
  END IF;

  -- Serialize with collection and temporary-commerce grant preparation so a
  -- concurrent request cannot recreate user-scoped state during the purge.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'economy-role-income:' || p_guild_id || ':' || p_user_id,
      0
    )
  );

  DELETE FROM public.economy_role_income_requests
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'economy_role_income_requests', v_count
  );

  DELETE FROM public.economy_role_income_claims
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'economy_role_income_claims', v_count
  );

  DELETE FROM public.economy_wallets
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_wallets', v_count);

  DELETE FROM public.economy_transactions
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_transactions', v_count);

  DELETE FROM public.economy_inventory
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_inventory', v_count);

  DELETE FROM public.economy_streaks
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_streaks', v_count);

  DELETE FROM public.economy_market_listings
   WHERE guild_id = p_guild_id AND seller_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_market_listings', v_count);

  DELETE FROM public.economy_farm_plots
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_farm_plots', v_count);

  DELETE FROM public.economy_fish_catches
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_fish_catches', v_count);

  DELETE FROM public.economy_adventure_sessions
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_adventure_sessions', v_count);

  -- economy_trivia_sessions was dropped in 20260601000004; trivia is Valkey-backed.

  DELETE FROM public.economy_lottery_tickets
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_lottery_tickets', v_count);

  DELETE FROM public.economy_pets
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_pets', v_count);

  UPDATE public.economy_pet_battles
     SET challenger_id = CASE
           WHEN challenger_id = p_user_id THEN 'deleted_user'
           ELSE challenger_id
         END,
         defender_id = CASE
           WHEN defender_id = p_user_id THEN 'deleted_user'
           ELSE defender_id
         END,
         winner_id = CASE
           WHEN winner_id = p_user_id THEN 'deleted_user'
           ELSE winner_id
         END
   WHERE guild_id = p_guild_id
     AND (challenger_id = p_user_id OR defender_id = p_user_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'economy_pet_battles_anonymized', v_count
  );

  DELETE FROM public.economy_quest_progress
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_quest_progress', v_count);

  DELETE FROM public.economy_user_achievements
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_user_achievements', v_count);

  DELETE FROM public.economy_prestige
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_prestige', v_count);

  DELETE FROM public.economy_profiles
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_profiles', v_count);

  -- Participant rows are the heist crew source of truth after 20260710180000.
  DELETE FROM public.economy_heist_participants
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object(
    'economy_heist_participants', v_count
  );

  DELETE FROM public.economy_daily_losses
   WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('economy_daily_losses', v_count);

  DELETE FROM public.member_levels
   WHERE guild_id = p_guild_id AND member_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('member_levels', v_count);

  UPDATE public.infractions
     SET member_id = 'deleted_user'
   WHERE guild_id = p_guild_id AND member_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('infractions_anonymized', v_count);

  DELETE FROM public.members
   WHERE guild_id = p_guild_id AND discord_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('members', v_count);

  UPDATE public.license_sessions
     SET active = false,
         deactivated_at = pg_catalog.now(),
         deactivation_reason = 'entitlement_revoked'
   WHERE license_key_id IN (
     SELECT key.id
       FROM public.license_keys AS key
      WHERE key.guild_id = p_guild_id
        AND key.bound_discord_id = p_user_id
   )
     AND active = true;

  UPDATE public.license_keys
     SET status = 'revoked',
         revoked_at = pg_catalog.now(),
         revocation_reason = 'user_data_purge'
   WHERE guild_id = p_guild_id
     AND bound_discord_id = p_user_id
     AND status IN ('active', 'pending_activation', 'suspended');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('license_keys_revoked', v_count);

  -- The entitlement trigger installed by 20260711030000 atomically persists
  -- any paid role-revoke intent before this status change can commit.
  UPDATE public.entitlements
     SET status = 'cancelled',
         cancelled_at = pg_catalog.now()
   WHERE guild_id = p_guild_id
     AND customer_id IN (
       SELECT customer.id
         FROM public.customers AS customer
        WHERE customer.discord_id = p_user_id
          AND customer.guild_id = p_guild_id
     )
     AND status IN ('active', 'pending', 'grace_period', 'suspended');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('entitlements_revoked', v_count);

  UPDATE public.alerts AS alert
     SET resolved = true,
         resolved_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   WHERE alert.guild_id = p_guild_id
     AND alert.alert_type = 'entitlement_grace_period'
     AND alert.resolved = false
     AND (alert.metadata ->> 'entitlement_id') IN (
       SELECT entitlement.id::TEXT
         FROM public.entitlements AS entitlement
        WHERE entitlement.guild_id = p_guild_id
          AND entitlement.customer_id IN (
            SELECT customer.id
              FROM public.customers AS customer
             WHERE customer.discord_id = p_user_id
               AND customer.guild_id = p_guild_id
          )
     );

  DELETE FROM public.poll_votes
   WHERE user_id = p_user_id
     AND poll_id IN (
       SELECT poll.id
         FROM public.polls AS poll
        WHERE poll.guild_id = p_guild_id
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('poll_votes', v_count);

  UPDATE public.tickets
     SET creator_id = 'deleted_user'
   WHERE guild_id = p_guild_id AND creator_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('tickets_anonymized', v_count);

  UPDATE public.audit_logs
     SET actor_id = CASE
           WHEN actor_type = 'user' AND actor_id = p_user_id
             THEN 'deleted_user'
           ELSE actor_id
         END,
         target_id = CASE
           WHEN target_type = 'member' AND target_id = p_user_id
             THEN 'deleted_user'
           ELSE target_id
         END,
         details = COALESCE(details, '{}'::JSONB)
           || '{"anonymized": true}'::JSONB
   WHERE guild_id = p_guild_id
     AND (
       (actor_type = 'user' AND actor_id = p_user_id)
       OR (target_type = 'member' AND target_id = p_user_id)
     );

  UPDATE public.giveaways
     SET entries = pg_catalog.array_remove(entries, p_user_id)
   WHERE guild_id = p_guild_id
     AND p_user_id = ANY(entries);

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_member_data(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_member_data(TEXT, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.economy_get_or_create_wallet(
  p_guild_id TEXT,
  p_user_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_wallet public.economy_wallets%ROWTYPE;
  v_starting_balance BIGINT := 0;
  v_wallet_created BOOLEAN := false;
BEGIN
  IF p_guild_id IS NULL OR btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'economy_get_or_create_wallet: p_guild_id is required';
  END IF;
  IF p_user_id IS NULL OR btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'economy_get_or_create_wallet: p_user_id is required';
  END IF;

  -- Bot wallet initialization and role-income collection both use this
  -- member-scoped lock, closing their insert/update race.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'economy-role-income:' || p_guild_id || ':' || p_user_id,
      0
    )
  );

  SELECT wallet.*
    INTO v_wallet
    FROM public.economy_wallets AS wallet
   WHERE wallet.guild_id = p_guild_id
     AND wallet.user_id = p_user_id
     FOR UPDATE;

  IF FOUND THEN
    RETURN pg_catalog.to_jsonb(v_wallet);
  END IF;

  SELECT COALESCE(config.economy_starting_balance, 0)
    INTO v_starting_balance
    FROM public.guild_config AS config
   WHERE config.guild_id = p_guild_id;
  v_starting_balance := COALESCE(v_starting_balance, 0);

  INSERT INTO public.economy_wallets (
    guild_id,
    user_id,
    wallet,
    bank,
    total_earned,
    total_spent
  ) VALUES (
    p_guild_id,
    p_user_id,
    v_starting_balance,
    0,
    v_starting_balance,
    0
  )
  ON CONFLICT (guild_id, user_id)
  DO NOTHING
  RETURNING * INTO v_wallet;
  v_wallet_created := FOUND;

  -- A legacy or administrative writer may not yet share the advisory lock.
  -- If it won the primary-key race, return that authoritative existing row and
  -- leave starting-balance ownership with the transaction that inserted it.
  IF NOT v_wallet_created THEN
    SELECT wallet.*
      INTO v_wallet
      FROM public.economy_wallets AS wallet
     WHERE wallet.guild_id = p_guild_id
       AND wallet.user_id = p_user_id
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'economy_get_or_create_wallet: wallet creation raced with deletion';
    END IF;
  ELSIF v_starting_balance > 0 THEN
    INSERT INTO public.economy_transactions (
      guild_id,
      user_id,
      type,
      amount,
      balance_after,
      description
    ) VALUES (
      p_guild_id,
      p_user_id,
      'admin_add',
      v_starting_balance,
      v_starting_balance,
      'Starting balance'
    );
  END IF;

  RETURN pg_catalog.to_jsonb(v_wallet);
END;
$$;

REVOKE ALL ON FUNCTION public.economy_get_or_create_wallet(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_get_or_create_wallet(TEXT, TEXT)
  TO service_role;

-- All production credit paths converge on the same wallet initializer. This
-- replaces the earlier upsert, which could win a first-wallet race without the
-- configured starting balance or its ledger entry.
CREATE OR REPLACE FUNCTION public.economy_add_balance(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount BIGINT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive, got %', p_amount;
  END IF;

  PERFORM public.economy_get_or_create_wallet(p_guild_id, p_user_id);

  UPDATE public.economy_wallets
     SET wallet = wallet + p_amount,
         total_earned = total_earned + p_amount,
         updated_at = now()
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'economy_add_balance: wallet initialization returned no row';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_add_balance(TEXT, TEXT, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_add_balance(TEXT, TEXT, BIGINT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.economy_credit_wallet(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount BIGINT,
  p_reason TEXT DEFAULT 'credit'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_balance BIGINT;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'economy_credit_wallet: p_amount must be positive, got %', p_amount;
  END IF;

  PERFORM public.economy_get_or_create_wallet(p_guild_id, p_user_id);

  UPDATE public.economy_wallets
     SET wallet = wallet + p_amount,
         total_earned = total_earned + p_amount,
         updated_at = now()
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id
  RETURNING wallet INTO v_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'economy_credit_wallet: wallet initialization returned no row';
  END IF;

  INSERT INTO public.economy_transactions (
    guild_id,
    user_id,
    type,
    amount,
    balance_after,
    description
  ) VALUES (
    p_guild_id,
    p_user_id,
    'level_bonus',
    p_amount,
    v_balance,
    p_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.economy_credit_wallet(TEXT, TEXT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_credit_wallet(TEXT, TEXT, BIGINT, TEXT)
  TO service_role;

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
