# SomniBot

A full-featured Discord bot with a web dashboard. Moderation, levels, music, tickets, giveaways, commerce, and more — all configurable from a clean dashboard UI.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/somnibot?referralCode=somnibot)

---

## Quick Setup (4 steps)

### 1. Create a Discord Bot
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → name it → **Create**
3. **Bot** tab → **Reset Token** → copy the token
4. Enable all three **Privileged Gateway Intents** (Presence, Server Members, Message Content)
5. **OAuth2** tab → copy **Client ID** and **Client Secret**

### 2. Create a Supabase Project
1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) and sign up (free)
2. **New Project** → name it → set a password → **Create**
3. Go to **Settings → API** → copy the **Project URL**
4. Copy the **service_role** key (under "Project API keys")

### 3. Deploy to Railway
Click the **Deploy on Railway** button above. When prompted, enter:

| Variable | Where to find it |
|---|---|
| `DISCORD_TOKEN` | Bot tab → Token |
| `DISCORD_APPLICATION_ID` | OAuth2 tab → Client ID |
| `DISCORD_CLIENT_SECRET` | OAuth2 tab → Client Secret |
| `SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role key |

Railway will deploy three services:
- **Bot** — the Discord bot (Node.js)
- **Lavalink** — music audio server
- **Valkey** — Redis-compatible cache

### 4. Deploy the Dashboard
1. Fork this repo on GitHub
2. Go to [vercel.com](https://vercel.com) → **New Project** → import the fork
3. Set the root directory to `packages/dashboard`
4. Add these environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL` — same Supabase URL
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — Supabase **anon** key
   - `SUPABASE_SERVICE_ROLE_KEY` — same service role key
   - `DISCORD_APPLICATION_ID` — same Client ID
   - `DISCORD_CLIENT_SECRET` — same Client Secret
5. Deploy → open the dashboard → go to `/setup` to finish configuration

That's it. The bot auto-runs database migrations on first boot.

---

## Architecture

```
packages/
├── bot/           Discord.js bot (Shoukaku, Supabase, Valkey)
├── dashboard/     Next.js App Router dashboard
├── shared/        Shared types, constants, validators
├── supabase/      Database migrations
└── license-sdk/   @somnibot/license-sdk for third-party integrations
```

| Service | Platform | Purpose |
|---|---|---|
| Bot | Railway | Discord gateway, slash commands, all features |
| Dashboard | Vercel | Web UI for configuration and management |
| Lavalink | Railway | Audio streaming for music player |
| Valkey | Railway | Caching, rate limiting, queue state |
| Supabase | Supabase.com | PostgreSQL database, auth, storage |

---

## Features

- **Moderation** — Auto-mod rules, infractions, escalation, mod log
- **Tickets** — Panel-based ticket system with transcripts
- **Levels & XP** — Message + voice XP, rank cards, level rewards
- **Music** — Lavalink-powered player with queue, filters, and rich embeds
- **Reaction Roles** — Configurable reaction-to-role mappings
- **Custom Commands** — Create custom slash commands from the dashboard
- **Giveaways** — Timed giveaways with requirements and commerce integration
- **Scheduled Messages** — Recurring messages with cron scheduling
- **Temp Channels** — Hub-based temporary voice channels
- **Stats Channels** — Live server stats displayed as voice channel names
- **Commerce** — Product store, PayPal checkout, license key generation
- **Automations** — Event-driven automation workflows
- **Server Sync** — Desired-state configuration with drift detection
- **Audit Log** — Full audit trail of all bot actions
- **Diagnostics** — Real-time system health monitoring

---

## Self-Hosting

If you want to self-host everything (no Railway/Vercel):

```bash
# Clone and install
git clone https://github.com/HeyImDionysus/somnibot.git
cd somnibot
pnpm install

# Copy .env.example to .env and fill in values
cp .env.example .env

# Start infrastructure (Lavalink + Valkey)
docker compose up -d

# Build and run
pnpm build
node packages/bot/dist/index.js
```

For the dashboard:
```bash
cd packages/dashboard
pnpm build
pnpm start
```

Or use Docker Compose for everything:
```bash
docker compose -f docker-compose.prod.yml up -d
```

> **Note:** If distributing this project to a new owner, they will need to create their own Supabase project and run the migrations in `packages/supabase/migrations/` against it. The bot auto-runs migrations on first boot if the `SUPABASE_ACCESS_TOKEN` or `SUPABASE_DB_URL` environment variable is set.

---

## Environment Variables

### Required (5)
| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `DISCORD_APPLICATION_ID` | Application/Client ID |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |

### Auto-Configured
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
| `PAYPAL_CLIENT_ID` | PayPal app client ID (for commerce) |
| `PAYPAL_CLIENT_SECRET` | PayPal app secret |
| `YOUTUBE_OAUTH_REFRESH_TOKEN` | YouTube OAuth token (for music) |
| `SUPABASE_ACCESS_TOKEN` | Supabase Management API token (for auto-migration) |
| `SUPABASE_DB_URL` | Direct database URL (for auto-migration) |

---

<details>
<summary><strong>Developer Setup</strong></summary>

### Prerequisites
- Node.js 22+
- pnpm 9+
- Docker (for Lavalink and Valkey)

### Development
```bash
pnpm install
docker compose up -d          # Start Lavalink + Valkey
pnpm dev                      # Start bot + dashboard in dev mode
```

### Type Checking
```bash
cd packages/shared && bun x tsc --noEmit
cd packages/bot && bun x tsc --noEmit
cd packages/dashboard && bun x tsc --noEmit
```

### Build
```bash
pnpm build                    # Build all packages via Turborepo
```

### Project Structure
- `packages/shared/` builds first (types + validators)
- `packages/bot/` and `packages/dashboard/` depend on shared
- Dashboard has zero runtime imports from `@somnibot/shared` (inlined for Vercel)
- Turborepo handles build ordering via `^build` dependency

</details>

---

## License

Private — © HeyImDionysus
