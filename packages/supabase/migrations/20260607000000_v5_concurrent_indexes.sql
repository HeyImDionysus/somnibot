-- V5 Audit — Recreate indexes on large tables using CONCURRENTLY
--
-- The indexes on economy_wallets, economy_transactions,
-- economy_market_listings, and members were originally created
-- without CONCURRENTLY in 20260601000003_v53_phase5_analytics_perf.sql.
-- On tables with significant data, non-concurrent index creation
-- acquires an exclusive lock that blocks all reads and writes.
--
-- This migration drops the old indexes and recreates them with
-- CONCURRENTLY to allow zero-downtime index builds.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction.
-- Supabase CLI respects the following directive to skip the
-- implicit transaction wrapper for this migration file.

-- supabase:disable-transaction

-- ═══════════════════════════════════════════════════════════════════
-- Drop existing indexes first (safe — IF EXISTS)
-- ═══════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_econ_wallet_leaderboard;
DROP INDEX IF EXISTS idx_econ_tx_guild_date;
DROP INDEX IF EXISTS idx_econ_tx_guild_type_date;
DROP INDEX IF EXISTS idx_econ_market_guild_status_date;
DROP INDEX IF EXISTS idx_members_guild_xp;

-- ═══════════════════════════════════════════════════════════════════
-- Recreate with CONCURRENTLY (non-blocking)
-- ═══════════════════════════════════════════════════════════════════

-- Leaderboard composite index (net worth descending, skip suspended)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_econ_wallet_leaderboard
  ON economy_wallets(guild_id, ((wallet + bank)) DESC)
  WHERE suspended = false;

-- Transaction time-range queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_econ_tx_guild_date
  ON economy_transactions(guild_id, created_at DESC);

-- Transaction type breakdown
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_econ_tx_guild_type_date
  ON economy_transactions(guild_id, type, created_at DESC);

-- Market listing date + status queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_econ_market_guild_status_date
  ON economy_market_listings(guild_id, status, created_at DESC);

-- Leaderboard XP index for levels
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_members_guild_xp
  ON members(guild_id, xp DESC);
