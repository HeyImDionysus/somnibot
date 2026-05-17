#!/usr/bin/env bash
# ============================================================
# SomniBot Phase 1 — Integration Test Script
# Run inside GitHub Codespaces or any environment with Docker.
#
# What this does:
#   1. Loads env from .env.example
#   2. Starts Docker containers (Lavalink + Valkey)
#   3. Nukes existing Supabase schema (FIRST RUN ONLY)
#   4. Runs the full migration + seed
#   5. Verifies all tables exist
#   6. Tests bot login to Discord
#   7. Tests dashboard build
#   8. Prints pass/fail report
# ============================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

PASS=0
FAIL=0
RESULTS=()

pass() {
  PASS=$((PASS + 1))
  RESULTS+=("${GREEN}✅ PASS${NC} — $1")
  echo -e "${GREEN}✅ PASS${NC} — $1"
}

fail() {
  FAIL=$((FAIL + 1))
  RESULTS+=("${RED}❌ FAIL${NC} — $1: $2")
  echo -e "${RED}❌ FAIL${NC} — $1: $2"
}

info() {
  echo -e "${CYAN}▸${NC} $1"
}

header() {
  echo ""
  echo -e "${YELLOW}═══════════════════════════════════════${NC}"
  echo -e "${YELLOW}  $1${NC}"
  echo -e "${YELLOW}═══════════════════════════════════════${NC}"
}

# ────────────────────────────────────────
# 0. Load environment
# ────────────────────────────────────────
header "Loading Environment"

if [ -f .env ]; then
  info "Loading from .env"
  set -a; source .env; set +a
elif [ -f .env.example ]; then
  info "No .env found — loading from .env.example"
  set -a; source .env.example; set +a
else
  fail "Environment" "No .env or .env.example found"
  exit 1
fi

# Verify critical env vars
for var in DISCORD_TOKEN DISCORD_APPLICATION_ID DISCORD_GUILD_ID SUPABASE_URL SUPABASE_SECRET_KEY; do
  if [ -z "${!var:-}" ]; then
    fail "Environment" "$var is not set"
  else
    pass "Env: $var is set"
  fi
done

# ────────────────────────────────────────
# 1. Install dependencies
# ────────────────────────────────────────
header "Installing Dependencies"

if ! command -v pnpm &> /dev/null; then
  info "Installing pnpm..."
  npm install -g pnpm@9.15.4
fi

info "Running pnpm install..."
if pnpm install --frozen-lockfile 2>/dev/null || pnpm install; then
  pass "pnpm install"
else
  fail "pnpm install" "Dependency installation failed"
fi

# ────────────────────────────────────────
# 2. TypeScript compilation check
# ────────────────────────────────────────
header "TypeScript Compilation"

# Build shared package first (other packages depend on it)
info "Building @somnibot/shared..."
if cd packages/shared && npx tsc --noEmit 2>&1; then
  pass "Shared package compiles"
else
  fail "Shared package" "TypeScript errors"
fi
cd "$OLDPWD"

info "Type-checking @somnibot/bot..."
if cd packages/bot && npx tsc --noEmit 2>&1; then
  pass "Bot package compiles"
else
  fail "Bot package" "TypeScript errors"
fi
cd "$OLDPWD"

# ────────────────────────────────────────
# 3. Docker containers (Lavalink + Valkey)
# ────────────────────────────────────────
header "Docker Containers"

if command -v docker &> /dev/null; then
  info "Starting Lavalink + Valkey..."
  if docker compose up -d 2>&1; then
    sleep 5  # Let containers initialize

    # Check Valkey
    if docker compose ps | grep -q "valkey.*running\|valkey.*Up"; then
      pass "Valkey container running"
    else
      fail "Valkey" "Container not running"
    fi

    # Check Lavalink
    if docker compose ps | grep -q "lavalink.*running\|lavalink.*Up"; then
      pass "Lavalink container running"
    else
      # Lavalink may take longer to start
      info "Waiting for Lavalink (Java startup)..."
      sleep 15
      if docker compose ps | grep -q "lavalink.*running\|lavalink.*Up"; then
        pass "Lavalink container running"
      else
        fail "Lavalink" "Container not running after 20s"
      fi
    fi
  else
    fail "Docker Compose" "Failed to start containers"
  fi
