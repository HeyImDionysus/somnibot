# ============================================================
# SomniBot — Bot Dockerfile (multi-stage)
# Builds the TypeScript bot with pnpm, runs it with Bun
# ============================================================

# --- Stage 1: Install & Build ---
# FIX #13: Use node:22-slim (glibc) instead of node:22-alpine (musl)
# to match the glibc-based oven/bun:1-slim runtime. Native addons
# compiled for musl (e.g. @napi-rs/canvas) crash on glibc runtime.
FROM node:22-slim AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./

# Copy package manifests for all workspace packages
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/bot/package.json packages/bot/tsconfig.json ./packages/bot/

# Copy source code
COPY packages/shared/src ./packages/shared/src
COPY packages/bot/src ./packages/bot/src

# Install dependencies with pnpm (deterministic via lockfile)
RUN pnpm install --frozen-lockfile

# Build shared first (bot depends on it)
RUN pnpm --filter @somnibot/shared build
RUN pnpm --filter @somnibot/bot build

# --- Stage 2: Production Runtime ---
FROM oven/bun:1-slim AS runtime

WORKDIR /app

# Copy workspace root (needed for workspace resolution)
COPY package.json pnpm-workspace.yaml ./

# Copy built shared package
COPY packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

# Copy built bot package
COPY packages/bot/package.json ./packages/bot/
COPY --from=builder /app/packages/bot/dist ./packages/bot/dist

# Copy migration files (for auto-migration on first boot)
COPY packages/supabase/migrations ./packages/supabase/migrations

# Copy node_modules from builder (already resolved by pnpm)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/bot/node_modules ./packages/bot/node_modules
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules

# Non-root user for security
USER bun

ENV NODE_ENV=production

# Entry point
CMD ["bun", "run", "packages/bot/dist/index.js"]
