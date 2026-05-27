import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/__tests__/integration/**'],
    testTimeout: 10_000,
    // V5 Audit §13.6: Retry flaky tests once before failing.
    // Catches transient timing issues (Valkey reconnects, slow CI runners)
    // without masking genuine regressions.
    retry: 1,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**', 'src/index.ts'],
    },
  },
});
