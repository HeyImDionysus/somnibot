import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/smoke/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 10_000,
  },
});
