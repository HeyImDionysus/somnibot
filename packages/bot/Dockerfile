# ============================================================
# SomniBot — Bot Dockerfile (multi-stage)
# Builds the TypeScript bot with pnpm, runs it with Node
# ============================================================

# --- Stage 1: Install & Build ---
# Uses node:22-slim (glibc) — must match the runtime stage base
# so native addons (e.g. @napi-rs/canvas) are ABI-compatible.
FROM node:22.16-slim AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY patches ./patches

# Copy package manifests for all workspace packages
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/bot/package.json packages/bot/tsconfig.json ./packages/bot/

# Copy source code
COPY packages/shared/src ./packages/shared/src
COPY packages/bot/src ./packages/bot/src
COPY packages/supabase/migrations ./packages/supabase/migrations
COPY scripts/clean.mjs scripts/smoke-built-bot-migration-runner.mjs ./scripts/

# Install dependencies with pnpm (deterministic via lockfile)
RUN pnpm install --frozen-lockfile

# Build shared first (bot depends on it)
RUN pnpm --filter @somnibot/shared build
RUN pnpm --filter @somnibot/bot build

# V5 Audit [9.2]: Prune devDependencies before copying to runtime stage.
# Reduces image size and attack surface by excluding test/build-only deps.
RUN pnpm prune --prod

# --- Stage 2: Production Runtime ---
# Uses the same Node base as the builder so pnpm's node_modules layout
# (symlinks into .pnpm store) resolves correctly and native addons
# compiled against glibc work without cross-runtime surprises.
FROM node:22.16-slim AS runtime

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
# V8 Audit §9.P3a: Read-only to limit exposure; only migration-runner reads them
# Directories need +x (search bit) for readdirSync; files are read-only 444
COPY packages/supabase/migrations ./packages/supabase/migrations
RUN find ./packages/supabase/migrations -type d -exec chmod 555 {} + \
 && find ./packages/supabase/migrations -type f -exec chmod 444 {} +

# Copy node_modules from builder (already resolved by pnpm)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/bot/node_modules ./packages/bot/node_modules
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules

# V5 Audit §9.P3a: Create non-root user explicitly instead of relying
# on the base image's default user. Ensures consistent UID across updates.
RUN addgroup --system --gid 1001 somni && \
    adduser --system --uid 1001 --ingroup somni somni && \
    chown -R somni:somni /app
USER somni

ENV NODE_ENV=production

# Health server binds to HEALTH_PORT, PORT (hosted platform), or 3001.
# In Docker standalone, default to 3001 so the port is predictable.
ENV HEALTH_PORT=3001
EXPOSE 3001

# Entry point
CMD ["node", "packages/bot/dist/index.js"]
