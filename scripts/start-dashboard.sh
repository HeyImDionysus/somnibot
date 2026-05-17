#!/usr/bin/env bash
# ============================================================
# SomniBot — Start Dashboard Only
# Starts the Next.js dashboard in dev mode on port 3000.
# Press Ctrl+C to stop.
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║      SomniBot — Starting Dashboard       ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─── Preflight ───────────────────────────────────────────────
if [[ ! -f .env ]]; then
  echo "❌ No .env file found. Run ./scripts/setup.sh first."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "❌ Dependencies not installed. Run ./scripts/setup.sh first."
  exit 1
fi

# ─── Load .env ───────────────────────────────────────────────
set -a
source .env
set +a

# ─── Start dashboard ────────────────────────────────────────
echo "→ Starting dashboard on http://localhost:3000 ..."
echo "  (Press Ctrl+C to stop)"
echo ""

cd packages/dashboard
exec npx next dev --turbopack --port 3000
