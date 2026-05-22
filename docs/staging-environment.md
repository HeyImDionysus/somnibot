# Staging Environment

SomniBot uses a separate staging environment to validate changes before deploying to production. This document describes the recommended setup.

## Overview

| Property | Staging | Production |
|----------|---------|------------|
| Discord Bot | Separate application + token | Primary bot |
| Discord Server | Dedicated test server | Live server(s) |
| Supabase | Separate project or branch | Primary project |
| Valkey/Redis | Separate instance or DB index | Primary instance |
| Railway | Preview environment | Production deployment |
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
- Apply all migrations: `pnpm --filter @somnibot/supabase db:push`
- Use the staging project's URL + keys in the staging `.env`

Option B — **Branching** (if using Supabase branching):
- Create a branch from the production database
- Migrations are applied automatically on branch creation

### 3. Railway

Railway supports [preview environments](https://docs.railway.app/guides/preview-environments) that spin up from PR branches:

1. Enable preview environments in your Railway project settings
2. Configure staging env vars in the preview template:
   - `DISCORD_TOKEN` → staging bot token
   - `DISCORD_GUILD_ID` → staging server ID
   - `SUPABASE_URL` → staging Supabase URL
   - `SUPABASE_SECRET_KEY` → staging Supabase key
   - `CSRF_SECRET` → unique secret for staging
   - `NEXTAUTH_SECRET` → unique secret for staging
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
NEXT_PUBLIC_APP_URL=https://staging.yourdomain.com
NEXT_PUBLIC_SUPABASE_URL=https://staging-xxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=staging_anon_key
CSRF_SECRET=generate_with_openssl_rand_hex_32
NEXTAUTH_SECRET=generate_with_openssl_rand_hex_32

# Valkey
VALKEY_URL=redis://staging-valkey:6379

# PayPal (sandbox)
PAYPAL_SANDBOX=true
PAYPAL_CLIENT_ID=sandbox_client_id
PAYPAL_CLIENT_SECRET=sandbox_client_secret
```

## Deployment Flow

```
feature branch → PR → CI checks pass
                     → Railway preview environment spins up
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
pnpm --filter @somnibot/supabase db:reset
```

Or if using Railway, delete and recreate the preview environment.
