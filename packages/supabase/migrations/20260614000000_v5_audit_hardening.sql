-- V5 Production Audit — Targeted hardening fixes
--
-- §4.P3a: Add explicit p_amount > 0 guard to economy_add_balance.
--         The CHECK constraint on economy_wallets.wallet >= 0 already
--         prevents negative balances, but this rejects the call early
--         with a clear error message.
--
-- §14.P3a: Increase data retention batch size from 10k to 50k and
--          add a loop that processes up to 5 batches per invocation
--          so weekly cron jobs can catch up from backlog.

-- ── §4.P3a: economy_add_balance — reject non-positive amounts ──

CREATE OR REPLACE FUNCTION economy_add_balance(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_amount INT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- V5 Audit §4.P3a: Reject non-positive amounts explicitly
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'economy_add_balance: amount must be positive, got %', p_amount;
  END IF;

  INSERT INTO public.economy_wallets (guild_id, user_id, wallet, updated_at)
  VALUES (p_guild_id, p_user_id, p_amount, now())
  ON CONFLICT (guild_id, user_id)
  DO UPDATE SET wallet = public.economy_wallets.wallet + p_amount, updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION economy_add_balance(TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION economy_add_balance(TEXT, TEXT, INT) TO service_role;


-- ── §14.P3a: Improved cleanup_old_records with batch looping ──

CREATE OR REPLACE FUNCTION cleanup_old_records(
  p_table_name TEXT,
  p_retention_days INT,
  p_batch_size INT DEFAULT 50000
)
RETURNS INT  -- total rows deleted
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted INT := 0;
  v_batch   INT;
  v_total   INT := 0;
  v_max_batches CONSTANT INT := 5;
  v_batch_num INT := 0;
BEGIN
  -- Validate table name against an allowlist to prevent SQL injection
  IF p_table_name NOT IN (
    'economy_transactions', 'audit_logs', 'license_validations', 'webhook_events'
  ) THEN
    RAISE EXCEPTION 'cleanup_old_records: table % not in allowlist', p_table_name;
  END IF;

  -- V5 Audit §14.P3a: Loop up to v_max_batches times per invocation.
  -- Each batch deletes up to p_batch_size rows. This allows the weekly
  -- cron to process up to 250k rows per run instead of just 10k.
  LOOP
    v_batch_num := v_batch_num + 1;
    EXIT WHEN v_batch_num > v_max_batches;

    EXECUTE format(
      'DELETE FROM public.%I WHERE ctid IN (
         SELECT ctid FROM public.%I
         WHERE created_at < now() - interval ''%s days''
         LIMIT %s
       )',
      p_table_name, p_table_name, p_retention_days, p_batch_size
    );

    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;

    -- Exit early if this batch was smaller than the limit (no more rows to clean)
    EXIT WHEN v_batch < p_batch_size;
  END LOOP;

  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION cleanup_old_records(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cleanup_old_records(TEXT, INT, INT) TO service_role;
