/**
 * V5-Audit §13.1 — Playwright E2E test configuration.
 *
 * Runs end-to-end tests against the dashboard in a real browser.
 * Start the dev server first: pnpm --filter @somnibot/dashboard dev
 *
 * Usage:
 *   pnpm --filter @somnibot/dashboard test:e2e
 *   pnpm --filter @somnibot/dashboard test:e2e --headed  (visible browser)
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'html',
  timeout: 30_000,

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Start the dashboard dev server for local runs.
  // In CI, the server is started separately before tests run.
  ...(process.env.CI
    ? {}
    : {
        webServer: {
          command: 'pnpm dev',
          port: 3000,
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }),
});
