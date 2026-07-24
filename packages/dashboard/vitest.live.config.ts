/**
 * Dashboard LIVE lane — real-session dashboard-route driving against LOCAL
 * Supabase (owner decision 2026-07-24: fidelity over convenience, ZERO
 * production auth edits). Runs ONLY in the Live-Stack E2E job (which boots
 * local Supabase); the plain Unit (Dashboard) job excludes src/__tests__/live/**.
 *
 * Reuses the base config's in-process-TS plugin + @ alias so a route handler
 * (and its @/ imports + next/server) transpiles the same way as the unit lane.
 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { configDir, useInProcessTypeScript, inProcessTypeScriptPlugin } from './vitest.config';

export default defineConfig({
  esbuild: useInProcessTypeScript ? false : undefined,
  plugins: useInProcessTypeScript ? [inProcessTypeScriptPlugin] : undefined,
  test: {
    environment: 'node',
    globals: true,
    include: ['src/__tests__/live/**/*.live.test.ts'],
    // Live tests boot real infra; keep them serial so shared Supabase state and
    // the module-level next/headers mock don't race across files.
    fileParallelism: false,
  },
  resolve: {
    preserveSymlinks: useInProcessTypeScript,
    alias: {
      '@': path.resolve(configDir, 'src'),
    },
  },
});
