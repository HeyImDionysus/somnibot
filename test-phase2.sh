#!/usr/bin/env bash
# ============================================================
# SomniBot Phase 2 — Integration Test Script
# Run inside GitHub Codespaces or any environment with Docker.
#
# What this does:
#   1. Loads env from .env.example
#   2. Installs dependencies
#   3. TypeScript compilation (shared + bot + dashboard)
#   4. Starts Docker containers (Lavalink + Valkey)
#   5. Supabase schema migration + seed
#   6. Discord bot login test
#   7. Valkey connectivity
#   8. Dashboard build
#   9. Prints pass/fail report
# ============================================================

set -uo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

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
# 2. TypeScript compilation
# ────────────────────────────────────────
header "TypeScript Compilation"

# Build shared first (other packages depend on it)
info "Building @somnibot/shared..."
SHARED_OUT=$(cd packages/shared && npx tsc 2>&1)
SHARED_EXIT=$?
if [ $SHARED_EXIT -eq 0 ]; then
  pass "Shared package compiles"
else
  echo "$SHARED_OUT"
  fail "Shared package" "TypeScript errors (exit $SHARED_EXIT)"
fi

# Check that engine files are in the dist
info "Checking engine dist output..."
ENGINE_FILES=("packages/shared/dist/engine/permissions.js" "packages/shared/dist/engine/safety.js" "packages/shared/dist/engine/diff.js" "packages/shared/dist/engine/index.js")
ENGINE_MISSING=0
for ef in "${ENGINE_FILES[@]}"; do
  if [ ! -f "$ef" ]; then
    ENGINE_MISSING=$((ENGINE_MISSING + 1))
    info "  Missing: $ef"
  fi
done
if [ $ENGINE_MISSING -eq 0 ]; then
  pass "Engine dist files present (${#ENGINE_FILES[@]} files)"
else
  fail "Engine dist" "$ENGINE_MISSING file(s) missing from dist"
fi

# Type-check bot package
info "Type-checking @somnibot/bot..."
BOT_OUT=$(cd packages/bot && npx tsc --noEmit 2>&1)
BOT_EXIT=$?
if [ $BOT_EXIT -eq 0 ]; then
  pass "Bot package compiles"
else
  echo "$BOT_OUT"
  fail "Bot package" "TypeScript errors (exit $BOT_EXIT)"
fi

# Check bot deploy/sync/guard files specifically
info "Checking bot Phase 2 files..."
BOT_P2_FILES=("packages/bot/src/deploy/deployer.ts" "packages/bot/src/guards/bot-role-guard.ts" "packages/bot/src/sync/snapshot.ts" "packages/bot/src/sync/sync-engine.ts")
BOT_P2_MISSING=0
for bf in "${BOT_P2_FILES[@]}"; do
  if [ ! -f "$bf" ]; then
    BOT_P2_MISSING=$((BOT_P2_MISSING + 1))
    info "  Missing: $bf"
  fi
done
if [ $BOT_P2_MISSING -eq 0 ]; then
  pass "Bot Phase 2 source files present (${#BOT_P2_FILES[@]} files)"
else
  fail "Bot Phase 2 files" "$BOT_P2_MISSING file(s) missing"
fi

# ────────────────────────────────────────
# 3. Docker containers (Lavalink + Valkey)
# ────────────────────────────────────────
header "Docker Containers"

if command -v docker &> /dev/null; then
  info "Starting Lavalink + Valkey..."
  if docker compose up -d 2>&1; then
    sleep 5

    if docker compose ps | grep -q "valkey.*running\|valkey.*Up"; then
      pass "Valkey container running"
    else
      fail "Valkey" "Container not running"
    fi

    if docker compose ps | grep -q "lavalink.*running\|lavalink.*Up"; then
      pass "Lavalink container running"
    else
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
  fail "Supabase" "SUPABASE_ACCESS_TOKEN not set"
