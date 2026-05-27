-- V5 Production Audit — Targeted hardening fixes
--
-- §2.P2a: Add 'pending_review' to orders.status and payments.status CHECK
--         constraints so the PayPal amount-mismatch handler can flag orders.
--
-- §14.P3a: Increase data retention batch size from 10k to 50k and
--          add a loop that processes up to 5 batches per invocation
--          so weekly cron jobs can catch up from backlog.


-- ── §2.P2a: Add pending_review to commerce status constraints ──

-- orders.status: add pending_review for amount-mismatch flagging
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending', 'completed', 'refunded', 'disputed', 'cancelled', 'pending_review'));

-- payments.status: add pending_review for amount-mismatch flagging
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_status_check
  CHECK (status IN ('completed', 'refunded', 'reversed', 'pending', 'failed', 'pending_review'));


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
