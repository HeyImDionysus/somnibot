# SomniBot - Deployment Guide

> Production setup guide for running SomniBot as one system: Discord bot,
> dashboard, Lavalink, and Valkey/Redis together on a regular local machine or
> on a VPS/private network. Vercel is not required for launch.

---

## Supported Operating Modes

| Mode | Use it for | Dashboard local URL | Public callback base | Valkey/Redis |
|---|---|---|---|---|
| Regular local | Running SomniBot on a normal user machine | Launcher-provided URL, commonly `http://localhost:3456`; script fallback uses `http://localhost:3000` | Launcher-guided stable HTTPS tunnel to the dashboard port, preferably Tailscale Funnel | `redis://127.0.0.1:6379` |
| WSL2 parity | Rehearsing Linux/VPS behavior before paying for or touching a VPS | WSL2-local URL | Optional tunnel for testing only | WSL2/Docker-local |
| VPS | Always-on hosted Linux deployment | Private host/Docker URL | VPS domain, e.g. `https://somnibot.example.com` | Private Docker/service URL |

WSL2 is a VPS-like test bed. It is not the same thing as the regular-local user
experience.

---

## Shared Prerequisites

- Discord bot application (Developer Portal)
- Supabase project
- Node.js 22+, pnpm 9+
- Docker for Lavalink and Valkey
- For production callbacks: one stable public HTTPS dashboard URL

Use the Electron launcher/setup GUI as the primary owner flow for regular-local
and VPS setup. It records non-secret runtime values, guides Tailscale/public
callback readiness, and exposes VPS preflight, dry-run, and approval-gated
deployment actions with redacted output. The CLI/script steps in this guide are
manual fallback paths and operator reference.

## Platform Defaults

SomniBot's default launch targets are regular local and VPS. The root
`vercel.json` is intentionally limited to disabling Vercel Git deployments; it
does not define a dashboard build, install command, output directory, or launch
target. The repository does not keep Railway config files because Railway is not
the default operating model. If an operator intentionally maintains a
compatibility deployment on either host, it must still follow the same
environment, Valkey/Redis, public callback, PayPal webhook, and Supabase redirect
rules in this guide.

LumaDock is not a separate supported runtime path in the current repository.
The code paths available today are the launcher-guided regular-local/VPS setup,
the regular-local scripts, and the VPS Docker Compose stack. If a future
LumaDock package wraps SomniBot, it should run one of those same stacks and set
the same environment values; do not invent different callback, Valkey, Lavalink,
or PayPal rules for it.

---

## 1. Discord Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications).
2. Create an application and note the **Application ID** and **Client Secret**.
3. Go to the **Bot** tab, create the bot, and note the **Bot Token**.
4. Enable these **Privileged Gateway Intents**: `GUILD_MEMBERS`, `MESSAGE_CONTENT`, `GUILD_PRESENCES`.
5. OAuth2 -> add the Supabase Auth provider callback URL:
   `https://<project-ref>.supabase.co/auth/v1/callback`.
6. Leave **Interactions Endpoint URL** empty unless the bot is intentionally
   changed from gateway mode to webhook-style interactions.

Discord does not use the Tailscale/VPS dashboard URL for OAuth in the current
architecture. Dashboard login goes through Supabase's Discord provider, so
Discord needs Supabase's `/auth/v1/callback` URL. Supabase then needs the
dashboard callback allow-list in the next section.

## 2. Supabase Setup

