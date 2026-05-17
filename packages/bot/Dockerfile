# ============================================================
# SomniBot — Bot Dockerfile (multi-stage)
# Builds the TypeScript bot and runs it with Bun
# ============================================================

# --- Stage 1: Install & Build ---
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./

# Copy package manifests for all workspace packages
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/bot/package.json packages/bot/tsconfig.json ./packages/bot/

# Copy source code
COPY packages/shared/src ./packages/shared/src
COPY packages/bot/src ./packages/bot/src

# Install dependencies with bun (reads workspace structure)
RUN bun install --frozen-lockfile || bun install

# Build shared first (bot depends on it)
RUN cd packages/shared && bun x tsc
RUN cd packages/bot && bun x tsc

# --- Stage 2: Production Runtime ---
FROM oven/bun:1-slim AS runtime

WORKDIR /app

# Copy workspace root
COPY package.json pnpm-workspace.yaml ./

# Copy built shared package
COPY packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

# Copy built bot package
COPY packages/bot/package.json ./packages/bot/
COPY --from=builder /app/packages/bot/dist ./packages/bot/dist

# Copy migration files (for auto-migration on first boot)
COPY packages/supabase/migrations ./packages/supabase/migrations

# Install production dependencies only
RUN bun install --production --frozen-lockfile || bun install --production

# Non-root user for security
USER bun

ENV NODE_ENV=production

# Entry point
CMD ["bun", "run", "packages/bot/dist/index.js"]
