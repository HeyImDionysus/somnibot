-- Audit V2 Finding 13.3 — Data retention policy
--
-- Adds a comment documenting the retention schedule and ensures
-- indexes exist for efficient retention-based deletes.
--
-- Retention schedule:
--   audit_logs:       90 days
--   portal_sessions:  deleted on expiry
--   webhook_events:   30 days (processed/ignored only)

-- Index for efficient audit log pruning by guild + date
CREATE INDEX IF NOT EXISTS idx_audit_logs_guild_created
  ON audit_logs (guild_id, timestamp);

-- Index for efficient portal session expiry cleanup
CREATE INDEX IF NOT EXISTS idx_portal_sessions_guild_expires
  ON portal_sessions (guild_id, expires_at);

-- Index for efficient webhook event pruning
CREATE INDEX IF NOT EXISTS idx_webhook_events_guild_status_created
  ON webhook_events (guild_id, result, processed_at);

-- Document retention policy
COMMENT ON TABLE audit_logs IS 'Retained for 90 days, then pruned by bot cron.';
COMMENT ON TABLE portal_sessions IS 'Expired sessions pruned by bot cron every 6h.';
COMMENT ON TABLE webhook_events IS 'Processed/ignored events pruned after 30 days by bot cron.';