1. Create a project at [supabase.com](https://supabase.com).
2. Go to **Settings -> API** and note:
   - `SUPABASE_URL` (Project URL)
   - `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` (keep secret)
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (publishable key)
3. For automatic `/setup` Discord auth configuration, go to **Account -> Access Tokens** and create a personal access token for `SUPABASE_ACCESS_TOKEN`. If you do not set it, complete steps 5 and 6 manually, then set `SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED=true` before finalizing setup.
4. Run migrations:
   ```bash
   cd packages/supabase
   supabase db push
   ```
5. Go to **Authentication -> Providers -> Discord** and enable it with the Discord Client ID and Secret.
6. Go to **Authentication -> URL Configuration** and allow the dashboard callback URL for your mode:
   - Regular local first run: `<local-operator-dashboard-url>/api/auth/callback`
   - Regular local script fallback: `http://localhost:3000/api/auth/callback`
   - Regular local production callback: `<public-callback-base>/api/auth/callback`
   - VPS: `https://your-domain.example/api/auth/callback`

If `/api/setup` still says Discord auth is not configured after you enabled the
provider manually, check two things before changing credentials: the
`SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED=true` runtime flag is present, and
the Supabase allow-list includes the exact local and public callback URLs
SomniBot is using.

## 3. Regular Local Setup

Regular local keeps the bot, dashboard, Lavalink, and Valkey on the user's own
machine.

### Local Services

| Component | Configuration |
|---|---|
| Bot | Started by the launcher, or by `./scripts/start.sh` / `scripts\start.bat` as manual fallback |
| Dashboard | Launcher-owned local dashboard, commonly at `http://localhost:3456`; standalone production server at `http://localhost:3000` when using script fallback |
| Lavalink | Docker service on `localhost:2333` |
| Valkey/Redis | Docker service on `redis://127.0.0.1:6379` |
| Secrets | `.env` on the local machine, including Discord, Supabase, dashboard, replay, Lavalink, and optional PayPal values |

Normal path: open the SomniBot Launcher setup GUI, choose regular-local mode,
let it validate the required values, and start the local bot and dashboard.

Manual fallback: start the production regular-local stack with:

```bash
./scripts/start.sh
```

On Windows, use:

```bat
scripts\start.bat
```

Those scripts run the built bot and the dashboard standalone production server.
Use `./scripts/start-dashboard.sh` only for dashboard development. Rebuild after
changing `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, or
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` because those values are part of the
dashboard build output.

### Public Callback Strategy

For external provider callbacks, expose the local dashboard with one stable
HTTPS URL. The launcher is the normal path: it checks Tailscale readiness,
keeps the operator dashboard local, and records the stable public callback base
that providers should call.

Manual fallback:

```bash
tailscale funnel <dashboard-port>
```

Use the printed HTTPS URL as `<public-callback-base>`. Cloudflare Tunnel, ngrok
static domains, or a custom reverse proxy can also work if the URL is stable and
forwards to the dashboard. The launcher-owned dashboard commonly uses port
`3456`; the script fallback uses port `3000`.

### Regular Local Environment

```env
DASHBOARD_URL=<local-operator-dashboard-url>
SOMNIBOT_PUBLIC_CALLBACK_BASE_URL=<public-callback-base>
NEXT_PUBLIC_APP_URL=<public-callback-base>
HEALTH_PORT=3001
CSRF_SECRET=<node scripts/gen-secret.mjs>
NEXTAUTH_SECRET=<node scripts/gen-secret.mjs>
WEBHOOK_REPLAY_SECRET=<node scripts/gen-secret.mjs>
VALKEY_URL=redis://127.0.0.1:6379
LAVALINK_HOST=localhost
LAVALINK_PORT=2333
LAVALINK_PASSWORD=<node scripts/gen-secret.mjs 16>
PAYPAL_WEBHOOK_URL=<public-callback-base>/api/paypal/webhook
```

The launcher setup flow writes the local operator URL to `DASHBOARD_URL` and the
stable public HTTPS URL to both `SOMNIBOT_PUBLIC_CALLBACK_BASE_URL` and
`NEXT_PUBLIC_APP_URL`. If you use the script fallback for a private first run,
temporarily use `http://localhost:3000` for both public URL variables, then
switch them to the stable HTTPS callback base before configuring PayPal webhooks
or production OAuth redirects.

Keep `<local-operator-dashboard-url>/api/auth/callback`,
`http://localhost:3000/api/auth/callback` for script fallback, and
`<public-callback-base>/api/auth/callback` in the Supabase redirect allow-list
when operators log in through the local browser URL while external providers use
the public callback base.

## 4. VPS Setup

VPS mode keeps SomniBot always-on behind a real domain. The dashboard, bot,
Lavalink, and Valkey should share the VPS or a private network. Do not expose
Valkey or Lavalink publicly.

Normal path: use the launcher/setup GUI, choose VPS mode, enter the public
domain and non-secret SSH target details, review the redacted deployment plan,
then run read-only preflight, dry-run deployment, or approval-gated deployment
from the deployment plan. Do not run the live deploy action without explicit
operator approval.

### VPS Services

| Component | Configuration |
|---|---|
| Bot | Docker Compose service or process manager |
| Dashboard | Docker Compose service behind Caddy/reverse proxy |
| Public HTTPS | Caddy using `DOMAIN` |
| Lavalink | Private service `lavalink:2333` |
| Valkey/Redis | Private service `valkey:6379` with a password |
| Secrets | `.env` on the VPS or host-managed secret store, never public logs or docs |

### VPS Environment

```env
DOMAIN=somnibot.example.com
DASHBOARD_URL=https://somnibot.example.com
NEXT_PUBLIC_APP_URL=https://somnibot.example.com
SOMNIBOT_PUBLIC_CALLBACK_BASE_URL=https://somnibot.example.com
NODE_ENV=production
HEALTH_PORT=3001

CSRF_SECRET=<node scripts/gen-secret.mjs>
NEXTAUTH_SECRET=<node scripts/gen-secret.mjs>
WEBHOOK_REPLAY_SECRET=<node scripts/gen-secret.mjs>

VALKEY_PASSWORD=<node scripts/gen-secret.mjs 16>
VALKEY_URL=redis://:<same-valkey-password>@valkey:6379

LAVALINK_HOST=lavalink
LAVALINK_PORT=2333
LAVALINK_PASSWORD=<node scripts/gen-secret.mjs 16>

PAYPAL_WEBHOOK_URL=https://somnibot.example.com/api/paypal/webhook

# Reverse-proxy hops in front of the dashboard. 1 = Caddy only (the stack in
# docker-compose.prod.yml). The shipped Caddy emits one canonical address, so
# production Compose pins the container to 1 even when an approved CDN is
# placed in front of Caddy. Keep the generic environment default fail-closed.
SOMNIBOT_TRUSTED_PROXY_HOPS=0

# Exact source networks allowed to supply X-Forwarded-For to Caddy. Keep this
# non-routable sentinel for direct client -> Caddy deployments. For a CDN, use
# only that provider's current published egress CIDRs (space-separated).
CADDY_TRUSTED_PROXY_CIDRS=192.0.2.0/24
```

### Client IP and rate limiting

Per-IP rate limits on the public licence endpoints (`/api/license/validate`,
`/api/license/heartbeat`, `/api/license/deactivate`) key off the client address
derived from `X-Forwarded-For`. The production Caddy config does not pass an
inbound header through. It accepts proxy information only from
`CADDY_TRUSTED_PROXY_CIDRS`, resolves the client from right to left, then
overwrites the upstream header with one canonical IPv4 or IPv6 address.

**Upgrade note:** older CDN guidance used
`SOMNIBOT_TRUSTED_PROXY_HOPS=2`. Change or remove that stale value before using
the dashboard outside production Compose. Production Compose now pins the
dashboard container to `1`, matching Caddy's canonical one-entry contract, so
an old `.env` value cannot collapse all callers into the shared `unknown`
bucket.

| Setup | Value |
|---|---|
| VPS: client → Caddy → dashboard | `SOMNIBOT_TRUSTED_PROXY_HOPS=1`; leave the CIDR sentinel |
| VPS: approved CDN → Caddy → dashboard | Hops stays `1`; replace the sentinel with the CDN's exact current egress CIDRs |
| Different proxy/tunnel that emits one validated canonical address | `1` |
| Different append-only proxy stack | Its exact trustworthy chain depth |
| No trustworthy proxy header | `0` (all callers share `unknown`) |

Do not configure `CADDY_TRUSTED_PROXY_CIDRS` as `0.0.0.0/0`, `::/0`, or a
convenient broad private range. That turns a client-controlled forwarding header
into trusted input. If Caddy does not recognize the connecting CDN as trusted,
it uses the CDN peer address instead: rate limiting becomes coarser, but the
client cannot choose a fresh bucket.

For non-Caddy deployments, a hop count below the real append-only depth selects
an inner/shared proxy and collapses clients together. A value above the real
depth can reach a client-supplied prefix when the chain is long enough. The
dashboard therefore rejects invalid configuration, short chains, and malformed
addresses to the shared `unknown` bucket and emits one `[client-ip]` warning per
reason. A 429 remains non-terminal in the SDK, but repeated warnings still mean
the proxy boundary must be corrected.

Manual fallback: start the production stack on the VPS:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

## 5. PayPal Webhooks

PayPal webhook URL is always:

```text
<public-callback-base>/api/paypal/webhook
```

Use sandbox credentials first. In the launcher, paste the PayPal app Client ID
and Client Secret, then click **Create/Update Webhook** after the public callback
base is ready. The launcher creates or updates the PayPal webhook and stores the
returned Webhook ID. Manual fallback: create the webhook in the PayPal Developer
Dashboard and copy the webhook ID into `PAYPAL_WEBHOOK_ID` so SomniBot can verify
incoming webhook signatures.

## 6. Smoke Checklist

Run the applicable checklist before calling an environment ready.

### Regular Local

- [ ] Launcher setup GUI reaches regular-local Tailscale-ready state and shows the local operator dashboard URL.
- [ ] `./scripts/start.sh` or `scripts\start.bat` starts Docker, the built bot, and the standalone dashboard production server.
- [ ] `GET http://localhost:3000/api/health` responds.
- [ ] Dashboard setup wizard completes.
- [ ] Dashboard login/OAuth callback succeeds through the configured callback URL.
- [ ] PayPal sandbox webhook reaches `/api/paypal/webhook`.
- [ ] Store/order flow creates the expected sandbox order or subscription.
- [ ] Bot is online in Discord and heartbeat appears in dashboard health.
- [ ] Lavalink is reachable and music playback works.
- [ ] Valkey-backed queue/cache behavior survives a bot restart.

### VPS

- [ ] Launcher setup GUI reaches domain-ready state, shows a redacted deployment plan, and keeps live deployment approval-gated.
- [ ] `GET https://your-domain.example/api/health` responds.
- [ ] Caddy/reverse proxy serves valid HTTPS for the dashboard domain.
- [ ] Dashboard setup wizard completes.
- [ ] Dashboard login/OAuth callback succeeds through the VPS domain.
- [ ] PayPal sandbox webhook reaches `/api/paypal/webhook`.
- [ ] Store/order flow creates the expected sandbox order or subscription.
- [ ] Bot is online in Discord and heartbeat appears in dashboard health.
- [ ] Lavalink is reachable from the bot only on the private network.
- [ ] Valkey is reachable from bot/dashboard only on the private network.

## 7. Monitoring

- **Dashboard health**: `GET /api/health` returns JSON. Alert on JSON
  `status: "degraded"` even though the route intentionally returns HTTP 200
  when it can respond.
- **Bot health**: `GET /health` returns HTTP 503 when Discord gateway or Valkey
  connectivity is unhealthy.
- **Alerts**: `alerts` table in Supabase tracks config sync failures,
  automation errors, stale queues, and operational issues.
- **DLQ**: Dashboard dead-letter queue for failed actions with retry/purge.
- **Audit log**: `audit_log` table tracks admin actions and bot errors.

## 8. Updating

```bash
git pull origin main
pnpm install --frozen-lockfile
pnpm build
# Restart bot/dashboard services
# Verify migrations through bot startup logs or run the migration command for your environment
```

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Bot not responding | Check `DISCORD_TOKEN`, privileged intents, and bot invite scopes |
| Dashboard login loops | Verify Supabase Discord provider config and redirect allow-list |
| PayPal webhooks fail | Verify `PAYPAL_WEBHOOK_URL`, `PAYPAL_WEBHOOK_ID`, and sandbox/live mode |
| Music not playing | Ensure Lavalink is running and `LAVALINK_*` vars match the mode |
| Valkey connection fails | Check `VALKEY_URL`; on VPS include the password and private service hostname |
| Migration fails | Check `SUPABASE_ACCESS_TOKEN`/`SUPABASE_DB_URL`, or apply migrations manually |
