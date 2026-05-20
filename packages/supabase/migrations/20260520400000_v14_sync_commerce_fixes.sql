-- V14 Audit: Fix sync module, dashboard APIs, and commerce schema gaps
-- =====================================================================

-- ── C5: members/search queries guild_live_state.members but only member_count exists ──
-- The member search/picker expects a JSONB array of member objects.
-- Bot's snapshot writer already has the data; just needs the column.
ALTER TABLE guild_live_state
  ADD COLUMN IF NOT EXISTS members JSONB DEFAULT NULL;

-- ── C6: store/files/route.ts inserts 7 wrong columns into product_files ──
-- Code expects: guild_id, file_name, display_name, version, storage_path,
-- storage_bucket, size_bytes. Schema has: name, description, file_path,
-- file_size_bytes. Add the missing columns so the upload flow works.
ALTER TABLE product_files
  ADD COLUMN IF NOT EXISTS guild_id TEXT,
  ADD COLUMN IF NOT EXISTS file_name TEXT,
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS version TEXT DEFAULT '1.0.0',
  ADD COLUMN IF NOT EXISTS storage_path TEXT,
  ADD COLUMN IF NOT EXISTS storage_bucket TEXT;

-- Rename size_bytes mismatch: code writes size_bytes, schema has file_size_bytes.
-- Add alias column; keep file_size_bytes for backward compat.
ALTER TABLE product_files
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT;

-- Backfill from existing data
UPDATE product_files SET file_name = name WHERE file_name IS NULL AND name IS NOT NULL;
UPDATE product_files SET display_name = name WHERE display_name IS NULL AND name IS NOT NULL;
UPDATE product_files SET storage_path = file_path WHERE storage_path IS NULL AND file_path IS NOT NULL;
UPDATE product_files SET size_bytes = file_size_bytes WHERE size_bytes IS NULL AND file_size_bytes IS NOT NULL;

-- ── H1: portal/orders selects payments.provider — doesn't exist ──
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'paypal';

-- ── H3: sync/action/route.ts inserts wrong columns into sync_actions ──
-- Code inserts: action, drift_item. Schema has: action_type, target_type, details.
-- Add the code-expected columns.
ALTER TABLE sync_actions
  ADD COLUMN IF NOT EXISTS action TEXT,
  ADD COLUMN IF NOT EXISTS drift_item JSONB;

-- Backfill from existing data
UPDATE sync_actions SET action = action_type WHERE action IS NULL AND action_type IS NOT NULL;

-- ── H2: webhook route calls non-existent exec_sql RPC ──
-- We do NOT create exec_sql (security risk). The primary RPC
-- increment_customer_totals exists since V5 and is the correct path.
-- The code fix removes the dead exec_sql fallback (see TS changes).

-- ── C7: portal/downloads joins products(... files) — column doesn't exist ──
-- Products link to product_files via product_files.product_id FK.
-- The code fix changes the query to join product_files instead (see TS changes).
-- No schema change needed.

-- ── C4: sync-engine audit_logs insert missing actor_id ──
-- Fixed in code (see TS changes). No schema change needed.

-- ── C1-C3: sync module internal_id→template_key, desired_config→JSONB lookup ──
-- Fixed in code (see TS changes). No schema change needed —
-- the table structure is correct; the code was querying wrong columns.
