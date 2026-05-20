-- V22 Audit Fix: portal_sessions.session_token NOT NULL blocks every portal login
--
-- Root cause: 20260518000001_missing_tables.sql created portal_sessions with
-- session_token TEXT NOT NULL UNIQUE. The Phase D migration (20260518200000)
-- tried CREATE TABLE IF NOT EXISTS with token_hash instead, but was silently
-- skipped. The V10 migration added token_hash alongside session_token but
-- never dropped or made session_token nullable.
--
-- The portal auth code (/api/portal/auth) inserts only token_hash and omits
-- session_token entirely, causing a NOT NULL constraint violation on every
-- customer portal login attempt.
--
-- Fix: Drop the NOT NULL + UNIQUE constraints from session_token (the column
-- is no longer used by any code path — everything uses token_hash). We also
-- update DbPortalSession shared type to mark session_token as optional.

-- 1. Drop the UNIQUE constraint on session_token
ALTER TABLE portal_sessions DROP CONSTRAINT IF EXISTS portal_sessions_session_token_key;

-- 2. Allow NULLs in session_token
ALTER TABLE portal_sessions ALTER COLUMN session_token DROP NOT NULL;

-- 3. Default to NULL for new inserts that omit it
ALTER TABLE portal_sessions ALTER COLUMN session_token SET DEFAULT NULL;

-- 4. Ensure token_hash has a unique index (the actual lookup key)
CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_sessions_token_hash
  ON portal_sessions (token_hash)
  WHERE token_hash IS NOT NULL;