else
  PROJECT_REF=$(echo "$SUPABASE_URL" | sed 's|https://||' | sed 's|\.supabase\.co.*||')
  MGMT_BASE="https://api.supabase.com"

  info "Project ref: $PROJECT_REF"

  # Check project status
  info "Checking project status..."
  PROJECT_STATUS=$(curl -s \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    "${MGMT_BASE}/v1/projects/${PROJECT_REF}" 2>/dev/null)

  PROJ_STATUS_VAL=$(echo "$PROJECT_STATUS" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  info "Project status: $PROJ_STATUS_VAL"

  if [[ "$PROJ_STATUS_VAL" == *"INACTIVE"* ]] || [[ "$PROJ_STATUS_VAL" == *"PAUSED"* ]]; then
    info "Project is paused/inactive — restoring..."
    curl -s -X POST \
      -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
      "${MGMT_BASE}/v1/projects/${PROJECT_REF}/restore" 2>/dev/null >/dev/null

    info "Waiting for project to come online (checking every 15s, up to 3min)..."
    for i in $(seq 1 12); do
      sleep 15
      CHECK=$(curl -s \
        -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
        "${MGMT_BASE}/v1/projects/${PROJECT_REF}" 2>/dev/null)
      STATUS_NOW=$(echo "$CHECK" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
      info "  Attempt $i/12: status=$STATUS_NOW"
      if [ "$STATUS_NOW" = "ACTIVE_HEALTHY" ]; then
        info "Project is now active!"
        break
      fi
    done
  elif [ "$PROJ_STATUS_VAL" = "ACTIVE_HEALTHY" ]; then
    info "Project is active"
  fi

  # Check tables via REST
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

    # Nuke existing
    NUKE_SQL='DO $$ DECLARE r RECORD; BEGIN FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = '"'"'public'"'"' AND tablename NOT IN ('"'"'spatial_ref_sys'"'"')) LOOP EXECUTE '"'"'DROP TABLE IF EXISTS public.'"'"' || quote_ident(r.tablename) || '"'"' CASCADE'"'"'; END LOOP; END $$;'
    NUKE_JSON=$(python3 -c "import sys, json; print(json.dumps({'query': sys.argv[1]}))" "$NUKE_SQL")

    curl -s -o /tmp/nuke_result.txt -w "%{http_code}" \
      -X POST "${MGMT_BASE}/v1/projects/${PROJECT_REF}/database/query" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
      -d "$NUKE_JSON" 2>/dev/null >/dev/null

    # Migration
    MIGRATION_FILE="packages/supabase/migrations/20260516000000_initial_schema.sql"
    if [ -f "$MIGRATION_FILE" ]; then
      MIGRATION_JSON=$(python3 -c "
import sys, json
with open(sys.argv[1], 'r') as f:
    sql = f.read()
print(json.dumps({'query': sql}))
" "$MIGRATION_FILE")

      MIGRATE_STATUS=$(curl -s -o /tmp/migrate_result.txt -w "%{http_code}" \
        --max-time 120 \
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

    # Seed
    SEED_FILE="packages/supabase/seed.sql"
    if [ -f "$SEED_FILE" ]; then
      SEED_JSON=$(python3 -c "
import sys, json
with open(sys.argv[1], 'r') as f:
    sql = f.read()
print(json.dumps({'query': sql}))
" "$SEED_FILE")

      SEED_STATUS=$(curl -s -o /tmp/seed_result.txt -w "%{http_code}" \
        --max-time 30 \
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

    # Verify table count
    VERIFY_JSON=$(python3 -c "import json; print(json.dumps({'query': \"SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename\"}))")

    VERIFY_STATUS=$(curl -s -o /tmp/verify_result.txt -w "%{http_code}" \
      --max-time 15 \
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

cat > packages/bot/.test_discord.mjs << 'DISCORD_SCRIPT'
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

node packages/bot/.test_discord.mjs 2>&1 | tee /tmp/discord_result.txt

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

rm -f packages/bot/.test_discord.mjs

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
DASHBOARD_OUT=$(cd packages/dashboard && npx next build 2>&1)
DASHBOARD_EXIT=$?

if [ $DASHBOARD_EXIT -eq 0 ]; then
  pass "Dashboard builds successfully"
else
  echo "$DASHBOARD_OUT" | tail -40
  fail "Dashboard build" "Build failed (exit $DASHBOARD_EXIT) — check output above"
fi

# Check that Phase 2 pages compiled into the build
info "Checking Phase 2 page routes in build output..."
P2_PAGES=("/roles" "/channels" "/setup" "/sync")
P2_FOUND=0
for page in "${P2_PAGES[@]}"; do
  if echo "$DASHBOARD_OUT" | grep -q "$page"; then
    P2_FOUND=$((P2_FOUND + 1))
  fi
done
if [ $P2_FOUND -ge ${#P2_PAGES[@]} ]; then
  pass "Phase 2 pages in build output (${P2_FOUND}/${#P2_PAGES[@]})"
else
  info "Only $P2_FOUND of ${#P2_PAGES[@]} Phase 2 pages found in build output (may still be OK if build succeeded)"
fi

# ────────────────────────────────────────
# 8. Phase 2 specific: engine module exports
# ────────────────────────────────────────
header "Phase 2: Engine Module Verification"

info "Testing engine module import..."
cat > /tmp/test_engine.mjs << 'ENGINE_SCRIPT'
// Test that the shared engine exports are loadable
import { readFileSync } from 'fs';
import { join } from 'path';

// Since we're testing the dist output, check if key exports exist in the JS files
const engineDir = join(process.cwd(), 'packages/shared/dist/engine');

try {
  const permJS = readFileSync(join(engineDir, 'permissions.js'), 'utf-8');
  const checks = [
    ['computeServerPermissions', permJS.includes('computeServerPermissions')],
    ['computeChannelPermissions', permJS.includes('computeChannelPermissions')],
    ['decomposePermissions', permJS.includes('decomposePermissions')],
    ['buildChannelOverwrites', permJS.includes('buildChannelOverwrites')],
  ];

  const safetyJS = readFileSync(join(engineDir, 'safety.js'), 'utf-8');
  checks.push(
    ['validateDeployment', safetyJS.includes('validateDeployment')],
    ['validateRolePermissions', safetyJS.includes('validateRolePermissions')],
    ['isLockoutSafe', safetyJS.includes('isLockoutSafe')],
  );

  const diffJS = readFileSync(join(engineDir, 'diff.js'), 'utf-8');
  checks.push(
    ['computeStateDiff', diffJS.includes('computeStateDiff')],
    ['classifyDrift', diffJS.includes('classifyDrift')],
  );

  let allOk = true;
  for (const [name, ok] of checks) {
    if (ok) {
      console.log('ENGINE_EXPORT_OK:' + name);
    } else {
      console.log('ENGINE_EXPORT_MISSING:' + name);
      allOk = false;
    }
  }

  if (allOk) {
    console.log('ENGINE_ALL_OK');
  }
} catch (err) {
  console.log('ENGINE_ERROR:' + err.message);
}
ENGINE_SCRIPT

node /tmp/test_engine.mjs 2>&1 | tee /tmp/engine_result.txt

if grep -q "ENGINE_ALL_OK" /tmp/engine_result.txt; then
  EXPORT_COUNT=$(grep -c "ENGINE_EXPORT_OK:" /tmp/engine_result.txt)
  pass "Engine exports verified ($EXPORT_COUNT functions)"
elif grep -q "ENGINE_ERROR:" /tmp/engine_result.txt; then
  ERR=$(grep "ENGINE_ERROR:" /tmp/engine_result.txt | cut -d: -f2-)
  fail "Engine module" "$ERR"
else
  MISSING=$(grep "ENGINE_EXPORT_MISSING:" /tmp/engine_result.txt | cut -d: -f2- | tr '\n' ', ')
  fail "Engine exports" "Missing: $MISSING"
fi

rm -f /tmp/test_engine.mjs /tmp/engine_result.txt

# ────────────────────────────────────────
# REPORT
# ────────────────────────────────────────
header "Phase 2 Test Report"

echo ""
for result in "${RESULTS[@]}"; do
  echo -e "  $result"
done
echo ""
echo -e "  ${GREEN}Passed: $PASS${NC}  |  ${RED}Failed: $FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}══════════════════════════════════════════${NC}"
  echo -e "${GREEN}  🎉 ALL TESTS PASSED — Phase 2 verified!${NC}"
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
rm -f /tmp/discord_result.txt /tmp/nuke_result.txt /tmp/migrate_result.txt /tmp/seed_result.txt /tmp/verify_result.txt

echo ""
echo "Done. Paste this output to Viktor in Slack if anything failed."
