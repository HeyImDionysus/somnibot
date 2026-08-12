import { defineConfig } from 'vitest/config';

/**
 * Vitest config for integration tests.
 *
 * V5 Audit Fix #2 — These tests run against a real Supabase local instance.
 * No mocks. Real DB, real RLS policies, real RPCs.
 *
 * Run locally:  npx supabase start && pnpm --filter @somnibot/bot test:integration
 * Run in CI:    See .github/workflows/ci.yml integration-test job
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/integration/**/*.integration.test.ts'],
    setupFiles: ['./src/__tests__/integration/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Run sequentially — integration tests share a DB
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
