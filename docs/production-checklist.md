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

- Health endpoint: `GET /api/health` — returns `degraded` when Valkey is down
- Monitor with UptimeRobot or Railway health checks
- Alert on HTTP 503 responses
