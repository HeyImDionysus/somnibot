# SomniBot

A full-featured Discord bot with a web dashboard. Moderation, levels, music, tickets, giveaways, commerce, and more — all configurable from a clean dashboard UI.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/somnibot?referralCode=somnibot)

---

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
- **Electron Launcher** — Desktop launcher for local deployment with auto-update
- **License SDK** — `@somnibot/license-sdk` for third-party app integration

---

## Quick Start (Local)

### What You Need

Before starting, make sure you have these installed on your computer:

| Tool | Why | How to get it |
|---|---|---|
| **Node.js 22+** | Runs the bot and dashboard | [nodejs.org](https://nodejs.org) — download the LTS version |
| **pnpm** | Installs packages | After installing Node, open a terminal and run: `corepack enable && corepack prepare pnpm@9 --activate` |
| **Docker Desktop** | Runs Lavalink (music) and Valkey (cache) | [docker.com/get-started](https://docker.com/get-started) — install and make sure the whale icon appears in your menu bar |
| **Git** | Clones the code | [git-scm.com](https://git-scm.com) (you probably already have this) |

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

# Dashboard runtime config:
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...your-anon-key

# Generate each secret with: openssl rand -hex 32
CSRF_SECRET=generate-a-secret
NEXTAUTH_SECRET=generate-a-secret
```

> **Tip:** `NEXT_PUBLIC_SUPABASE_URL` is the same value as `SUPABASE_URL`. The `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is the **publishable** key from Supabase (starts with `sb_publishable_`).
> Generate `CSRF_SECRET` and `NEXTAUTH_SECRET` separately with `openssl rand -hex 32`; do not reuse your Supabase or Discord secrets.

Save the file.

### Step 5: Invite the Bot to Your Server

1. Go back to [discord.com/developers/applications](https://discord.com/developers/applications) → your app → **OAuth2** → **URL Generator**.
2. Under "Scopes," check: `bot` and `applications.commands`.
3. Under "Bot Permissions," check: `Administrator` (or individually select the permissions you want).
4. Copy the generated URL at the bottom and open it in your browser.
5. Select your Discord server from the dropdown → **Authorize**.

### Step 6: Start Everything

**Mac / Linux:**
```bash
./scripts/start.sh
```

**Windows:**
```
scripts\start.bat
```

This starts Docker (Lavalink + Valkey), the bot, and the dashboard — all in one command.

You should see:
```
✅ Everything is running!

🤖 Bot:        Running
🌐 Dashboard:  http://localhost:3000
🎵 Lavalink:   http://localhost:2333
📦 Valkey:     redis://localhost:6379
```

**Open [http://localhost:3000](http://localhost:3000)** in your browser to see the dashboard.

### Step 7: First-Time Dashboard Setup

1. Go to [http://localhost:3000/setup](http://localhost:3000/setup).
2. Follow the 4-step wizard — it verifies your Discord and Supabase connections and configures authentication.
3. Once complete, go to [http://localhost:3000/login](http://localhost:3000/login) and click "Continue with Discord."
4. You're in! Configure features from the sidebar.

---

## Scripts Reference

All scripts are in the `scripts/` folder. On Mac/Linux, prefix with `./` (e.g., `./scripts/start.sh`). On Windows, use backslashes (e.g., `scripts\start.bat`).

| Script | What it does |
|---|---|
| `setup.sh` / `setup.bat` | First-time setup — checks prerequisites, installs deps, builds |
| `start.sh` / `start.bat` | Starts everything (Docker + bot + dashboard). Press Ctrl+C to stop |
| `start-bot.sh` | Starts Docker + bot only (no dashboard) |
| `start-dashboard.sh` | Starts the dashboard only (on port 3000) |
| `stop.sh` / `stop.bat` | Stops all running services |
| `rebuild.sh` | Pulls latest code, reinstalls deps, and rebuilds |
| `build-launcher.mjs` | Builds the Electron launcher package |
| `generate-db-types.py` | Generates TypeScript types from the Supabase database schema |

### Common Workflows

**Daily use:**
```bash
./scripts/start.sh        # Start everything
# Ctrl+C to stop
```

**After pulling updates from GitHub:**
```bash
./scripts/rebuild.sh      # Pull, reinstall, rebuild
./scripts/start.sh        # Start
```

**Running bot and dashboard in separate terminals** (useful for development — each gets its own log output):
```bash
# Terminal 1:
./scripts/start-bot.sh

# Terminal 2:
./scripts/start-dashboard.sh
```

---

## Deploy to the Cloud (Railway + Vercel)

If you want to run SomniBot 24/7 without keeping your computer on:

### Bot → Railway

1. Click the **Deploy on Railway** button at the top of this README.
2. When prompted, enter these environment variables:

| Variable | Where to find it |
|---|---|
| `DISCORD_TOKEN` | Discord Developer Portal → Bot → Token |
| `DISCORD_APPLICATION_ID` | Discord Developer Portal → OAuth2 → Client ID |
| `DISCORD_CLIENT_SECRET` | Discord Developer Portal → OAuth2 → Client Secret |
| `SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `SUPABASE_SECRET_KEY` | Supabase → Settings → API → secret key (sb_secret_...) |

Railway will deploy three services:
- **Bot** — the Discord bot
- **Lavalink** — music audio server
- **Valkey** — cache

### Dashboard → Vercel

1. Fork this repo on GitHub (click the "Fork" button on the repo page).
2. Go to [vercel.com](https://vercel.com) → sign up (free) → **Add New Project** → import your fork.
3. Set the **Root Directory** to `packages/dashboard`.
4. Add these environment variables:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Same Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (Settings → API) |
| `SUPABASE_SECRET_KEY` | Same secret key |
| `DISCORD_APPLICATION_ID` | Same Client ID |
| `DISCORD_CLIENT_SECRET` | Same Client Secret |
| `CSRF_SECRET` | Generate with `openssl rand -hex 32` |
| `NEXTAUTH_SECRET` | Generate with `openssl rand -hex 32` |
| `NEXT_PUBLIC_APP_URL` | Your deployed dashboard URL |

5. Click **Deploy**. Once deployed, open your dashboard URL → go to `/setup` to finish configuration.

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
├── docker-compose.yml Lavalink + Valkey for local dev
└── .env.example       Environment variable template
```

| Service | Local | Cloud | Purpose |
|---|---|---|---|
| Bot | `node packages/bot/dist/index.js` | Railway | Discord gateway, slash commands, all features |
| Dashboard | `next dev` on port 3000 | Vercel | Web UI for configuration and management |
| Lavalink | Docker on port 2333 | Railway | Audio streaming for music player |
| Valkey | Docker on port 6379 | Railway | Caching, rate limiting, queue state |
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
| `NEXT_PUBLIC_APP_URL` | Dashboard URL (`http://localhost:3000` locally; deployed URL in production) |
| `NEXT_PUBLIC_SUPABASE_URL` | Same as `SUPABASE_URL` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase **anon/public** key |
| `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key |
| `DISCORD_APPLICATION_ID` | Same Application/Client ID |
| `DISCORD_CLIENT_SECRET` | Same OAuth2 client secret |
| `CSRF_SECRET` | Generate with `openssl rand -hex 32` |
| `NEXTAUTH_SECRET` | Generate with `openssl rand -hex 32` |

### Auto-Configured (defaults work with Docker Compose)
| Variable | Default | Notes |
|---|---|---|
| `DISCORD_GUILD_ID` | Auto-detected | Detected on first bot login |
| `LAVALINK_HOST` | `localhost` | `lavalink.railway.internal` on Railway |
| `LAVALINK_PORT` | `2333` | — |
| `LAVALINK_PASSWORD` | `YOUR_LAVALINK_PASSWORD` | — |
| `VALKEY_URL` | `redis://127.0.0.1:6379` | `redis://valkey.railway.internal:6379` on Railway |

### Optional
| Variable | Description |
|---|---|
| `WEBHOOK_REPLAY_SECRET` | Dedicated webhook replay secret (recommended; falls back to derived secret) |
| `DOWNLOAD_SIGNING_SECRET` | Dedicated signed-download secret (recommended; falls back to app secrets) |
| `PAYPAL_CLIENT_ID` | PayPal app client ID (for commerce features) |
| `PAYPAL_CLIENT_SECRET` | PayPal app secret |
| `PAYPAL_SANDBOX` | `true` for sandbox mode, `false` for live (defaults to `true`) |
| `PAYPAL_API_BASE` | PayPal API URL (sandbox: `https://api-m.sandbox.paypal.com`) |
| `PAYPAL_WEBHOOK_ID` | PayPal webhook ID for signature verification |
| `PAYPAL_WEBHOOK_URL` | PayPal webhook endpoint URL |
| `YOUTUBE_OAUTH_REFRESH_TOKEN` | YouTube OAuth token (for music reliability) |
| `SUPABASE_ACCESS_TOKEN` | Supabase Management API token (for auto-migration) |
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
2. Restart the dashboard (Ctrl+C → `./scripts/start-dashboard.sh`).

### "Login redirects back to login"
The Supabase Discord auth provider needs to be configured. Run the setup wizard at `/setup` — step 2 handles this automatically.

### PayPal checkout errors
1. Make sure `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are set in `.env`.
2. For testing, use sandbox credentials from [developer.paypal.com](https://developer.paypal.com).
3. The dashboard Settings page also shows PayPal connection status.

---

<details>
<summary><strong>Developer Notes</strong></summary>

### Type Checking
```bash
pnpm --filter shared exec tsc --noEmit
pnpm --filter bot exec tsc --noEmit
pnpm --filter dashboard exec tsc --noEmit
```

### Testing
```bash
pnpm --filter bot test          # 82 unit tests
pnpm --filter bot test:watch    # Watch mode
```

### Build Order
- `packages/shared/` builds first (types + validators)
- `packages/bot/` and `packages/dashboard/` depend on shared
- Dashboard has zero runtime imports from `@somnibot/shared` (inlined for Vercel)
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
