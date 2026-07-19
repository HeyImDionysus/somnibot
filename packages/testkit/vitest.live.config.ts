import { defineConfig } from 'vitest/config';

/**
 * GATED live-stack lane for @somnibot/testkit.
 *
 * These tests boot the REAL SomniBot stack against a LOCAL disposable Supabase
 * (no Discord credentials) and drive a real DB-observable slash command through
 * the production dispatcher. They require:
 *   - a running local Supabase (http://127.0.0.1:54321), and
 *   - the loopback guard env (armed by the setup file below).
 *
 * Run:  npx supabase start && pnpm --filter @somnibot/testkit test:live
 *
 * Excluded from the default fast `vitest run` (see vitest.config.ts). If the
 * database is unreachable the runner throws — the suite FAILS LOUD, it never
 * silently passes. Mirrors @somnibot/bot's vitest.integration.config.ts.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/live/**/*.live.test.ts'],
    // Arms the loopback guard env BEFORE any live test module (and its bot
    // imports) load.
    setupFiles: ['src/__tests__/live/live-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Sequential single fork — the live tests share one local database.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
