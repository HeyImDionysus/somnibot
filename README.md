# SomniBot

A full-featured Discord bot with a web dashboard. Moderation, levels, music, tickets, giveaways, commerce, and more — all configurable from a clean dashboard UI.

## Features

### Community & Engagement
- **Levels & XP** — Message + voice XP, rank cards, level rewards, leaderboards
- **Welcome & Goodbye** — Custom welcome cards, DMs, auto-roles, Discord onboarding integration
- **Profiles** — User profile cards with customizable titles and bios
- **Reaction Roles** — Configurable reaction-to-role mappings
- **Giveaways** — Timed giveaways with requirements and commerce integration
- **Starboard** — Highlight popular messages when they receive enough reactions
- **Polls & Predictions** — Free polls and currency-based prediction markets
- **Scheduled Messages** — Recurring messages with cron scheduling
- **Temp Channels** — Hub-based temporary voice channels
- **Stats Channels** — Live server stats displayed as voice channel names

### Virtual Economy
- **Economy Core** — Wallet, bank, daily/weekly rewards, role income, streaks
- **Shop & Market** — Server shop + player-to-player marketplace with fees
- **Games** — Blackjack, coinflip, slots, roulette with configurable house edges and loss limits
- **Heist** — Multiplayer cooperative heists with join windows and cooldowns
- **Lottery** — Jackpot drawings with atomic ticket purchase and claim
- **Gathering** — /hunt, /dig, /mine with loot tables and tool durability
- **Fishing** — Fish species, bait system, catch tracking
- **Crafting** — Recipe-based item crafting from gathered materials
- **Farming** — Plant, water, and harvest crops on farm plots
- **Adventures** — Multi-scene story adventures with choices and rewards
- **Pets** — Pet collection, feeding, XP, prestige system
- **Quests** — Daily/weekly quest assignment and reward claiming
- **Achievements** — Milestone badges and prestige multipliers
- **Trivia** — Trivia rounds with difficulty scaling and streak bonuses

### Moderation & Security
- **Auto-Mod** — Word, link, invite, spam, and caps filters with configurable actions
- **Infractions** — Warning/infraction system with escalation chains
- **Anti-Raid** — Sliding-window join flood detection with auto-lockdown
- **Tickets** — Panel-based ticket system with transcripts and commerce integration
- **Message Log** — Logs message edits and deletes to a designated channel

### Music
- **Music Player** — Lavalink-powered with queue, filters, DJ permissions, and rich embeds
- **Persistent Queue** — Valkey-backed queue state survives restarts; vote-skip, loop modes, shuffle

### Commerce & Licensing
- **Product Store** — Products, plans, and digital goods configurable from the dashboard
- **PayPal Integration** — Checkout, subscriptions, webhook handling, refund/chargeback processing
- **License Keys** — Cryptographic key generation, multi-device tracking, heartbeat sessions
- **Customer Portal** — Customer-facing portal for downloads, orders, and license management
- **Fraud Detection** — Velocity checks, device abuse, IP mismatch, payment pattern analysis

### Administration
- **Dashboard RBAC** — 5 system roles (owner/admin/moderator/support/finance) with granular permissions
- **Team Management** — Invite team members and assign dashboard roles
- **Automations** — Event-driven trigger → condition → action workflows
- **Custom Commands** — Create custom slash commands from the dashboard
- **Server Sync** — Desired-state configuration with drift detection
- **Audit Log** — Full audit trail of all bot and dashboard actions
- **Diagnostics** — Real-time system health monitoring
- **Incident Management** — Track and manage operational incidents

### Infrastructure
- **Electron Launcher** — Primary setup/control surface for regular-local and VPS operation with auto-update
- **License SDK** — `@somnibot/license-sdk` for third-party app integration

---

## Quick Start (Regular Local)

Regular local means SomniBot runs on your own normal computer: the Discord bot,
dashboard, Lavalink, and Valkey all stay together on that machine. WSL2 is useful
for testing Linux/VPS behavior, but it is not the same thing as regular local.

