# SomniBot Operational Runbook

> Production operations guide for SomniBot (bot + dashboard).

## Architecture

```
Discord Gateway → Bot (Node.js + Valkey) → Supabase (Postgres)
                       ↕
                   Lavalink (Music)

Browser → Dashboard (Next.js 15) → Supabase (Postgres)
```

**Packages:** bot, dashboard, shared, launcher, license-sdk, supabase (migrations)
**External:** Supabase, Valkey/Redis, Lavalink, PayPal, Discord API

## Deployment

### Bot
```bash
git pull origin main && pnpm install --frozen-lockfile && pnpm build
cd packages/bot && node dist/index.js  # Migrations auto-run on start
```

### Dashboard
```bash
cd packages/dashboard && pnpm build
node .next/standalone/packages/dashboard/server.js
```

### CI (7 jobs — all must pass)
install → typecheck → lint → build → test → migration-lint → security

## Rollback

```bash
git log --oneline -10          # Find last good commit
git checkout <hash>
pnpm install --frozen-lockfile && pnpm build
# Restart process
```

Migrations are forward-only. To undo, create a NEW reverse migration.

## Monitoring

- **Heartbeat:** Valkey (30s, 2-min TTL) + Supabase fallback (60s)
- **Dashboard:** Green (<90s) · Yellow (>90s) · Red (>5min = offline)
- **Health:** `GET /api/diagnostics` — uptime, memory, Lavalink, Valkey, guild count

### Alert Thresholds

| Metric | Threshold |
|--------|-----------|
| Heartbeat stale | >5 min |
| Automation consecutive failures | 3 |
| Action queue depth | >100 pending |
| Memory usage | >1.5 GB |

## Alert Response

### Bot Offline
Check: process running → Discord gateway → Valkey → Supabase → restart

### Automation Failures
Check: `alerts` table → `automation_executions` errors → fix perms/channels

### Action Queue Backup
Check stuck `processing` items → `bot_action_queue_recover_stale()` RPC → check DLQ

## Database

### Migrations
Auto-run on bot start via `migration-runner.ts`. SHA-256 checksums. Stops on first error.

### Data Retention (every 6h cron)
- Audit logs: 90 days
- Portal sessions: on expiry
- Webhook events: 30 days (processed only)

### User Data Deletion
```sql
SELECT purge_member_data('guild-id', 'user-id');  -- Covers 20+ tables
```

## Common Issues

| Issue | Fix |
|-------|-----|
| Bot won't start | Check DISCORD_TOKEN, SUPABASE_URL, Node >=18 |
| Dashboard auth fails | Check NEXTAUTH_SECRET, OAuth redirect URIs |
| Music broken | Check Lavalink running + LAVALINK_* env vars |
| Rate limits in-memory | Valkey down — auto-fallback, check connection |

---

*Last updated: 2026-05-23 · V3 Audit Remediation*
