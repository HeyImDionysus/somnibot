import { defineConfig, configDefaults } from 'vitest/config';

/**
 * DEFAULT fast unit lane for @somnibot/testkit.
 *
 * Runs the in-process, no-DB tests (guard, capability, injector registry,
 * routing parity). It MUST NOT boot the live stack: the live suite talks to a
 * real local Supabase and is excluded here, mirroring how @somnibot/bot keeps
 * its integration tests out of the fast `vitest run` (vitest.config.ts vs
 * vitest.integration.config.ts). The live lane runs via vitest.live.config.ts
 * (`pnpm --filter @somnibot/testkit test:live`).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Keep vitest's standard excludes, then also drop the live-stack suite so a
    // plain `vitest run` never tries to reach Supabase.
    exclude: [...configDefaults.exclude, 'src/__tests__/live/**'],
  },
});
