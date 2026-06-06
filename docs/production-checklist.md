# Production Checklist

## Supabase Connection Pooling (Audit §14.6)

Supabase uses PgBouncer for connection pooling at the infrastructure level.

### Settings to Verify

1. **Supabase Dashboard → Project Settings → Database → Connection Pooling**
2. Pool Mode: `Transaction` (default, recommended)
3. Pool size per plan: Free=15, Pro=60
4. Dashboard uses pooled connection (port 6543)
5. Bot uses direct connection (port 5432) for long-lived connections

### Monitoring

```sql
SELECT count(*) FROM pg_stat_activity WHERE state = 'active';
SHOW max_connections;
```

## Valkey / Rate Limiting (Audit §14.5)

- Dashboard health endpoint: `GET /api/health` — always returns HTTP 200 when
  the route responds; read JSON `status` and alert when it is `degraded`.
  `status` is `healthy` only when Valkey is connected and the bot heartbeat is
  online; use `services.valkey` and `services.bot` to diagnose which dependency
  is degraded.
- Bot process health endpoint: `GET /health` — returns HTTP 503 when Discord
  gateway or Valkey connectivity is unhealthy; use this for bot container
  health checks.
- Monitor dashboard degraded status with JSON-aware checks. Do not configure
  Railway/Vercel/dashboard restarts from `/api/health` HTTP 503, because the
  dashboard intentionally does not use 503 for dependency degradation.
