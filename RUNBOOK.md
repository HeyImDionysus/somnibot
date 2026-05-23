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

**External services:** Supabase, Valkey/Redis, Lavalink, PayPal, Discord API

---

## Deployment

### Prerequisites

```bash
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXTAUTH_SECRET=
```

### Bot

```bash
git pull origin main
pnpm install --frozen-lockfile
pnpm build
cd packages/bot && node dist/index.js
# Migrations auto-run on startup
```

### Dashboard

```bash
cd packages/dashboard
pnpm build
node .next/standalone/packages/dashboard/server.js
```

### CI Pipeline (7 jobs)

1. install — `pnpm install --frozen-lockfile`
2. typecheck — `tsc --noEmit` on bot, dashboard, license-sdk
3. lint — ESLint
4. build — Production build
5. test — Vitest
6. migration-lint — Naming, ordering, dangerous ops
7. security — `pnpm audit --audit-level=high` + secret scanning

---

## Rollback

```bash
git log --oneline -10              # Find last good commit
git checkout <commit-hash>
pnpm install --frozen-lockfile && pnpm build
# Restart process
```

Migrations are forward-only. To undo, create a NEW reverse migration.

---

## Monitoring

### Heartbeat
- Valkey: 30s interval, 2-min TTL
- Supabase fallback: 60s interval
- Dashboard: green (<90s), yellow (>90s), red (>5min)

### Health: `GET /api/diagnostics`

### Key Metrics

| Metric | Alert Threshold |
|--------|----------------|
| Heartbeat staleness | >5 min |
| Automation consecutive failures | 3 |
| Action queue depth | >100 pending |
| Memory usage | >1.5GB |

---

## Alert Response

### Bot Offline
1. Check process running → 2. Discord gateway → 3. Valkey → 4. Supabase → 5. Restart

### Automation Failures
1. `alerts` table → 2. `automation_executions` errors → 3. Fix permissions/channels

### Action Queue Backup
1. Check stuck `processing` items → 2. `bot_action_queue_recover_stale()` RPC → 3. Check DLQ

---

## Database Operations

### Migrations
Auto-run on bot start. SHA-256 checksums prevent tampering. Stops on first error.

### Data Retention (auto, every 6h)
- Audit logs: 90 days
- Portal sessions: on expiry
- Webhook events: 30 days

### User Data Deletion
```sql
SELECT purge_member_data('guild-id', 'user-id');
-- Covers 20+ tables, anonymizes audit/ticket records
```

---

## Common Issues

| Issue | Fix |
|-------|-----|
| Bot won't start | Check DISCORD_TOKEN, SUPABASE_URL, Node >=18 |
| Dashboard auth fails | Check NEXTAUTH_SECRET, OAuth redirect URIs |
| Music broken | Check Lavalink running, LAVALINK_* env vars |
| Rate limiting in-memory | Valkey down — check connection, falls back automatically |

---

*Last updated: 2026-05-23 · V3 Audit Remediation*
