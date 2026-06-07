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

### Regular Local

```bash
git pull origin main
pnpm install --frozen-lockfile
pnpm build
./scripts/start.sh
```

This starts Docker-backed Lavalink and Valkey, then starts the built bot and
dashboard on the same machine. Keep `HEALTH_PORT=3001` in `.env` so the bot
health server stays separate from the dashboard's `PORT=3000`. Use
`./scripts/stop.sh` to stop the stack.

### VPS

```bash
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build
```

The VPS stack keeps the dashboard, bot, Lavalink, and Valkey together on the VPS
or private network. Caddy serves the public HTTPS dashboard domain.

### CI (8 jobs — all must pass)
install → typecheck → lint → build → test → integration-test → migration-lint → security

## Rollback

Rollback is a code/runtime operation for the supported regular-local and VPS
stacks. Preserve `.env` and host secrets. Do not rotate credentials, change DNS,
or alter provider callback settings as part of a code rollback unless the
incident specifically requires it and that change has separate approval.

### Regular Local

1. Stop the stack:
   ```bash
   ./scripts/stop.sh
   ```
2. Choose the last known-good commit:
   ```bash
   git fetch origin
   git log --oneline -10 origin/main
   ```
3. Check out and rebuild that commit:
   ```bash
   git checkout <last-good-commit>
   pnpm install --frozen-lockfile
   pnpm build
   ```
4. Confirm `.env` still sets `HEALTH_PORT=3001`, then start the stack again:
   ```bash
   ./scripts/start.sh
   ```
5. Verify:
   ```bash
   curl -fsS http://localhost:3000/api/health
   curl -fsS http://localhost:3001/health
   ```
6. If a public callback tunnel is configured, also verify
   `<public-callback-base>/api/health` from outside the machine.

### VPS

1. SSH to the VPS and enter the SomniBot checkout.
2. Choose the last known-good commit:
   ```bash
   git fetch origin
   git log --oneline -10 origin/main
   ```
3. Check out the known-good commit and rebuild containers:
   ```bash
   git checkout <last-good-commit>
   docker compose -f docker-compose.prod.yml up -d --build
   ```
4. Verify:
   ```bash
   docker compose -f docker-compose.prod.yml ps
   curl -fsS https://your-domain.example/api/health
   ```
5. Check logs if health is not green:
   ```bash
   docker compose -f docker-compose.prod.yml logs --tail=100 dashboard bot caddy
   ```
6. Treat HTTP fetch failure as a dashboard rollback failure. Treat
   `status: "degraded"` as a dependency alert, not a failed dashboard process
   rollback by itself.

### Optional Compatibility Hosts

SomniBot's default launch path is regular local or VPS. If an operator has
intentionally created a separate compatibility deployment on another host, use
that host's rollback controls only after confirming the environment variables,
public callback base, and PayPal/Supabase callback settings still match the
current SomniBot deployment guide.

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
- **Public health:** `GET /api/health` — dashboard route liveness plus Valkey/bot dependency status (`healthy` or `degraded`)
- **Operator diagnostics:** `GET /api/diagnostics` — authenticated guild-owner diagnostics for uptime, memory, Lavalink, Valkey, guild count, queues, webhooks, and sync state

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

*Last updated: 2026-06-07*
