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

Use the launcher/setup GUI first for regular-local and VPS setup. It is the
owner-facing control surface for first-run values, public callback readiness,
and VPS deployment planning. The commands below are manual fallback and
operations reference, not the normal handoff path for a non-technical owner.

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

### CI
All required GitHub checks must pass before merging: install, migration lint,
database security audit, typecheck, lint, build, unit tests, integration tests,
security checks, the DB type drift check, and the final CI gate.

#### DB type drift check (required)
The `type-drift` job is a **required, fail-on-drift gate**. It regenerates a
schema snapshot from the SQL migrations and fails the build if the committed
snapshot at `packages/shared/src/types/database.generated.ts` is stale:

```bash
python scripts/generate-db-types.py --check   # CI runs this; non-zero on drift
python scripts/generate-db-types.py           # refresh the snapshot, then commit
```

`database.generated.ts` is a **drift tripwire, not the app's type source**.
Application code imports the hand-maintained `packages/shared/src/types/
database.ts`; the snapshot exists only to force a review whenever a migration
changes the schema. When a migration adds/removes a column or table, regenerate
the snapshot and — if the change touches a table the hand-maintained
`database.ts` models — update `database.ts` in the same PR. CI also runs the
generator's focused parser regressions before checking the committed snapshot.

The generator (`scripts/generate-db-types.py`) is a best-effort SQL parser. It
tracks `CREATE TABLE`, `ALTER TABLE ... ADD/DROP COLUMN`, `ALTER COLUMN ...
SET/DROP NOT NULL` (including schema-qualified names and idempotent `DO $$ ...
$$` guards), `ADD PRIMARY KEY`, and `DROP TABLE`. Known limitations (why the
snapshot is a tripwire, not the source of truth): it does **not** track `ALTER
COLUMN` type changes, `DROP/ADD CONSTRAINT` (so enum unions reflect only the
original `CHECK`), or `CREATE TYPE`/enums. Column ordering follows migration
order, not the curated order in `database.ts`.

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
Migrations are **forward-only**. The bot attempts to apply pending migrations on
startup when a Supabase Management API token or direct database URL is available,
but startup alone is not proof that the database is current. Verify migration
success in bot migration logs, the `schema_migrations` table, or Supabase
migration status before calling a setup smoke complete. `/api/setup`
`databaseInitialized: true` only proves the setup route can query its minimal
startup tables; it is not proof that every migration finished.

To undo a migration:
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
| Action queue depth — commerce lane (`action_queue_depth_commerce`) | >10 pending (critical) |
| Action queue depth — game lane (`action_queue_depth_game`) | >100 pending (warning) |
| Memory usage | >1.5 GB |

Queue-depth alerts are per lane: `bot_action_queue` rows are classified
`commerce` (paid-store fulfillment, receipt/license-key delivery, entitlement
revocation) or `game` (everything else) by a DB trigger, and commerce rows are
always processed ahead of game rows. A commerce backlog means paying customers
are waiting — treat it as an incident. A game backlog does not delay commerce
processing (separate lane and concurrency budget). At most one unresolved
alert exists per guild per lane; alerts auto-resolve when the lane drains.

## Alert Response

### Bot Offline
Check: process running → Discord gateway → Valkey → Supabase → restart

### Automation Failures
Check: `alerts` table → `automation_executions` errors → fix perms/channels

### Credential rotation

For a suspected compromise, rotate the affected credential at its provider,
update the established deployment secret source, and restart only the services
that consume it. Rotate `DISCORD_TOKEN` and `DISCORD_CLIENT_SECRET` in the
Discord portal; Supabase server and publishable keys in Supabase; PayPal app
credentials in PayPal; and application secrets with `node scripts/gen-secret.mjs`.
Rebuild the dashboard whenever a `NEXT_PUBLIC_*` value changes. Verify bot
login, dashboard OAuth, PayPal webhook delivery, and health after rotation;
changing `NEXTAUTH_SECRET` invalidates existing dashboard sessions.

### Action Queue Backup
Check stuck `processing` items → `bot_action_queue_recover_stale()` RPC → check DLQ.
For a **commerce-lane** alert, filter on `lane = 'commerce'` in both
`bot_action_queue` and `action_queue_dlq` — those rows are paid fulfillment
(orders, receipts, revocations) and every DLQ'd receipt delivery also raises
its own operator alert.

### PayPal money-path alerts

These five alert types are raised by the dashboard, not the bot, so they still
fire when the bot is down. All are money-path; treat them as page-worthy.