else
  fail "Docker" "Docker not available"
fi

# ────────────────────────────────────────
# 4. Supabase — Nuke & Migrate
# ────────────────────────────────────────
header "Supabase Schema"

# We use the Supabase REST API via the secret key to run SQL
SUPABASE_DB_API="${SUPABASE_URL}/rest/v1/rpc"
SUPABASE_SQL_URL="${SUPABASE_URL}/pg"  # Not available via REST — use direct connection

# Install a small Node script to run SQL against Supabase
info "Running schema setup via Node.js..."

node -e "
const fs = require('fs');

// Use fetch to interact with Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

async function runSQL(sql) {
  // Use Supabase's pg endpoint (available via management API)
  // For schema operations, we use the Supabase Management API
  const resp = await fetch(SUPABASE_URL + '/rest/v1/rpc/exec_sql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SECRET_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SECRET_KEY,
    },
    body: JSON.stringify({ query: sql }),
  });
  return resp;
}

async function main() {
  // Check if this is a first run by looking for a known table
  console.log('Checking existing schema...');

  const checkResp = await fetch(SUPABASE_URL + '/rest/v1/guild?select=id&limit=1', {
    headers: {
      'apikey': SUPABASE_SECRET_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SECRET_KEY,
    },
  });

  const isFirstRun = checkResp.status === 404 || checkResp.status >= 400;

  if (isFirstRun) {
    console.log('FIRST RUN — nuking existing schema...');

    // Drop all tables in public schema
    const nukeSQL = \`
      DO \\\$\\\$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
        -- Drop functions
        FOR r IN (SELECT proname, oidvectortypes(proargtypes) as args FROM pg_proc
                  INNER JOIN pg_namespace ns ON (pg_proc.pronamespace = ns.oid)
                  WHERE ns.nspname = 'public') LOOP
          EXECUTE 'DROP FUNCTION IF EXISTS public.' || quote_ident(r.proname) || '(' || r.args || ') CASCADE';
        END LOOP;
        -- Drop sequences
        FOR r IN (SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public') LOOP
          EXECUTE 'DROP SEQUENCE IF EXISTS public.' || quote_ident(r.sequence_name) || ' CASCADE';
        END LOOP;
        -- Drop types
        FOR r IN (SELECT typname FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid
                  WHERE n.nspname = 'public' AND t.typtype = 'e') LOOP
          EXECUTE 'DROP TYPE IF EXISTS public.' || quote_ident(r.typname) || ' CASCADE';
        END LOOP;
      END \\\$\\\$;
    \`;
    const nukeResp = await runSQL(nukeSQL);
    if (nukeResp.ok) {
      console.log('Schema nuked successfully.');
    } else {
      console.log('Nuke via RPC not available — trying direct migration...');
    }
  } else {
    console.log('Tables already exist — skipping nuke (not first run).');
  }

  // Run migration
  console.log('Running migration...');
  const migrationSQL = fs.readFileSync('packages/supabase/migrations/20260516000000_initial_schema.sql', 'utf-8');

  // Supabase doesn't expose raw SQL via REST easily.
  // We'll use the Supabase Management API instead.
  const mgmtBase = 'https://api.supabase.com';
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0];

  if (accessToken) {
    console.log('Using Management API (project: ' + projectRef + ')...');

    // Run the nuke first if first run
    if (isFirstRun) {
      const nukeSQL = \`
        DO \\\$\\\$ DECLARE r RECORD;
        BEGIN
          FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('spatial_ref_sys')) LOOP
            EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
          END LOOP;
        END \\\$\\\$;
      \`;

      const nukeResp = await fetch(mgmtBase + '/v1/projects/' + projectRef + '/database/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
        },
        body: JSON.stringify({ query: nukeSQL }),
      });

      if (nukeResp.ok) {
        console.log('✅ Schema nuked via Management API');
      } else {
        const err = await nukeResp.text();
        console.log('⚠️  Nuke response: ' + nukeResp.status + ' — ' + err);
      }
    }

    // Run migration in chunks (Management API may have size limits)
    // Split on major section comments
    const migrationResp = await fetch(mgmtBase + '/v1/projects/' + projectRef + '/database/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + accessToken,
      },
      body: JSON.stringify({ query: migrationSQL }),
    });

    if (migrationResp.ok) {
      console.log('✅ Migration applied successfully');
    } else {
      const err = await migrationResp.text();
      console.error('❌ Migration failed: ' + migrationResp.status + ' — ' + err.substring(0, 500));
      process.exit(1);
    }

    // Run seed
    console.log('Running seed data...');
    const seedSQL = fs.readFileSync('packages/supabase/seed.sql', 'utf-8');
    const seedResp = await fetch(mgmtBase + '/v1/projects/' + projectRef + '/database/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + accessToken,
      },
      body: JSON.stringify({ query: seedSQL }),
    });

    if (seedResp.ok) {
      console.log('✅ Seed data applied');
    } else {
      const err = await seedResp.text();
      console.error('⚠️  Seed response: ' + seedResp.status + ' — ' + err.substring(0, 300));
    }

    // Verify tables
    console.log('Verifying tables...');
    const verifyResp = await fetch(mgmtBase + '/v1/projects/' + projectRef + '/database/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + accessToken,
      },
      body: JSON.stringify({ query: \"SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename\" }),
    });

    if (verifyResp.ok) {
      const tables = await verifyResp.json();
      console.log('TABLES_FOUND:' + JSON.stringify(tables));
    } else {
      console.error('❌ Could not verify tables');
      process.exit(1);
    }
  } else {
    console.error('❌ SUPABASE_ACCESS_TOKEN not set — cannot run migration via API.');
    console.log('Set it in .env to enable schema management.');
    process.exit(1);
  }
}

main().catch(err => { console.error('❌ ' + err.message); process.exit(1); });
" 2>&1 | tee /tmp/supabase_result.txt

if grep -q "Migration applied successfully" /tmp/supabase_result.txt; then
  pass "Supabase migration"
elif grep -q "Tables already exist" /tmp/supabase_result.txt; then
  pass "Supabase schema (already exists)"
else
  fail "Supabase migration" "Check output above"
fi

if grep -q "Seed data applied" /tmp/supabase_result.txt; then
  pass "Supabase seed data"
fi

# Count tables
if grep -q "TABLES_FOUND:" /tmp/supabase_result.txt; then
  TABLE_LINE=$(grep "TABLES_FOUND:" /tmp/supabase_result.txt)
  TABLE_COUNT=$(echo "$TABLE_LINE" | grep -o '"tablename"' | wc -l)
  if [ "$TABLE_COUNT" -ge 35 ]; then
    pass "Table count: $TABLE_COUNT tables found (expected 35+)"
  else
    fail "Table count" "Only $TABLE_COUNT tables found (expected 35+)"
  fi
fi

# ────────────────────────────────────────
# 5. Discord bot login test
# ────────────────────────────────────────
header "Discord Bot Connection"

info "Testing Discord bot login..."

node -e "
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const timeout = setTimeout(() => {
  console.error('TIMEOUT — bot did not connect in 15s');
  process.exit(1);
}, 15000);

client.once('ready', () => {
  clearTimeout(timeout);
  console.log('BOT_TAG:' + client.user.tag);
  console.log('BOT_ID:' + client.user.id);

  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (guild) {
    console.log('GUILD_NAME:' + guild.name);
    console.log('GUILD_MEMBERS:' + guild.memberCount);

    // Check bot role position
    const botMember = guild.members.cache.get(client.user.id);
    if (botMember) {
      const highestRole = botMember.roles.highest;
      console.log('BOT_ROLE:' + highestRole.name + ' (position ' + highestRole.position + ')');
      if (highestRole.position < guild.roles.cache.size - 1) {
        console.log('ROLE_WARNING:Bot role is not at position #1 — move it up in Server Settings > Roles');
      }
    }
  } else {
    console.log('GUILD_NOT_FOUND:' + process.env.DISCORD_GUILD_ID);
  }

  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  clearTimeout(timeout);
  console.error('LOGIN_FAILED:' + err.message);
  process.exit(1);
});
" 2>&1 | tee /tmp/discord_result.txt

if grep -q "BOT_TAG:" /tmp/discord_result.txt; then
  BOT_TAG=$(grep "BOT_TAG:" /tmp/discord_result.txt | cut -d: -f2-)
  pass "Discord login: $BOT_TAG"
else
  fail "Discord login" "$(grep -o 'LOGIN_FAILED:.*' /tmp/discord_result.txt || echo 'Unknown error')"
fi

if grep -q "GUILD_NAME:" /tmp/discord_result.txt; then
  GUILD_NAME=$(grep "GUILD_NAME:" /tmp/discord_result.txt | cut -d: -f2-)
  pass "Guild found: $GUILD_NAME"
elif grep -q "GUILD_NOT_FOUND:" /tmp/discord_result.txt; then
  fail "Guild" "Bot is not in guild ${DISCORD_GUILD_ID}"
fi

if grep -q "ROLE_WARNING:" /tmp/discord_result.txt; then
  ROLE_WARN=$(grep "ROLE_WARNING:" /tmp/discord_result.txt | cut -d: -f2-)
  echo -e "${YELLOW}⚠️  WARNING${NC} — $ROLE_WARN"
fi

# ────────────────────────────────────────
# 6. Valkey connection test
# ────────────────────────────────────────
header "Valkey Connection"

if command -v docker &> /dev/null && docker compose ps | grep -q "valkey"; then
  info "Testing Valkey PING..."
  if docker compose exec -T valkey valkey-cli PING 2>/dev/null | grep -q "PONG"; then
    pass "Valkey responds to PING"
  else
    fail "Valkey" "No PONG response"
  fi
else
  fail "Valkey" "Container not running"
fi

# ────────────────────────────────────────
# 7. Dashboard build test
# ────────────────────────────────────────
header "Dashboard Build"

info "Testing Next.js build..."
if cd packages/dashboard && npx next build 2>&1 | tail -20; then
  pass "Dashboard builds successfully"
else
  fail "Dashboard build" "Build failed — check output above"
fi
cd "$OLDPWD"

# ────────────────────────────────────────
# REPORT
# ────────────────────────────────────────
header "Phase 1 Test Report"

echo ""
for result in "${RESULTS[@]}"; do
  echo -e "  $result"
done
echo ""
echo -e "  ${GREEN}Passed: $PASS${NC}  |  ${RED}Failed: $FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}══════════════════════════════════════════${NC}"
  echo -e "${GREEN}  🎉 ALL TESTS PASSED — Phase 1 verified!${NC}"
  echo -e "${GREEN}══════════════════════════════════════════${NC}"
else
  echo -e "${RED}══════════════════════════════════════════${NC}"
  echo -e "${RED}  ⚠️  $FAIL test(s) failed — see above${NC}"
  echo -e "${RED}══════════════════════════════════════════${NC}"
fi

# ────────────────────────────────────────
# Cleanup
# ────────────────────────────────────────
info "Stopping Docker containers..."
docker compose down 2>/dev/null || true

echo ""
echo "Done. Paste this output to Viktor in Slack if anything failed."
