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

### CI (8 jobs — all must pass)
install → typecheck → lint → build → test → integration-test → migration-lint → security

## Rollback

### Railway (Bot)
1. Open Railway dashboard → SomniBot service → **Deployments** tab
2. Click the three-dot menu on the last known-good deployment → **Rollback**
3. Railway will redeploy that exact image instantly
4. Verify health: `curl http://localhost:3001/health` (or check Railway logs for `HealthServer: listening`)

### Vercel (Dashboard)
1. Open Vercel dashboard → somnibot → **Deployments** tab
2. Find the last green deployment → click three-dot menu → **Promote to Production**
3. Vercel routes traffic to that build within seconds
4. Verify: visit `https://<domain>/api/diagnostics` — should return `{ status: 'ok' }`

### Database Migrations
Migrations are **forward-only**. To undo a migration:
1. Create a NEW migration that reverses the changes (e.g., `DROP INDEX`, `ALTER TABLE DROP COLUMN`)
2. Name it with the next timestamp: `20260609000000_revert_<name>.sql`
3. Test locally: `supabase db reset` (or `supabase migration up` on a staging project)
4. Push via normal PR flow — CI migration-lint will validate

**Never** run `DROP TABLE` or `TRUNCATE` in a rollback migration without explicit team approval.

### Git (Code)
```bash
git log --oneline -10          # Find last good commit
git checkout <hash>
pnpm install --frozen-lockfile && pnpm build
# Restart process
```

### Valkey
If Valkey state is corrupted, flush the specific guild or feature namespace:
```bash
valkey-cli -a $VALKEY_PASSWORD KEYS "antiraid:*" | xargs valkey-cli DEL
valkey-cli -a $VALKEY_PASSWORD KEYS "ratelimit:*" | xargs valkey-cli DEL
```
Anti-raid and rate limiting will rebuild state on next event. Economy cooldowns reset (safe — users just lose active cooldowns).

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

Each guild has a configurable `data_retention_days` setting in `guild_config`
(default: 180 days, minimum: 30). Guild owners can change this from
**Settings → Data Retention** on the dashboard. The new period starts from
the moment the setting is saved — no retroactive recovery.

Defaults if the guild hasn't configured a custom value:
- Audit logs: uses guild's `data_retention_days` (default 180)
- Economy transactions: uses guild's `data_retention_days` (default 180)
- License validations: 90 days
- Portal sessions: on expiry
- Webhook events: 30 days (processed only)

**Manual cleanup** (deletes in batches of 10,000):
```sql
-- Use the guild's configured retention, or override:
SELECT cleanup_old_records('economy_transactions', 180);
SELECT cleanup_old_records('audit_logs', 90);
SELECT cleanup_old_records('license_validations', 90);
SELECT cleanup_old_records('webhook_events', 30);
```

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

*Last updated: 2026-05-24 · V5 Full Repository Audit*
