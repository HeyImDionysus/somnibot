# SomniBot Operational Runbook

> Production operations guide for SomniBot (bot + dashboard).

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Deployment](#deployment)
3. [Rollback](#rollback)
4. [Monitoring](#monitoring)
5. [Alert Response](#alert-response)
6. [Database Operations](#database-operations)
7. [Common Issues](#common-issues)

---

## Architecture Overview

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Discord     │────▶│  Bot (Node)  │────▶│  Supabase    │
│  Gateway     │     │  + Valkey    │     │  (Postgres)  │
└─────────────┘     └──────────────┘     └──────────────┘
                           │
                    ┌──────┴──────┐
                    │  Lavalink   │
                    │  (Music)    │
                    └─────────────┘

┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Browser     │────▶│  Dashboard   │────▶│  Supabase    │
│  (User)      │     │  (Next.js)  │     │  (Postgres)  │
└─────────────┘     └──────────────┘     └──────────────┘
```

**Packages:**
- `packages/bot` — Discord bot (discord.js v14)
- `packages/dashboard` — Next.js 15 web dashboard
- `packages/shared` — Shared types, logger, utilities
- `packages/launcher` — Electron desktop launcher
- `packages/license-sdk` — License key validation SDK
- `packages/supabase` — SQL migrations (66 files)

**External services:**
- Supabase (Postgres + Auth + Storage)
- Valkey/Redis (caching, rate limiting, heartbeat)
- Lavalink (music streaming)
- PayPal (commerce)
- Discord API

---

## Deployment

### Prerequisites

```bash
# Required environment variables (see .env.example)
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXTAUTH_SECRET=
```

### Bot Deployment

```bash
# 1. Pull latest
git pull origin main

# 2. Install dependencies
pnpm install --frozen-lockfile

# 3. Build
pnpm build

# 4. Run migrations (auto-runs on bot start, but can be manual)
# Migrations are idempotent (CREATE IF NOT EXISTS, CREATE OR REPLACE)

# 5. Start bot
cd packages/bot && node dist/index.js
```

### Dashboard Deployment

```bash
# Build standalone Next.js
cd packages/dashboard
pnpm build

# Start (standalone output)
node .next/standalone/packages/dashboard/server.js
```

### CI Pipeline

7 CI jobs must pass before merge:
1. **install** — `pnpm install --frozen-lockfile`
2. **typecheck** — `tsc --noEmit` on bot, dashboard, license-sdk
3. **lint** — ESLint on all packages
4. **build** — Production build
5. **test** — Vitest suite
6. **migration-lint** — Naming, ordering, dangerous operations
7. **security** — `pnpm audit --audit-level=high` + secret scanning

---

## Rollback

### Bot Rollback

```bash
# 1. Identify last known good commit
git log --oneline -10

# 2. Deploy previous version
git checkout <commit-hash>
pnpm install --frozen-lockfile
pnpm build
# Restart bot process

# 3. If migration caused issues:
# Migrations are forward-only (CREATE IF NOT EXISTS).
# To undo a migration, create a NEW migration that reverses changes.
# Never delete or modify existing migration files.
```

### Dashboard Rollback

```bash
# Same approach — checkout previous commit, rebuild, restart
git checkout <commit-hash>
cd packages/dashboard
pnpm build
# Restart dashboard process
```

---

## Monitoring

### Heartbeat

- **Valkey heartbeat**: Written every 30s with 2-min TTL
- **Supabase fallback**: Written every 60s
- **Dashboard indicators**:
  - Green: Bot responded within 90s
  - Yellow: Stale >90s (warning)
  - Red: Stale >5min (offline)

### Health Check

```bash
# Bot exposes diagnostics via dashboard API
GET /api/diagnostics
# Returns: uptime, memory, Lavalink status, Valkey connectivity, guild count
```

### Structured Logging

- **Production**: JSON output (parse with jq, ship to log aggregator)
- **Development**: Colored human-readable output
- All logs include: timestamp, level, module, guild_id (where applicable)

### Key Metrics to Monitor

| Metric | Source | Alert Threshold |
|--------|--------|----------------|
| Heartbeat staleness | Valkey/Supabase | >5 min |
| Automation failures | AlertService (consecutive) | 3 consecutive |
| Action queue depth | bot_action_queue table | >100 pending |
| Memory usage | process.memoryUsage() | >1.5GB |
| Valkey connection | HeartbeatService | Disconnected >1 min |

---

## Alert Response

### Bot Offline (Heartbeat Stale)

1. Check bot process is running
2. Check Discord gateway connection (look for `READY` or `RESUMED` in logs)
3. Check Valkey connectivity
4. Check Supabase connectivity
5. Restart if needed: graceful shutdown handles cleanup

### Automation Failures

1. Check `alerts` table for recent entries
2. Check `automation_executions` for error details
3. Common causes: missing permissions, deleted channels, rate limits
4. Fix the underlying issue, then re-enable the automation

### Action Queue Backup

1. Check `bot_action_queue` for stuck `processing` items
2. `bot_action_queue_recover_stale()` RPC handles items stuck >5 min
3. Check for DLQ items (status = 'dead_letter')

### Database Connection Issues

1. Check Supabase status page
2. Verify connection credentials
3. Check connection pool limits
4. HeartbeatService falls back to Supabase when Valkey is down

---

## Database Operations

### Running Migrations

```bash
# Migrations run automatically on bot startup via migration-runner.ts
# The runner:
# 1. Checks schema_migrations table for already-applied migrations
# 2. Verifies SHA-256 checksums (detects tampered migrations)
# 3. Runs new migrations in order
# 4. Stops on first error

# To manually check migration status:
SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 10;
```

### Data Retention

Automated via `pruneExpiredData()` cron (every 6 hours):
- Audit logs: 90 days
- Portal sessions: Deleted on expiry
- Webhook events: 30 days (processed only)

### Backup Strategy

```bash
# Supabase provides automatic daily backups (Pro plan)
# For manual backup:
pg_dump -h <supabase-host> -U postgres -d postgres > backup_$(date +%Y%m%d).sql

# Restore:
psql -h <supabase-host> -U postgres -d postgres < backup_YYYYMMDD.sql
```

### User Data Deletion

```sql
-- Triggered by /forgetme command
-- Calls purge_member_data(guild_id, user_id) RPC
-- Covers 20+ tables, anonymizes audit/ticket records
SELECT purge_member_data('guild-id', 'user-id');
```

---

## Common Issues

### Bot Won't Start

1. Check `DISCORD_TOKEN` is valid
2. Check `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
3. Check Node.js version (>=18 required)
4. Run `pnpm install --frozen-lockfile` to ensure deps are clean

### Dashboard Auth Failures

1. Check `NEXTAUTH_SECRET` is set
2. Check Supabase Auth configuration
3. Check Discord OAuth redirect URIs match `NEXT_PUBLIC_APP_URL`
4. Clear cookies and retry

### Music Not Working

1. Check Lavalink is running and accessible
2. Check `LAVALINK_HOST`, `LAVALINK_PORT`, `LAVALINK_PASSWORD`
3. Check Lavalink logs for Java errors
4. Shoukaku handles reconnection automatically

### Rate Limiting

1. Bot: discord.js handles Discord API rate limits internally
2. Dashboard: Custom Valkey-backed rate limiter with in-memory fallback
3. If Valkey is down, rate limiting falls back to per-process in-memory
4. License SDK: Separate rate limits per IP and per key

---

*Last updated: 2026-05-23 · V3 Audit Remediation*