| `alert_type` | Meaning | First action |
|---|---|---|
| `paypal_reconciliation_mismatch` | PayPal's transaction ledger disagrees with `payments`, `payment_refunds`, or `orders`. Captures/sales and each partial refund sibling are matched by their own provider ID. | Read `metadata.missing_local_payments`, `metadata.missing_provider_payments`, and `metadata.amount_mismatches`. For a payment missing locally, find the capture/sale in PayPal and replay the matching `webhook_events` row. For a refund, use its `paypal_refund_id`; never infer one sibling from another or from the cumulative refunded total. |
| `paypal_reconciliation_failure` | The scheduled monitor could not complete or persist a trustworthy comparison. | Read the durable last-result reason, repair the provider/database/configuration failure, then rerun. Transient route failures return `503` with `Retry-After`. |
| `paypal_webhook_processing_error` | A webhook event landed on `result = 'error'`. | `metadata.requires_manual_replay = true` means PayPal will NOT retry — replay it from Diagnostics → Webhooks. Otherwise wait one redelivery cycle first. |
| `paypal_dispute` | A chargeback or dispute is open. | Respond in the PayPal resolution center before the deadline. Affected orders are already flipped to `status = 'disputed'`; access is intentionally NOT revoked until money actually moves. |
| `paypal_capture_denied` | PayPal refused to settle a capture. | The buyer was not charged. A `pending` order was moved to `cancelled`; nothing else was touched. |

### PayPal reconciliation

**Stated boundary — v1 sale refund siblings.** Refunds of v2 captures are
enumerable through the parent order (`/v2/checkout/orders/{id}` lists every
refund), so a lost middle sibling of a partial series is detected exactly.
The v1 Payments API exposes NO per-sale refund list: for subscription sales
the pass verifies the sale state (`refunded`/`partially_refunded`/`reversed`),
judges full refunds and reversals against the summed local ledger, and
verifies every LOCAL refund row per object via `/v1/payments/refund` — but a
provider-side partial-refund sibling whose webhook was lost, on a sale that
remains `partially_refunded`, is not independently discoverable without the
gated reporting product. This is the one documented gap in per-object
subscription refund coverage.

Runs inside the **dashboard** container (not the bot — that is the point: it
must work when the bot is the broken thing). It self-schedules every 6h,
starting 5 minutes after boot, and verifies the ledger **per object** over a
rolling 7-day window: every `payments.paypal_payment_id` capture, every
`payment_refunds.paypal_refund_id` refund, pending orders and settled orders
with no payment write (by `orders.paypal_order_id`), and subscription billing
(by `orders.paypal_subscription_id`) are each fetched directly from PayPal's
commerce API — the same GETs the webhook handler and refund routes use. It
detects money settled at PayPal with no local row, local rows PayPal cannot
evidence, provider-side refunds that never landed locally, and exact
amount/currency drift. The most recent 15 minutes are excluded so in-flight
webhooks do not produce false findings.

```bash
# Last pass summary (as the signed-in owner, or with the scheduler secret)
curl -fsS -H "X-Reconcile-Secret: $PAYPAL_RECONCILE_SECRET" \
  https://<dashboard>/api/paypal/reconcile

# Force a pass now
curl -fsS -X POST -H "X-Reconcile-Secret: $PAYPAL_RECONCILE_SECRET" \
  https://<dashboard>/api/paypal/reconcile
```

Requirements and knobs:
- A bare PayPal REST app (client id/secret from the setup wizard) is
  sufficient: reconciliation uses only per-object commerce GETs. It does NOT
  use PayPal's separately entitled reporting product (Transaction Search) —
  operators never need to enable extra app features.
- `PAYPAL_RECONCILE_SECRET` is optional and only opens the machine-triggered
  path; unset means only the signed-in owner can trigger a pass by hand.
- `PAYPAL_RECONCILE_DISABLED=1` turns the in-dashboard scheduler off.
- Concurrency is fenced by the singleton `paypal_reconciliation_state` table
  through the `paypal_reconcile_acquire`, `paypal_reconcile_heartbeat`, and
  `paypal_reconcile_finalize` security-definer RPCs. Lease expiry and cooldown
  use the database clock after the state row is locked, and heartbeat/finalize
  mutate only the exact opaque owner token. `service_role` can read state and
  execute the RPCs but cannot directly insert, update, or delete the row.
- A signed-in owner "run now" may bypass only the completed-run cooldown. It
  never bypasses an active owner or the exact-owner lease checks.

## Database

### Backup and restore boundary

