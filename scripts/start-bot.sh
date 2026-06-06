#!/usr/bin/env bash
# ============================================================
# SomniBot — Start Bot Only
# Starts Docker services + the bot (no dashboard).
# Press Ctrl+C to stop.
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/lib/pnpm.sh
source "$REPO_ROOT/scripts/lib/pnpm.sh"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║        SomniBot — Starting Bot           ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─── Preflight ───────────────────────────────────────────────
if [[ ! -f .env ]]; then
  echo "❌ No .env file found. Run ./scripts/setup.sh first."
  exit 1
fi

if ! docker info &>/dev/null; then
  echo "❌ Docker is not running. Please start Docker Desktop first."
  exit 1
fi

if [[ ! -d packages/bot/dist ]]; then
  echo "→ Bot not built yet. Building..."
  resolve_pnpm
  "${PNPM_CMD[@]}" build
fi

# ─── Load .env ───────────────────────────────────────────────
set -a
source .env
set +a

# ─── Start Docker services ──────────────────────────────────
echo "→ Starting Docker services (Lavalink + Valkey)..."
docker compose up -d
echo "  ✅ Docker services started"
echo ""

# Wait for Lavalink
echo "→ Waiting for Lavalink..."
for i in {1..30}; do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:2333/version 2>/dev/null | grep -q "200\|401"; then
    echo "  ✅ Lavalink ready"
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "  ⚠️  Lavalink may still be starting..."
  fi
  sleep 2
done
echo ""

# ─── Start the bot ──────────────────────────────────────────
echo "→ Starting bot..."
echo ""
echo "─── Bot logs ────────────────────────────────────────────"
echo ""

exec node packages/bot/dist/index.js
