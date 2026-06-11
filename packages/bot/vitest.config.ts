import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['src/__tests__/integration/**'],
    testTimeout: 10_000,
    // V5 Audit §13.3: Removed retry:1. Masking flaky tests prevents root-cause
    // fixes. Tests should be deterministic — mock external dependencies properly
    // instead of retrying on failure.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**', 'src/index.ts'],
    },
  },
});
