#!/usr/bin/env bash
# ============================================================
# SomniBot Phase 1 — Integration Test Script
# Run inside GitHub Codespaces or any environment with Docker.
#
# What this does:
#   1. Loads env from .env.example
#   2. TypeScript compilation check
#   3. Starts Docker containers (Lavalink + Valkey)
#   4. Runs Supabase migration + seed via Management API
#   5. Tests Discord bot login
#   6. Tests Valkey connectivity
#   7. Tests dashboard build
#   8. Prints pass/fail report
# ============================================================

# Don't exit on errors — we track pass/fail ourselves
set -uo pipefail

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
if (cd packages/shared && npx tsc 2>&1); then
  pass "Shared package compiles"
else
  fail "Shared package" "TypeScript errors"
fi

info "Type-checking @somnibot/bot..."
if (cd packages/bot && npx tsc --noEmit 2>&1); then
  pass "Bot package compiles"
else
  fail "Bot package" "TypeScript errors"
fi

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
      # Lavalink may take longer to start (Java)
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
# 4. Supabase — Migrate via Management API
# ────────────────────────────────────────
header "Supabase Schema"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  fail "Supabase" "SUPABASE_ACCESS_TOKEN not set — add it to .env to enable schema management"
else
  PROJECT_REF=$(echo "$SUPABASE_URL" | sed 's|https://||' | sed 's|\.supabase\.co.*||')
  MGMT_BASE="https://api.supabase.com"

  info "Project ref: $PROJECT_REF"

  # Check if tables already exist via REST API
  info "Checking existing schema..."
  CHECK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "apikey: ${SUPABASE_SECRET_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
    "${SUPABASE_URL}/rest/v1/guild?select=id&limit=1" 2>/dev/null || echo "000")

  if [ "$CHECK_STATUS" = "200" ]; then
    info "Tables already exist — skipping migration"
    pass "Supabase schema (already exists)"
  else
    info "Running migration via Management API..."

    # Nuke existing schema first
    NUKE_SQL="DO \$\$ DECLARE r RECORD; BEGIN FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('spatial_ref_sys')) LOOP EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE'; END LOOP; END \$\$;"

    curl -s -o /tmp/nuke_result.txt -w "%{http_code}" \
      -X POST "${MGMT_BASE}/v1/projects/${PROJECT_REF}/database/query" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
      -d "{\"query\": $(echo "$NUKE_SQL" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}" \
      > /tmp/nuke_status.txt 2>/dev/null

    NUKE_STATUS=$(cat /tmp/nuke_status.txt)
    if [ "$NUKE_STATUS" = "201" ] || [ "$NUKE_STATUS" = "200" ]; then
      info "Schema nuked"
    else
      info "Nuke response: $NUKE_STATUS (may be fine if schema was empty)"
    fi

    # Run migration
    MIGRATION_FILE="packages/supabase/migrations/20260516000000_initial_schema.sql"
    if [ -f "$MIGRATION_FILE" ]; then
      MIGRATION_SQL=$(cat "$MIGRATION_FILE")
      MIGRATION_JSON=$(python3 -c "import sys,json; print(json.dumps({'query': sys.stdin.read()}))" < "$MIGRATION_FILE")

      MIGRATE_STATUS=$(curl -s -o /tmp/migrate_result.txt -w "%{http_code}" \
        -X POST "${MGMT_BASE}/v1/projects/${PROJECT_REF}/database/query" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
        -d "$MIGRATION_JSON" 2>/dev/null)

      if [ "$MIGRATE_STATUS" = "201" ] || [ "$MIGRATE_STATUS" = "200" ]; then
        pass "Supabase migration applied"
      else
        MIGRATE_ERR=$(head -c 500 /tmp/migrate_result.txt 2>/dev/null)
        fail "Supabase migration" "HTTP $MIGRATE_STATUS — $MIGRATE_ERR"
      fi
    else
      fail "Supabase migration" "Migration file not found: $MIGRATION_FILE"
    fi

    # Run seed
    SEED_FILE="packages/supabase/seed.sql"
    if [ -f "$SEED_FILE" ]; then
      SEED_JSON=$(python3 -c "import sys,json; print(json.dumps({'query': sys.stdin.read()}))" < "$SEED_FILE")

      SEED_STATUS=$(curl -s -o /tmp/seed_result.txt -w "%{http_code}" \
        -X POST "${MGMT_BASE}/v1/projects/${PROJECT_REF}/database/query" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
        -d "$SEED_JSON" 2>/dev/null)

      if [ "$SEED_STATUS" = "201" ] || [ "$SEED_STATUS" = "200" ]; then
        pass "Supabase seed data applied"
      else
        info "Seed response: $SEED_STATUS (non-critical)"
      fi
    fi

    # Verify tables
    VERIFY_SQL="SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    VERIFY_JSON=$(python3 -c "import json; print(json.dumps({'query': '$VERIFY_SQL'}))")

    VERIFY_STATUS=$(curl -s -o /tmp/verify_result.txt -w "%{http_code}" \
      -X POST "${MGMT_BASE}/v1/projects/${PROJECT_REF}/database/query" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
      -d "$VERIFY_JSON" 2>/dev/null)

    if [ "$VERIFY_STATUS" = "201" ] || [ "$VERIFY_STATUS" = "200" ]; then
      TABLE_COUNT=$(grep -o '"tablename"' /tmp/verify_result.txt 2>/dev/null | wc -l)
      if [ "$TABLE_COUNT" -ge 35 ]; then
        pass "Table count: $TABLE_COUNT tables found (expected 35+)"
      else
        fail "Table count" "Only $TABLE_COUNT tables found (expected 35+)"
      fi
    else
      fail "Table verification" "HTTP $VERIFY_STATUS"
    fi
  fi
fi

# ────────────────────────────────────────
# 5. Discord bot login test
# ────────────────────────────────────────
header "Discord Bot Connection"

info "Testing Discord bot login..."

# Use a standalone script file to avoid shell quoting issues
cat > /tmp/test_discord.mjs << 'DISCORD_SCRIPT'
import { Client, GatewayIntentBits } from 'discord.js';

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
DISCORD_SCRIPT

node /tmp/test_discord.mjs 2>&1 | tee /tmp/discord_result.txt

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

if command -v docker &> /dev/null && docker compose ps 2>/dev/null | grep -q "valkey"; then
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
if (cd packages/dashboard && npx next build 2>&1 | tail -20); then
  pass "Dashboard builds successfully"
else
  fail "Dashboard build" "Build failed — check output above"
fi

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
rm -f /tmp/test_discord.mjs /tmp/discord_result.txt /tmp/supabase_result.txt /tmp/nuke_result.txt /tmp/nuke_status.txt /tmp/migrate_result.txt /tmp/seed_result.txt /tmp/verify_result.txt

echo ""
echo "Done. Paste this output to Viktor in Slack if anything failed."