Before a production migration or deployment, take a provider-verified database
backup and record its timestamp, the deployed Git SHA, and the
`schema_migrations` ledger. Rehearse restores on staging first. Before customer
writes, restore only the recorded backup when necessary; after customer writes,
disable `store_enabled`, preserve payment evidence, and use an additive
forward-fix instead of overwriting live data.

### Migrations
The bot's migration runner applies files from `packages/supabase/migrations/`
when `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_URL`, or `DATABASE_URL` is available.
It uses SHA-256 checksums and stops on the first migration error. If the runner
itself fails or the credentials are not present, apply migrations manually in
Supabase and treat setup as incomplete until migration logs, `schema_migrations`,
or Supabase migration status confirm the schema is current.

### Data Retention (every 6h cron)

Each guild has a configurable `data_retention_days` setting in `guild_config`
(default: 180 days, minimum: 30). Guild owners can change this from
**Settings → Data Retention** on the dashboard. The new period starts from
the moment the setting is saved — no retroactive recovery.

Defaults if the guild hasn't configured a custom value:
- Audit logs: uses guild's `data_retention_days` (default 180)
- Economy transactions: uses guild's `data_retention_days` (default 180)
- License validations: IP/device/app details scrubbed after 60 days; forensic
  outcome/timestamp and anonymized key/product linkage retained permanently
- Portal sessions: on expiry
- Webhook events: 30 days (processed only)

**Manual cleanup** (deletes in batches of 10,000):
```sql
-- Use the guild's configured retention, or override:
SELECT cleanup_old_records('economy_transactions', 180);
SELECT cleanup_old_records('audit_logs', 90);
SELECT scrub_expired_license_validations(60);
SELECT cleanup_old_records('webhook_events', 30);
```

### Pre-production PayPal sandbox pass

Before enabling live payments, run `pnpm paypal:sandbox-pass` with
`PAYPAL_SANDBOX=true`, the exact sandbox API base, and sandbox application
credentials supplied through the deployment secret channel. The pass refuses
the live PayPal hostname. It verifies OAuth, the disputes-list response shape,
`PayPal-Request-Id` idempotency by creating and replaying one unapproved
USD 1.00 sandbox order, and the per-object read rail by fetching that exact
order back — the same GET the webhook handler and reconciliation use.
The order is never approved or captured, so it moves no money and expires at
PayPal.

Do not treat unit mocks as this gate. Save the command's sanitized JSON result
with the release evidence; it never prints credentials or access tokens.

### Licence trust and device-policy trade-offs

Licence validation responses are transported over TLS and authenticated by the
licence key, but the response body is not cryptographically signed. A client
that must defend against a compromised TLS endpoint or locally intercepted
response needs an application-level signature that SomniBot does not currently
provide. This is a deliberate compatibility trade-off, not a claim of
tamper-proof offline licensing.

`evict_oldest` remains the default device policy. It avoids permanently locking
an honest buyer out after a reinstall or machine replacement; excess devices
continually displace one another, and owners can switch a specific product to
`reject` when the evidence supports it. The abuse signal's rolling seven-day
threshold is a reasoned initial operating value covered by regression tests,
not a production-calibrated fraud boundary. Recalibrate it from real owner
outcomes rather than silently treating the current number as universal.

### User Data Deletion

Both privacy RPCs are two-phase and return a JSON object. A successful SQL call
does **not** by itself mean deletion is complete.

```sql
SELECT purge_member_data('guild-id', 'user-id'); -- Member-scoped deletion
SELECT purge_guild_data('guild-id');              -- Whole-guild deletion
```

Interpret `purge_status` in the returned JSON:

- `pending_role_cleanup`: the database committed the access revocation and the
  exact Discord-role cleanup work. Do not report deletion as complete. Let the
  bot finish the referenced commerce queue work and resolve any unretried exact
  cleanup DLQ item, then run the same RPC again.
- `completed`: exact role cleanup has settled and the retained identity and
  protocol tombstones were deleted or anonymized. This is the only completion
  signal.

Never bypass the pending state by deleting or rewriting queue payloads; those
payloads are immutable evidence of which Discord mutations the bot owns.

## Common Issues

| Issue | Fix |
|-------|-----|
| Bot won't start | Check DISCORD_TOKEN, SUPABASE_URL, Node >=18 |
| Dashboard auth fails | Check NEXTAUTH_SECRET, OAuth redirect URIs |
| Music broken | Check Lavalink running + LAVALINK_* env vars |
| Rate limits in-memory | Valkey down — auto-fallback, check connection |

---

*Last updated: 2026-06-07*