### What You Need

Before starting, make sure you have these installed on your computer:

| Tool | Why | How to get it |
|---|---|---|
| **Node.js 22+** | Runs the bot and dashboard | [nodejs.org](https://nodejs.org) — download the LTS version |
| **pnpm** | Installs packages | After installing Node, open a terminal and run: `corepack enable && corepack prepare pnpm@9 --activate` |
| **Docker Desktop** | Runs Lavalink (music) and Valkey (cache) | [docker.com/get-started](https://docker.com/get-started) — install and make sure the whale icon appears in your menu bar |
| **Git** | Clones the code | [git-scm.com](https://git-scm.com) (you probably already have this) |

SomniBot uses pnpm only for workspace installs, scripts, and CI. Keep
`pnpm-lock.yaml` as the only committed package-manager lockfile; do not commit
`package-lock.json`, `yarn.lock`, or Bun lockfiles.

The Electron launcher/setup GUI is the primary owner setup surface for both
regular-local and VPS operation. It owns first-run runtime mode selection,
non-secret public callback values, Tailscale readiness, VPS deployment planning,
and the local dashboard URL operators use after setup. The scripts below remain
manual fallback and development paths.

### Step 1: Create a Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and log in.
2. Click **New Application** → give it a name (e.g., "SomniBot") → **Create**.
3. On the left sidebar, click **Bot**.
4. Click **Reset Token** → copy the token and save it somewhere safe. You'll need this.
5. Scroll down and enable **all three** Privileged Gateway Intents:
   - ✅ Presence Intent
   - ✅ Server Members Intent
   - ✅ Message Content Intent
6. Click **Save Changes**.
7. On the left sidebar, click **OAuth2**.
8. Copy the **Client ID** (also called Application ID) — save this.
9. Click **Reset Secret** → copy the **Client Secret** — save this.

### Step 2: Create a Supabase Project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) and sign up (free tier works fine).
2. Click **New Project** → give it a name → set a password → pick a region → **Create new project**.
3. Wait for the project to finish setting up (about 1 minute).
4. Go to **Settings** (gear icon in the left sidebar) → **API**.
5. Copy the **Project URL** — save this.
6. Under "Project API keys," copy the **secret** key (starts with `sb_secret_`, click the eye icon to reveal it) — save this.
7. Also copy the **publishable** key (starts with `sb_publishable_`) — save this too (needed for the dashboard).
8. For automatic setup wizard auth configuration, go to **Account → Access Tokens** and create a Supabase personal access token. Save it as `SUPABASE_ACCESS_TOKEN`. If you skip this, configure the Supabase Discord auth provider manually, allow the dashboard callback URL, and set `SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED=true` before finalizing setup.

### Step 3: Clone and Set Up

Open a terminal (Mac: Spotlight → "Terminal" / Windows: search "PowerShell") and run:

```bash
git clone https://github.com/HeyImDionysus/somnibot.git
cd somnibot
```

Then run the setup script:

**Mac / Linux:**
```bash
./scripts/setup.sh
```

**Windows:**
```
scripts\setup.bat
```

This will:
- Check that Node.js, pnpm, and Docker are installed
- Create a `.env` file from the template
- Install all dependencies
- Build all packages

### Step 4: Fill In Your .env File

Open the `.env` file in any text editor (it's in the `somnibot` folder). Fill in the values you saved:

```env
# Core bot credentials — paste your values after the =
DISCORD_TOKEN=paste-your-bot-token-here
DISCORD_APPLICATION_ID=paste-your-client-id-here
DISCORD_CLIENT_SECRET=paste-your-client-secret-here
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...your-secret-key
SUPABASE_ACCESS_TOKEN=sbp_...your-supabase-personal-access-token
# Manual-auth fallback only: set true after manually configuring Supabase Discord auth
SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED=false

# Dashboard URLs:
# DASHBOARD_URL is the local URL the bot can show to operators.
# NEXT_PUBLIC_APP_URL is the callback base. Start local, then switch it to
# a stable HTTPS public callback base for production local or VPS mode.
DASHBOARD_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...your-anon-key

# Generate each secret with: openssl rand -hex 32
CSRF_SECRET=generate-a-secret
NEXTAUTH_SECRET=generate-a-secret
WEBHOOK_REPLAY_SECRET=generate-a-secret

# Local Docker services — generate with: openssl rand -hex 16
LAVALINK_PASSWORD=generate-a-lavalink-password

# Optional commerce callback. Set this when PayPal webhooks are enabled:
# PAYPAL_WEBHOOK_URL=<public-callback-base>/api/paypal/webhook
PAYPAL_WEBHOOK_URL=
```

> **Tip:** `NEXT_PUBLIC_SUPABASE_URL` is the same value as `SUPABASE_URL`. The `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is the **publishable** key from Supabase (starts with `sb_publishable_`).
> Generate `CSRF_SECRET`, `NEXTAUTH_SECRET`, and `WEBHOOK_REPLAY_SECRET` separately with `openssl rand -hex 32`; generate `LAVALINK_PASSWORD` with `openssl rand -hex 16`. Do not reuse your Supabase or Discord secrets. For production local or VPS callbacks, `NEXT_PUBLIC_APP_URL` should be the stable public HTTPS dashboard base.

Save the file.

### Step 5: Invite the Bot to Your Server

1. Go back to [discord.com/developers/applications](https://discord.com/developers/applications) → your app → **OAuth2** → **URL Generator**.
2. Under "Scopes," check: `bot` and `applications.commands`.
3. Under "Bot Permissions," check: `Administrator` (or individually select the permissions you want).
4. Copy the generated URL at the bottom and open it in your browser.
5. Select your Discord server from the dropdown → **Authorize**.

### Step 6: Start With the Launcher

Use the SomniBot Launcher setup GUI for the normal owner path. The launcher
checks your environment, records non-secret setup values, starts the local bot
and dashboard, and keeps regular-local public callbacks tied to the dashboard
port it owns.

Manual fallback:

**Mac / Linux:**
```bash
./scripts/start.sh
```

**Windows:**
```
scripts\start.bat
```

This starts the production regular-local stack: Docker (Lavalink + Valkey), the
built bot, and the dashboard's standalone production server.

You should see:
```
✅ Everything is running!

🤖 Bot:        Running
🌐 Dashboard:  http://localhost:3000
🎵 Lavalink:   http://localhost:2333
📦 Valkey:     redis://localhost:6379
```

**Open [http://localhost:3000](http://localhost:3000)** in your browser to see the dashboard.

If you change `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, or
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, rebuild before starting again because
those values are baked into the production dashboard build.

### Step 7: First-Time Setup

1. In the launcher setup GUI, choose regular-local mode.
2. Follow the setup flow. It verifies Discord and Supabase values, records the
   local dashboard URL, and guides public callback readiness when needed.
3. If you are using the script fallback, go to
   [http://localhost:3000/setup](http://localhost:3000/setup) and complete the
   dashboard setup wizard.
4. Once complete, open the launcher-provided dashboard URL or
   [http://localhost:3000/login](http://localhost:3000/login) for the script
   fallback, then click "Continue with Discord."

### Regular Local Public Callbacks

For everyday local testing, the launcher-provided local dashboard URL is enough.
For production regular-local operation, external providers need one stable
public HTTPS callback base that forwards to the dashboard running on your
machine.

Normal path: use the launcher setup GUI. It checks whether Tailscale is ready,
keeps the regular-local dashboard on its local operator port, and records the
stable Funnel URL for public callbacks without turning secrets into documentation
or logs.

Manual fallback:

```bash
tailscale funnel <dashboard-port>
```

The command prints a public HTTPS URL like
`https://your-machine.your-tailnet.ts.net`. Use that value as your
`<public-callback-base>`. The launcher-owned dashboard commonly uses
`http://localhost:3456`; the script fallback uses `http://localhost:3000`.

Set these values when you turn on public callbacks:

```env
DASHBOARD_URL=<local-operator-dashboard-url>
NEXT_PUBLIC_APP_URL=<public-callback-base>
PAYPAL_WEBHOOK_URL=<public-callback-base>/api/paypal/webhook
```

Provider callback settings:

| Provider | Value |
|---|---|
| Supabase Auth redirect allow-list | `<local-operator-dashboard-url>/api/auth/callback`, `http://localhost:3000/api/auth/callback` for script fallback, and `<public-callback-base>/api/auth/callback` |
| Discord app OAuth2 redirect for Supabase provider | `https://<project-ref>.supabase.co/auth/v1/callback` |
| PayPal webhook URL | `<public-callback-base>/api/paypal/webhook` |

PayPal webhook subscriptions should include:

- `CHECKOUT.ORDER.APPROVED`
- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.REFUNDED`
- `PAYMENT.CAPTURE.REVERSED`
- `BILLING.SUBSCRIPTION.ACTIVATED`
- `BILLING.SUBSCRIPTION.CANCELLED`
- `BILLING.SUBSCRIPTION.EXPIRED`
- `BILLING.SUBSCRIPTION.SUSPENDED`
- `BILLING.SUBSCRIPTION.PAYMENT.FAILED`
- `PAYMENT.SALE.COMPLETED`
- `PAYMENT.SALE.REFUNDED`
- `PAYMENT.SALE.REVERSED`

`BILLING.SUBSCRIPTION.EXPIRED` is handled as a normal managed-product term end:
SomniBot expires only the matching product entitlement, license access, active
license sessions, and product-tied roles. It is not treated as failed payment or
general SomniBot access removal.

Discord needs the Supabase callback above because dashboard login uses Supabase's
Discord OAuth provider. Do not put the Tailscale/VPS dashboard URL in Discord
unless SomniBot is later changed to handle Discord OAuth directly. The Discord
bot itself uses the normal bot gateway, so leave Discord's **Interactions
Endpoint URL** empty unless you intentionally switch to webhook-style
interactions.

Cloudflare Tunnel, ngrok static domains, or a custom reverse proxy can also work,
as long as the URL is stable, HTTPS, and forwards to the dashboard.

---

## Scripts Reference

All scripts are in the `scripts/` folder. On Mac/Linux, prefix with `./` (e.g., `./scripts/start.sh`). On Windows, use backslashes (e.g., `scripts\start.bat`).

| Script | What it does |
|---|---|
| `setup.sh` / `setup.bat` | First-time setup — checks prerequisites, installs deps, builds |
| `start.sh` / `start.bat` | Starts the production regular-local stack: Docker, built bot, and standalone dashboard. Press Ctrl+C to stop |
| `start-bot.sh` | Starts Docker + bot only (no dashboard) |
| `start-dashboard.sh` | Starts the dashboard development server only (on port 3000) |
| `stop.sh` / `stop.bat` | Stops all running services |
| `rebuild.sh` | Pulls latest code, reinstalls deps, and rebuilds |
| `build-launcher.mjs` | Builds the Electron launcher package |
| `generate-db-types.py` | Generates TypeScript types from the Supabase database schema |

### Common Workflows

**Production regular-local use:**
```bash
./scripts/start.sh        # Start everything
# Ctrl+C to stop
```

**After pulling updates from GitHub:**
```bash
./scripts/rebuild.sh      # Pull, reinstall, rebuild
./scripts/start.sh        # Start
```

**Development mode in separate terminals** (each gets its own log output):
```bash
# Terminal 1:
./scripts/start-bot.sh

# Terminal 2:
./scripts/start-dashboard.sh
```

---

## Production Operating Modes

SomniBot supports two real production modes. In both modes, keep the dashboard,
bot, Lavalink, and Valkey together on the same machine or private network.
Vercel is not required for launch.

### Regular Local

Use this when SomniBot runs on your own computer.

| Piece | Regular local value |
|---|---|
| Bot | Started by the launcher, or by `./scripts/start.sh` / `scripts\start.bat` as manual fallback |
| Dashboard | Launcher-owned local dashboard, or standalone production server from the start scripts as manual fallback |
| Dashboard local URL | Launcher-provided local URL, commonly `http://localhost:3456`; script fallback uses `http://localhost:3000` |
| Dashboard public callback URL | Launcher-guided stable HTTPS tunnel to the dashboard port, preferably Tailscale Funnel |
| Lavalink | Docker on `localhost:2333` |
| Valkey/Redis | Docker on `redis://127.0.0.1:6379` |
| PayPal webhook URL | `<public-callback-base>/api/paypal/webhook` |
| Supabase dashboard callback allow-list | `<local-operator-dashboard-url>/api/auth/callback`, `http://localhost:3000/api/auth/callback` for script fallback, and `<public-callback-base>/api/auth/callback` |
| Supabase setup auth | `SUPABASE_ACCESS_TOKEN` for automatic setup, or manual provider setup plus `SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED=true` |

Set `DASHBOARD_URL` to the local operator dashboard URL shown by the launcher
so bot messages point to the owner control surface. Set
`NEXT_PUBLIC_APP_URL=<public-callback-base>` when providers and customer-facing
PayPal return links must use the public HTTPS URL.

### VPS

Use this when SomniBot should run 24/7 on a hosted Linux machine.

The launcher/setup GUI is the primary VPS setup surface. It records the
non-secret domain and SSH target details, builds a redacted deployment plan, and
offers read-only preflight, dry-run deployment, and approval-gated deployment
actions. Manual Docker commands remain a fallback path for operators who choose
to run them directly.

| Piece | VPS value |
|---|---|
| Bot | Docker Compose or a process manager on the VPS |
| Dashboard local/private URL | `http://dashboard:3000` inside Docker, or `http://127.0.0.1:3000` on host |
| Dashboard public callback URL | `https://your-domain.example` through Caddy/reverse proxy |
| Lavalink | Private service `lavalink:2333` |
| Valkey/Redis | Private service `redis://:<password>@valkey:6379` |
| PayPal webhook URL | `https://your-domain.example/api/paypal/webhook` |
| Supabase dashboard callback allow-list | `https://your-domain.example/api/auth/callback` |
| Supabase setup auth | `SUPABASE_ACCESS_TOKEN` for automatic setup, or manual provider setup plus `SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED=true` |

For the supplied production Compose file, set `DOMAIN`, `NEXT_PUBLIC_APP_URL`,
`DASHBOARD_URL`, `VALKEY_PASSWORD`, `VALKEY_URL`, and the required Discord,
Supabase, dashboard, and Lavalink secrets in `.env`, then start the stack with:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### WSL2 Parity

WSL2 is a VPS-like test bed for Linux setup behavior before paying for or
touching a real VPS. Use it to rehearse the VPS commands and Docker networking,
but do not treat it as the regular-local user experience.

### Provider Callback Summary

| Provider | Regular local | VPS |
|---|---|---|
| Discord OAuth2 app callback for Supabase provider | `https://<project-ref>.supabase.co/auth/v1/callback` | Same |
| Supabase Auth redirect allow-list | `<local-operator-dashboard-url>/api/auth/callback`, `http://localhost:3000/api/auth/callback` for script fallback, and `<public-callback-base>/api/auth/callback` | `https://your-domain.example/api/auth/callback` |
| PayPal webhook URL | `<public-callback-base>/api/paypal/webhook` | `https://your-domain.example/api/paypal/webhook` |

Discord is different from PayPal here: PayPal calls the dashboard directly, while
Discord OAuth calls Supabase first. That is why Discord gets the Supabase
`/auth/v1/callback` URL instead of the Tailscale/VPS dashboard URL.

---

## Architecture

```
somnibot/
├── packages/
│   ├── bot/           Discord.js bot (Shoukaku, Supabase, Valkey)
│   ├── dashboard/     Next.js App Router dashboard
│   ├── launcher/      Electron desktop launcher
│   ├── shared/        Shared types, constants, validators
│   ├── supabase/      Database migrations (auto-run on first boot)
│   └── license-sdk/   @somnibot/license-sdk for third-party integrations
├── services/
│   └── lavalink/      Lavalink configuration
├── scripts/           Startup and setup scripts
├── docker-compose.yml Lavalink + Valkey for regular-local Docker services
└── .env.example       Environment variable template
```

| Service | Regular local | VPS / private network | Purpose |
|---|---|---|---|
| Bot | `node packages/bot/dist/index.js` | Docker Compose or process manager | Discord gateway, slash commands, all features |
| Dashboard | Built standalone production server on port 3000 | Docker Compose behind Caddy/reverse proxy | Web UI for configuration and management |
| Lavalink | Docker on port 2333 | Private Docker service `lavalink:2333` | Audio streaming for music player |
| Valkey | Docker on port 6379 | Private Docker service `valkey:6379` | Caching, rate limiting, queue state |
| Supabase | supabase.com | supabase.com | PostgreSQL database, auth, storage |

---

## Environment Variables

### Bot Required
| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `DISCORD_APPLICATION_ID` | Application/Client ID |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase secret key (sb_secret_...) |

### Dashboard Required
| Variable | Description |
|---|---|
| `DASHBOARD_URL` | Local/operator dashboard URL shown by the bot; launcher local commonly uses `http://localhost:3456`, script fallback uses `http://localhost:3000`, and VPS uses the public domain |
| `NEXT_PUBLIC_APP_URL` | Public dashboard/callback base; use the stable HTTPS Funnel URL for regular-local public callbacks, the VPS domain for VPS, or `http://localhost:3000` only for script-fallback private setup before provider callbacks are configured |
| `NEXT_PUBLIC_SUPABASE_URL` | Same as `SUPABASE_URL` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase **anon/public** key |
| `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key |
| `DISCORD_APPLICATION_ID` | Same Application/Client ID |
| `DISCORD_CLIENT_SECRET` | Same OAuth2 client secret |
| `CSRF_SECRET` | Generate with `openssl rand -hex 32` |
| `NEXTAUTH_SECRET` | Generate with `openssl rand -hex 32` |
| `WEBHOOK_REPLAY_SECRET` | Dedicated webhook replay secret; generate with `openssl rand -hex 32` |

### Auto-Configured (defaults work with Docker Compose)
| Variable | Default | Notes |
|---|---|---|
| `DISCORD_GUILD_ID` | Auto-detected | Detected on first bot login |
| `HEALTH_PORT` | `3001` | Bot health endpoint; keep separate from dashboard `PORT=3000` in regular-local mode |
| `LAVALINK_HOST` | `localhost` | Use `lavalink` inside VPS Docker Compose |
| `LAVALINK_PORT` | `2333` | — |
| `LAVALINK_PASSWORD` | Required | Generate with `openssl rand -hex 16`; used by local Docker Compose and the bot |
| `VALKEY_URL` | `redis://127.0.0.1:6379` | Use `redis://:<password>@valkey:6379` on VPS Docker Compose |
| `VALKEY_PASSWORD` | Optional locally; required by `docker-compose.prod.yml` | Generate with `openssl rand -hex 16` |

### Optional
| Variable | Description |
|---|---|
| `DOWNLOAD_SIGNING_SECRET` | Dedicated signed-download secret (recommended; falls back to app secrets) |
| `PAYPAL_CLIENT_ID` | PayPal app client ID (for commerce features) |
| `PAYPAL_CLIENT_SECRET` | PayPal app secret |
| `PAYPAL_SANDBOX` | `true` for sandbox mode, `false` for live (defaults to `true`) |
| `PAYPAL_API_BASE` | PayPal API URL (sandbox: `https://api-m.sandbox.paypal.com`) |
| `PAYPAL_WEBHOOK_ID` | PayPal webhook ID for signature verification |
| `PAYPAL_WEBHOOK_URL` | PayPal webhook endpoint URL: `<public-callback-base>/api/paypal/webhook` |
| `YOUTUBE_OAUTH_REFRESH_TOKEN` | YouTube OAuth token (for music reliability) |
| `SUPABASE_ACCESS_TOKEN` | Supabase Management API token for auto-migration and setup wizard Discord auth auto-configuration |
| `SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED` | Set to `true` only after manually enabling Supabase Discord auth and allowing the dashboard callback URL(s) |
| `SUPABASE_DB_URL` | Direct Postgres connection URL (alternative for auto-migration) |

---

## Troubleshooting

### "Docker is not running"
Make sure Docker Desktop is open. On Mac, look for the whale icon in the menu bar. On Windows, look for it in the system tray. If you just installed it, restart your computer.

### Bot starts but no slash commands appear
Slash commands can take up to an hour to register with Discord the first time. If they don't appear after an hour, kick the bot from your server and re-invite it using the URL from Step 5.

### "Lavalink node error" / Music doesn't work
1. Make sure Docker is running: `docker ps` should show `somni-lavalink`.
2. If Lavalink crashed, restart it: `docker compose restart lavalink`
3. Check Lavalink logs: `docker compose logs lavalink`

### Dashboard shows blank pages
1. Make sure the `.env` file has `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` filled in.
2. Rebuild, then restart the production stack with `./scripts/start.sh`. If you are using the dashboard development server, restart `./scripts/start-dashboard.sh`.

### "Login redirects back to login"
The Supabase Discord auth provider needs to be configured. Run the setup wizard at `/setup`; it can handle this automatically only when `SUPABASE_ACCESS_TOKEN` is set. If you do not use that token, manually enable the Discord provider in Supabase, allow your dashboard callback URL, and set `SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED=true` before finalizing setup.

### PayPal checkout errors
1. Make sure `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are set in `.env`.
2. For testing, use sandbox credentials from [developer.paypal.com](https://developer.paypal.com).
3. The dashboard Settings page also shows PayPal connection status.

---

<details>
<summary><strong>Developer Notes</strong></summary>

### Type Checking
```bash
pnpm --filter @somnibot/shared build
pnpm --filter @somnibot/bot type-check
pnpm --filter @somnibot/dashboard type-check
```

### Testing
```bash
pnpm --filter @somnibot/shared build
pnpm --filter @somnibot/bot test
pnpm --filter @somnibot/bot test:watch
```

### Build Order
- `packages/shared/` builds first (types + validators)
- `packages/bot/` and `packages/dashboard/` depend on shared
- Dashboard has zero runtime imports from `@somnibot/shared` (inlined for standalone dashboard builds)
- Turborepo handles build ordering via `^build` dependency

### Database Migrations
Migrations live in `packages/supabase/migrations/`. The bot auto-runs them on first boot if `SUPABASE_ACCESS_TOKEN` or `SUPABASE_DB_URL` is set. Otherwise, apply them manually via the Supabase SQL editor.

### Further Documentation
- **[Architecture](somnibot_architecture_v53.md)** — Full system design, 56 sections, every feature documented
- **[Contributing](CONTRIBUTING.md)** — Coding standards, patterns, testing, migration rules
- **[Deployment](DEPLOYMENT.md)** — Production deployment checklist with env vars and troubleshooting

</details>

---

## License

Private — © HeyImDionysus
