#!/usr/bin/env bash
# ============================================================
# SomniBot — Stop Everything
# Stops Docker services and any running bot/dashboard processes.
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo ""
echo "→ Stopping SomniBot..."

# Stop Docker services
echo "  → Stopping Lavalink + Valkey..."
docker compose down 2>/dev/null && echo "  ✅ Docker services stopped" || echo "  ⚠️  Docker services were not running"

# Kill any running bot processes
BOT_PIDS=$(pgrep -f "packages/bot/dist/index" 2>/dev/null || true)
if [[ -n "$BOT_PIDS" ]]; then
  echo "  → Stopping bot (PID: $BOT_PIDS)..."
  echo "$BOT_PIDS" | xargs kill 2>/dev/null || true
  echo "  ✅ Bot stopped"
else
  echo "  ⚠️  Bot was not running"
fi

# Kill any running dashboard processes
DASH_PIDS=$(pgrep -f "next dev.*--port 3000|packages/dashboard/.next/standalone/packages/dashboard/server.js|packages/dashboard/server.js" 2>/dev/null || true)
if [[ -n "$DASH_PIDS" ]]; then
  echo "  → Stopping dashboard (PID: $DASH_PIDS)..."
  echo "$DASH_PIDS" | xargs kill 2>/dev/null || true
  echo "  ✅ Dashboard stopped"
else
  echo "  ⚠️  Dashboard was not running"
fi

echo ""
echo "✅ Everything stopped."
echo ""
