-- V19 Audit: Add missing bot_diagnostics memory columns
-- DiagnosticsService writes memory_rss_mb, memory_heap_mb, valkey_memory_mb
-- but no migration ever created them → upserts silently drop the values,
-- dashboard stats/diagnostics routes always show null/0.

ALTER TABLE bot_diagnostics
  ADD COLUMN IF NOT EXISTS memory_rss_mb    REAL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS memory_heap_mb   REAL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS valkey_memory_mb REAL DEFAULT 0;
