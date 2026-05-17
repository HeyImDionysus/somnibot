#!/usr/bin/env bash
# ============================================================
# SomniBot — First-Time Setup
# Run this once after cloning the repo.
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║         SomniBot — First-Time Setup      ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─── Check prerequisites ────────────────────────────────────
echo "→ Checking prerequisites..."

missing=()

if ! command -v node &>/dev/null; then
  missing+=("Node.js 22+ (https://nodejs.org)")
elif [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 22 ]]; then
  missing+=("Node.js 22+ (you have $(node -v), need v22+)")
fi

if ! command -v pnpm &>/dev/null; then
  missing+=("pnpm (run: corepack enable && corepack prepare pnpm@9 --activate)")
fi

if ! command -v docker &>/dev/null; then
  missing+=("Docker Desktop (https://docker.com/get-started)")
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  echo ""
  echo "❌ Missing prerequisites:"
  for item in "${missing[@]}"; do
    echo "   • $item"
  done
  echo ""
  echo "Install the above and run this script again."
  exit 1
fi

echo "  ✅ Node.js $(node -v)"
echo "  ✅ pnpm $(pnpm -v)"
echo "  ✅ Docker $(docker --version | sed 's/Docker version //' | cut -d, -f1)"
echo ""

# ─── Create .env file ───────────────────────────────────────
if [[ ! -f .env ]]; then
  echo "→ Creating .env from .env.example..."
  cp .env.example .env
  echo "  ✅ Created .env"
  echo ""
  echo "  ⚠️  IMPORTANT: Open .env in a text editor and fill in your values."
  echo "     At minimum you need:"
  echo "       DISCORD_TOKEN          — from Discord Developer Portal → Bot → Token"
  echo "       DISCORD_APPLICATION_ID — from Discord Developer Portal → OAuth2 → Client ID"
  echo "       DISCORD_CLIENT_SECRET  — from Discord Developer Portal → OAuth2 → Client Secret"
  echo "       SUPABASE_URL           — from Supabase → Settings → API → Project URL"
  echo "       SUPABASE_SERVICE_ROLE_KEY — from Supabase → Settings → API → service_role key"
  echo ""
  echo "     The .env file is at: $REPO_ROOT/.env"
  echo ""
else
  echo "→ .env already exists, skipping."
fi

# ─── Install dependencies ───────────────────────────────────
echo "→ Installing dependencies (this may take a minute)..."
pnpm install
echo "  ✅ Dependencies installed"
echo ""

# ─── Build all packages ─────────────────────────────────────
echo "→ Building all packages (shared → bot → dashboard)..."
pnpm build
echo "  ✅ Build complete"
echo ""

# ─── Done ────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════╗"
echo "║            ✅ Setup Complete!             ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Fill in your .env file (if you haven't already)"
echo "  2. Run: ./scripts/start.sh"
echo ""
