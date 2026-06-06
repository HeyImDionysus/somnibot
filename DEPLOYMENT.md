# SomniBot — Deployment Guide

> Production deployment checklist for SomniBot v53.

---

## Prerequisites

- Discord bot application (Developer Portal)
- Supabase project (free tier works)
- Vercel account (for dashboard)
- Railway/VPS (for bot + Lavalink + Valkey)
- Node.js 22+, pnpm 9+

---

## 1. Discord Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create an application → note the **Application ID** and **Client Secret** (OAuth2 tab)
3. Go to the **Bot** tab → create bot → note the **Bot Token**
4. Enable these **Privileged Gateway Intents**: `GUILD_MEMBERS`, `MESSAGE_CONTENT`, `GUILD_PRESENCES`
5. OAuth2 → Add the Supabase Auth callback URL shown in your Supabase Discord provider settings (usually `https://<project-ref>.supabase.co/auth/v1/callback`)

## 2. Supabase Setup

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to **Settings → API** → note:
   - `SUPABASE_URL` (Project URL)
   - `SUPABASE_SECRET_KEY` (service_role key — **keep secret**)
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (anon key)
3. Run all migrations in order:
   ```bash
   cd packages/supabase
   supabase db push    # or apply migrations manually via SQL editor
   ```
4. Go to **Authentication → Providers → Discord** → enable with your Client ID and Secret
5. Go to **Authentication → URL Configuration** and allow the dashboard callback URL: `https://your-dashboard.vercel.app/api/auth/callback`
   - This must match the dashboard OAuth callback route used by the app and setup wizard.

## 3. Dashboard (Vercel)

1. Import the repo on [Vercel](https://vercel.com)
2. Set **Root Directory** to `packages/dashboard`
3. Add environment variables:

| Variable | Source |
|---|---|
| `NEXT_PUBLIC_APP_URL` | Public dashboard URL, e.g. `https://your-dashboard.vercel.app` |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase anon key |
| `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key |
| `DISCORD_APPLICATION_ID` | Discord Developer Portal |
| `DISCORD_CLIENT_SECRET` | Discord Developer Portal |
| `CSRF_SECRET` | Generate with `openssl rand -hex 32` |
| `NEXTAUTH_SECRET` | Generate with `openssl rand -hex 32` |
| `VALKEY_URL` or `REDIS_URL` | Redis/Valkey connection string for rate limiting (recommended in production) |
| `WEBHOOK_REPLAY_SECRET` | Generate with `openssl rand -hex 32` (recommended for webhook replay isolation) |
| `DOWNLOAD_SIGNING_SECRET` | Generate with `openssl rand -hex 32` (recommended for signed download links) |

4. Deploy → navigate to `/setup` to complete first-run configuration

## 4. Bot (Railway / VPS)

### Environment Variables

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Developer Portal |
| `DISCORD_APPLICATION_ID` | Application ID |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret |
| `DISCORD_GUILD_ID` | Comma-separated guild IDs (multi-guild) or single ID |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase service_role key |
| `VALKEY_URL` | Redis/Valkey connection string (default: `redis://127.0.0.1:6379`) |
| `LAVALINK_HOST` | Lavalink server host (default: `localhost`) |
| `LAVALINK_PORT` | Lavalink server port (default: `2333`) |
| `LAVALINK_PASSWORD` | Lavalink password (default: `YOUR_LAVALINK_PASSWORD`) |
| `NODE_ENV` | Set to `production` |

### Railway Deploy

```bash
# Bot service
railway up --service bot

# Lavalink service (use Lavalink Docker image)
# Valkey service (use Valkey Docker image)
```

### Manual VPS Deploy

```bash
git clone https://github.com/HeyImDionysus/somnibot.git
cd somnibot
pnpm install
pnpm --filter bot build
node packages/bot/dist/index.js
```

## 5. Desktop Launcher

The Electron launcher (`packages/launcher`) bundles everything for local/dev use:

```bash
pnpm --filter launcher build
pnpm --filter launcher dist    # Creates installer
```

The launcher manages bot + dashboard + Lavalink processes with a GUI config form.

## 6. Lavalink (Music)

Lavalink requires Java 17+. Default config:

```yaml
server:
  port: 2333
  address: 0.0.0.0
lavalink:
  server:
    password: "YOUR_LAVALINK_PASSWORD"
    sources:
      youtube: true
```

## 7. Post-Deployment Checklist

- [ ] Bot is online in Discord (green status)
- [ ] Dashboard loads and redirects to Discord OAuth login
- [ ] Owner can log in and sees guild dashboard
- [ ] Bot heartbeat visible in dashboard health metrics
- [ ] Slash commands registered (auto-registers on boot)
- [ ] Music playback works (requires Lavalink running)
- [ ] Economy commands functional
- [ ] Ticket system creates channels correctly
- [ ] Automations fire on events
- [ ] `/forgetme` command works (privacy compliance)

## 8. Monitoring

- **Bot Health**: Dashboard → Health page shows heartbeat, event throughput, queue depth
- **Alerts**: `alerts` table in Supabase — config sync failures, automation errors, stale queues
- **DLQ**: Dashboard → Dead Letter Queue for failed actions with retry/purge
- **Audit Log**: `audit_log` table tracks all admin actions and bot errors

## 9. Updating

```bash
git pull origin main
pnpm install
pnpm -r build
# Restart bot process
# Vercel auto-deploys dashboard on push to main
# Run any new migrations: supabase db push
```

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Bot not responding | Check `DISCORD_TOKEN` is valid, intents are enabled |
| "Unauthorized" on dashboard | Verify Supabase auth provider config + redirect URL |
| Music not playing | Ensure Lavalink is running, check `LAVALINK_*` env vars |
| Slash commands not showing | Bot needs `applications.commands` scope in invite URL |
| Migration fails | Run `supabase db reset` for fresh install, or check for timestamp collisions |
