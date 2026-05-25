-- V5 Audit Fix #7 — Automated data retention via pg_cron.
--
-- Schedules weekly cleanup of high-volume tables using the existing
-- cleanup_old_records() RPC from migration 20260608000000.
--
-- Tables and retention periods:
--   economy_transactions  — 180 days
--   audit_logs             — 90 days
--   license_validations   — 90 days
--   webhook_events        — 30 days
--
-- Each job runs Sunday at 3 AM UTC. Deletes in batches of 10k rows
-- per invocation (enforced by the RPC). For initial backlog, run
-- the cleanup RPCs manually a few times.

-- Enable pg_cron if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule retention jobs (idempotent — unschedule first if they exist)
SELECT cron.unschedule('retention-economy-transactions')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retention-economy-transactions');

SELECT cron.schedule(
  'retention-economy-transactions',
  '0 3 * * 0',
  $$SELECT cleanup_old_records('economy_transactions', 180)$$
);

SELECT cron.unschedule('retention-audit-log')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retention-audit-log');

SELECT cron.schedule(
  'retention-audit-log',
  '10 3 * * 0',
  $$SELECT cleanup_old_records('audit_logs', 90)$$
);

SELECT cron.unschedule('retention-license-validations')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retention-license-validations');

SELECT cron.schedule(
  'retention-license-validations',
  '20 3 * * 0',
  $$SELECT cleanup_old_records('license_validations', 90)$$
);

SELECT cron.unschedule('retention-webhook-events')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retention-webhook-events');

SELECT cron.schedule(
  'retention-webhook-events',
  '30 3 * * 0',
  $$SELECT cleanup_old_records('webhook_events', 30)$$
);
