# ============================================================
# SomniBot — Dashboard Dockerfile (multi-stage)
# Builds the Next.js dashboard for self-hosting
# ============================================================

# --- Stage 1: Install & Build ---
# V7 Audit §9.P3a — switched from alpine to slim for better native module
# compatibility (e.g., bcrypt, sharp, canvas) and glibc support.
FROM node:22.16-slim AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./

# Copy package manifests
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/dashboard/package.json packages/dashboard/tsconfig.json ./packages/dashboard/

# Copy source code
COPY packages/shared/src ./packages/shared/src
COPY packages/dashboard/src ./packages/dashboard/src
COPY packages/dashboard/tailwind.config.ts ./packages/dashboard/
COPY packages/dashboard/postcss.config.mjs ./packages/dashboard/
COPY packages/dashboard/next.config.ts ./packages/dashboard/
COPY packages/dashboard/public ./packages/dashboard/public

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Build (shared first via turbo)
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" \
    || (echo "ERROR: NEXT_PUBLIC_SUPABASE_URL build arg is required for dashboard browser config" && exit 1)
RUN test -n "$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" \
    || (echo "ERROR: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY build arg is required for dashboard browser config" && exit 1)
RUN pnpm turbo build --filter=@somnibot/dashboard

# V11 Audit L-5: Verify standalone output exists before pruning/copying.
# If next.config.ts output:'standalone' is missing or the build fails silently,
# this gives a clear error message instead of a cryptic COPY failure later.
RUN test -d /app/packages/dashboard/.next/standalone \
    || (echo "ERROR: standalone output not found — check next.config.ts output:'standalone'" && exit 1)

# V5 Audit §9.P3a: Prune devDependencies before copying to runtime stage.
# Consistent with bot Dockerfile — reduces image size and attack surface.
RUN pnpm prune --prod

# --- Stage 2: Production Runtime ---
FROM node:22.16-slim AS runtime

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy standalone output
COPY --from=builder /app/packages/dashboard/.next/standalone ./
COPY --from=builder /app/packages/dashboard/.next/static ./packages/dashboard/.next/static
COPY --from=builder /app/packages/dashboard/public ./packages/dashboard/public

# Non-root user
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
USER nextjs

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "packages/dashboard/server.js"]
