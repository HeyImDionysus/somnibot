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
docker compose up -d

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
