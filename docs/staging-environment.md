# Staging Environment

SomniBot uses a separate staging environment to validate changes before deploying to production. This document describes the recommended setup.

## Overview

| Property | Staging | Production |
|----------|---------|------------|
| Discord Bot | Separate application + token | Primary bot |
| Discord Server | Dedicated test server | Live server(s) |
| Supabase | Separate project or branch | Primary project |
| Valkey/Redis | Separate instance or DB index | Primary instance |
| Hosted stack | Separate VPS, WSL2 parity host, or preview environment | VPS/private network deployment |
| Dashboard URL | `staging.yourdomain.com` | `yourdomain.com` |

## Setup

### 1. Discord

1. Create a second Discord application at [discord.com/developers](https://discord.com/developers/applications)
2. Name it `SomniBot Staging` (or similar)
3. Create a bot user with the same permissions as production (Administrator / `8`)
4. Create or designate a Discord server for staging tests
5. Invite the staging bot to that server

### 2. Supabase

Option A — **Separate project** (recommended):
- Create a new Supabase project for staging
- Apply all migrations with the root pnpm script:
  `SUPABASE_DB_URL=<staging-postgres-url> pnpm db:migrate`
- Use the staging project's URL + keys in the staging `.env`

Option B — **Branching** (if using Supabase branching):
- Create a branch from the production database
- Migrations are applied automatically on branch creation

### 3. Hosted Stack

Use a separate VPS, a disposable preview host, or WSL2 as a VPS-parity test bed.
The staging stack should mirror production: dashboard, bot, Lavalink, and
Valkey/Redis together on the same host or private network. If you use a managed
preview provider such as Railway, treat it as an optional compatibility path, not
the default launch architecture.

1. Point `staging.yourdomain.com` or a stable staging tunnel at the dashboard.
2. Configure staging env vars:
   - `DISCORD_TOKEN` → staging bot token
   - `DISCORD_GUILD_ID` → staging server ID
   - `SUPABASE_URL` → staging Supabase URL
   - `SUPABASE_SECRET_KEY` → staging Supabase key
   - `NEXT_PUBLIC_APP_URL` and `DASHBOARD_URL` → staging dashboard URL
   - `CSRF_SECRET` → unique secret for staging
   - `NEXTAUTH_SECRET` → unique secret for staging
   - `WEBHOOK_REPLAY_SECRET` → unique secret for staging
   - `NODE_ENV=production` (so staging matches prod behavior)

### 4. Environment Variables

Create a `.env.staging` file (never committed) with all staging credentials:

```bash
# Discord (staging bot)
DISCORD_TOKEN=staging_bot_token_here
DISCORD_APPLICATION_ID=staging_app_id
DISCORD_CLIENT_SECRET=staging_client_secret
DISCORD_GUILD_ID=staging_guild_id

# Supabase (staging project)
SUPABASE_URL=https://staging-xxx.supabase.co
SUPABASE_SECRET_KEY=staging_secret_key
SUPABASE_PUBLISHABLE_KEY=staging_anon_key

# Dashboard
DASHBOARD_URL=https://staging.yourdomain.com
NEXT_PUBLIC_APP_URL=https://staging.yourdomain.com
NEXT_PUBLIC_SUPABASE_URL=https://staging-xxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=staging_anon_key
CSRF_SECRET=generate_with_node_scripts_gen-secret_mjs
NEXTAUTH_SECRET=generate_with_node_scripts_gen-secret_mjs
WEBHOOK_REPLAY_SECRET=generate_with_node_scripts_gen-secret_mjs

# Valkey
VALKEY_URL=redis://staging-valkey:6379

# PayPal (sandbox)
PAYPAL_SANDBOX=true
PAYPAL_CLIENT_ID=sandbox_client_id
PAYPAL_CLIENT_SECRET=sandbox_client_secret
PAYPAL_WEBHOOK_URL=https://staging.yourdomain.com/api/paypal/webhook
```

## Deployment Flow

```
feature branch → PR → CI checks pass
                     → Staging VPS/preview stack starts
                     → Manual QA on staging Discord server
                     → Merge to main
                     → Production deploy
```

## Testing Checklist

Before promoting staging → production:

- [ ] Bot starts without errors
- [ ] All slash commands register and respond
- [ ] Economy commands work (wallet, shop, trade)
- [ ] Moderation commands work (warn, mute, ban)
- [ ] Automation engine fires on triggers
- [ ] Dashboard loads, login via Discord OAuth works
- [ ] Dashboard API routes respond correctly
- [ ] Webhook endpoints accept payloads
- [ ] Level-up and XP tracking function
- [ ] `/forgetme` purge completes without errors
- [ ] Music playback connects to Lavalink

## Resetting Staging Data

To reset the staging database to a clean state:

```bash
# Drop and recreate all tables (staging only!)
pnpm db:reset
```

Or delete and recreate the staging host/preview environment.
