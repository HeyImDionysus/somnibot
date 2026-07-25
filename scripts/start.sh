#!/usr/bin/env bash
# ============================================================
# SomniBot — Start Everything
# Starts Docker services, the bot, and the production dashboard.
# Press Ctrl+C to stop all processes.
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/lib/pnpm.sh
source "$REPO_ROOT/scripts/lib/pnpm.sh"

# Disable telemetry noise
export TURBO_TELEMETRY_DISABLED=1
export DO_NOT_TRACK=1

echo ""
echo "+==========================================+"
echo "|       SomniBot — Starting All Services   |"
echo "+==========================================+"
echo ""

# ─── Preflight checks ───────────────────────────────────────
if [[ ! -f .env ]]; then
  echo "❌ No .env file found. Run ./scripts/setup.sh first."
  exit 1
fi

if ! docker info &>/dev/null; then
  echo "❌ Docker is not running. Please start Docker Desktop first."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "❌ Dependencies not installed. Run ./scripts/setup.sh first."
  exit 1
fi

resolve_pnpm

# ─── Load .env ───────────────────────────────────────────────
set -a
source .env
set +a

export NODE_ENV=production
export NEXT_TELEMETRY_DISABLED=1
export TURBO_TELEMETRY_DISABLED=1
export DO_NOT_TRACK=1
export PORT="${PORT:-3000}"
export HOSTNAME="${HOSTNAME:-127.0.0.1}"

if [[ ! -d packages/bot/dist || ! -d packages/dashboard/.next/standalone || ! -d packages/dashboard/.next/static ]]; then
  echo "→ Production build artifacts are missing. Building..."
  "${PNPM_CMD[@]}" build
fi

# ─── Track child processes for cleanup ───────────────────────
PIDS=()

cleanup() {
  echo ""
  echo "→ Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait "${PIDS[@]}" 2>/dev/null || true
  echo "→ Stopping Docker services..."
  docker compose down 2>/dev/null || true
  echo "✅ All stopped."
}
trap cleanup EXIT INT TERM

# ─── Step 1: Start Docker services (Lavalink + Valkey) ───────
echo "→ Starting Docker services (Lavalink + Valkey)..."

# Report what Docker actually said. This used to run `docker compose up -d`
# without checking the result and then print "✅ Lavalink starting" either way,
# so a failed start was announced as a success and the operator only found out
# later, from music not working.
compose_output="$(docker compose up -d 2>&1)"
compose_status=$?

if [[ $compose_status -ne 0 ]]; then
  echo "  ❌ Docker could not start the services:"
  echo "$compose_output" | sed 's/^/     /'

  # The most common real cause, and the least obvious: container_name is pinned
  # in docker-compose.yml, so a second checkout of the repo collides with the
  # containers the first one created. "Check Docker Desktop is running" sent
  # people looking in entirely the wrong place.
  if echo "$compose_output" | grep -qi "container name .* is already in use"; then
    conflicting="$(echo "$compose_output" | grep -oiE '/somni-[a-z-]+' | head -1 | tr -d '/')"
    owner="$(docker inspect "$conflicting" \
      --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null)"
    echo ""
    echo "  This is a name clash, not a Docker problem. '$conflicting' already"
    echo "  exists${owner:+, created by the checkout at: $owner}."
    echo ""
    echo "  Either start SomniBot from that directory, or free the name with:"
    echo "      docker rm -f $conflicting"
  fi
  exit 1
fi

echo "  ✅ Lavalink starting on port 2333"
echo "  ✅ Valkey starting on port 6379"
echo ""

# Wait for Lavalink to be ready (it takes a few seconds to boot Java)
echo "→ Waiting for Lavalink to be ready..."
for i in {1..30}; do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:2333/version 2>/dev/null | grep -q "200\|401"; then
    echo "  ✅ Lavalink is ready"
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "  ⚠️  Lavalink may still be starting. Continuing anyway..."
  fi
  sleep 2
done
echo ""

# ─── Step 2: Start the bot ──────────────────────────────────
echo "→ Starting the bot..."
node packages/bot/dist/index.js &
PIDS+=($!)
BOT_PID=$!
echo "  ✅ Bot started (PID: $BOT_PID)"
echo ""

# ─── Step 3: Start the production dashboard ─────────────────
echo "→ Preparing dashboard standalone runtime assets..."
node scripts/prepare-dashboard-standalone.mjs
echo "→ Starting the production dashboard..."
node packages/dashboard/.next/standalone/packages/dashboard/server.js &
PIDS+=($!)
DASH_PID=$!
echo "  ✅ Dashboard starting on http://localhost:${PORT} (PID: $DASH_PID)"
echo ""

# ─── Running ─────────────────────────────────────────────────
echo "+==========================================+"
echo "|          ✅ Everything is running!        |"
echo "+==========================================+"
echo ""
echo "  🤖 Bot:        Running (check this terminal for logs)"
echo "  🌐 Dashboard:  http://localhost:${PORT}"
echo "  🎵 Lavalink:   http://localhost:2333"
echo "  📦 Valkey:     redis://localhost:6379"
echo ""
echo "  Press Ctrl+C to stop everything."
echo ""
echo "─── Bot logs ────────────────────────────────────────────"
echo ""

# Wait for any process to exit
wait -n "${PIDS[@]}" 2>/dev/null || true
