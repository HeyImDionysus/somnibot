#!/usr/bin/env bash
# ============================================================
# SomniBot — Rebuild
# Pulls latest code, reinstalls deps, and rebuilds everything.
# Run this after pulling updates from GitHub.
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/lib/pnpm.sh
source "$REPO_ROOT/scripts/lib/pnpm.sh"
resolve_pnpm

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║        SomniBot — Rebuilding             ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─── Pull latest ─────────────────────────────────────────────
echo "→ Pulling latest code from GitHub..."
git pull origin main
echo "  ✅ Code updated"
echo ""

# ─── Clean old builds ───────────────────────────────────────
echo "→ Cleaning old builds..."
rm -rf packages/shared/dist packages/bot/dist packages/dashboard/.next
echo "  ✅ Cleaned"
echo ""

# ─── Reinstall dependencies ─────────────────────────────────
echo "→ Installing dependencies..."
"${PNPM_CMD[@]}" install
echo "  ✅ Dependencies installed"
echo ""

# ─── Rebuild ─────────────────────────────────────────────────
echo "→ Building all packages..."
"${PNPM_CMD[@]}" build
echo "  ✅ Build complete"
echo ""

echo "╔══════════════════════════════════════════╗"
echo "║          ✅ Rebuild Complete!             ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Run: ./scripts/start.sh"
echo ""
