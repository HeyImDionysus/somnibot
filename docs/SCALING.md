# Scaling SomniBot

> V6 Audit Finding §14.5, §9.4, §9.6 — Operational guidance for scaling beyond a single instance.

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│                   Load Balancer                   │
│              (Caddy / nginx / ALB)                │
│                     ↓                             │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐    │
│  │ Dashboard  │  │ Dashboard  │  │ Dashboard  │   │
│  │ (Next.js)  │  │ (Next.js)  │  │ (Next.js)  │  │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘   │
│        │              │               │           │
│  ┌─────┴──────────────┴───────────────┴─────┐    │
│  │              Supabase (Postgres)           │   │
│  │          + pgbouncer connection pool        │  │
│  └────────────────────┬──────────────────────┘   │
│                       │                           │
│  ┌────────────────────┴──────────────────────┐   │
│  │               Valkey (Redis)               │   │
│  │      Rate limits, sessions, anti-raid      │   │
│  └────────────────────────────────────────────┘   │
│                                                    │
│  ┌─────────────┐     ┌──────────────────────┐    │
│  │ Discord Bot  │     │ Lavalink (1 per bot)  │   │
│  │  (1 per     │────▶│                       │   │
│  │   shard set)│     │  Music audio server    │   │
│  └─────────────┘     └──────────────────────┘    │
└──────────────────────────────────────────────────┘
```

## Dashboard (Horizontal Scaling)

The Next.js dashboard is stateless — scale by adding replicas behind a load balancer.

### Requirements
- All replicas must share the same `NEXTAUTH_SECRET`, `CSRF_SECRET`, and `DOWNLOAD_SIGNING_SECRET`
- Supabase connection pooling is strongly recommended (see below)
- Valkey must be shared (rate limits, anti-raid state, CSRF nonces)

### Docker Compose Example
```yaml
dashboard:
  deploy:
    replicas: 3
  environment:
    - VALKEY_URL=redis://valkey:6379
```

## Database Connection Pooling (pgbouncer)

Supabase provides a built-in pgbouncer endpoint. Use it when:
- Running 2+ dashboard replicas
- Total connections exceed 20 (Supabase free tier limit: 60)

### Setup
1. Go to Supabase Dashboard → Settings → Database
2. Copy the "Connection pooling" URL (port 6543, not 5432)
3. Use it as your `SUPABASE_DB_URL` for migrations:

```env
# Direct connection (for migrations only):
SUPABASE_DB_URL=postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres

# Pooled connection (for application use — recommended):
SUPABASE_DB_URL_POOLED=postgresql://postgres.[ref]:[password]@[region]-pooler.supabase.com:6543/postgres?pgbouncer=true
```

### Configuration
Supabase pgbouncer runs in `transaction` mode by default. This means:
- ✅ Connection reuse between requests
- ✅ Lower connection count
- ⚠️ No prepared statements
- ⚠️ No `SET` commands that rely on session state

The Supabase JS client uses the REST API (not direct Postgres), so pgbouncer is mainly relevant for:
- Direct SQL migrations (`SUPABASE_DB_URL`)
- Custom scripts that connect directly

## Discord Bot Scaling (Sharding)

Discord.js supports automatic sharding. For large bots (2,500+ guilds):

```typescript
// In your entry point:
const manager = new ShardingManager('./dist/bot.js', {
  token: process.env.DISCORD_TOKEN,
  totalShards: 'auto', // Discord recommends 1 shard per ~2,500 guilds
});
```

### Current Status
SomniBot uses a single process — sufficient for <2,500 guilds. Sharding can be added when needed without architectural changes since:
- All state is in Supabase/Valkey (not in-memory)
- Anti-raid uses Valkey sorted sets (shard-safe)
- Heartbeat writes to a single bot-level key

## Valkey (Redis) Scaling

Single Valkey instance is sufficient for most deployments. For HA:
- Valkey Sentinel (automatic failover)
- Valkey Cluster (horizontal sharding)

Current usage is lightweight (~100 keys per guild).

## Health Monitoring

### Endpoints
- `GET /api/health` — Dashboard app health. Always returns HTTP 200 when
  the route responds; read JSON `status: "healthy" | "degraded"` plus
  `services.valkey` and `services.bot` for dependency alerts.
- Bot `GET /health` — Bot process/container health. Returns HTTP 200 only
  when Discord gateway and Valkey are healthy; returns HTTP 503 when either
  dependency is unhealthy.
- Valkey key `somnibot:heartbeat:bot` — Bot liveness (30s interval, 120s TTL)
- Supabase `bot_diagnostics` table — Bot heartbeat fallback (60s interval)

### Recommended Probes (Docker/K8s)
```yaml
# Docker Compose
services:
  dashboard:
    # Route/process liveness only. Do not treat degraded JSON as a
    # platform restart signal; alert on the JSON status separately.
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  bot:
    # Hard process health for Discord + Valkey connectivity.
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3001/health"]
      interval: 30s
      timeout: 5s
      retries: 3

# Kubernetes container probe fragments
containers:
  - name: dashboard
    # Dependency degradation should be handled by JSON-aware monitoring of
    # /api/health, not by this HTTP status probe.
    livenessProbe:
      httpGet:
        path: /api/health
        port: 3000
      initialDelaySeconds: 15
      periodSeconds: 30
    readinessProbe:
      httpGet:
        path: /api/health
        port: 3000
      initialDelaySeconds: 5
      periodSeconds: 10

  - name: bot
    livenessProbe:
      httpGet:
        path: /health
        port: 3001
      initialDelaySeconds: 15
      periodSeconds: 30
    readinessProbe:
      httpGet:
        path: /health
        port: 3001
      initialDelaySeconds: 5
      periodSeconds: 10
```

### Alert Thresholds
| Metric | Warning | Critical |
|--------|---------|----------|
| Dashboard `/api/health` HTTP fetch | non-2xx/error for >60s | non-2xx/error for >5min |
| Dashboard `/api/health` JSON status | `degraded` for >60s | `degraded` for >5min |
| Bot `/health` HTTP response | 503 for >60s | 503 for >5min |
| Bot heartbeat age | >90s | >300s |
| Dashboard response time | >2s p95 | >5s p95 |
| Valkey memory | >80% | >95% |
| Postgres connections | >70% pool | >90% pool |
