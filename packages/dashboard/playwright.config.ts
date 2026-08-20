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

const startLocalServer = !process.env.CI || process.env.PLAYWRIGHT_START_SERVER === '1';
const authenticatedDashboardSpecs =
  /(?:channel-picker-accessibility|team-invitations|community-flow|commerce-onboarding|completed-project-licensing|licensing-product-overview|licensing-prompt-generator|settings-responsive|shared-foundations)\.spec\.ts/;

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
      testIgnore: authenticatedDashboardSpecs,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-local-launcher',
      testMatch: authenticatedDashboardSpecs,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.PLAYWRIGHT_LOCAL_BASE_URL ?? 'http://localhost:3001',
      },
    },
  ],

  // Start the dashboard dev server for local runs.
  // In CI, the server is started separately before tests run.
  ...(startLocalServer
    ? {
        webServer: [
          {
            command: 'corepack pnpm dev',
            env: {
              ...process.env,
              NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
              NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
              NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'playwright-placeholder-supabase-publishable-key',
              SUPABASE_SECRET_KEY: 'playwright-placeholder-supabase-secret-key',
              DISCORD_APPLICATION_ID: '123456789012345678',
              DISCORD_CLIENT_SECRET: 'discord-client-secret-playwright',
              CSRF_SECRET: 'csrf-secret-playwright-32chars-minimum',
              NEXTAUTH_SECRET: 'nextauth-secret-playwright-32chars-minimum',
              WEBHOOK_REPLAY_SECRET: 'webhook-replay-secret-playwright-32chars',
              NEXT_PUBLIC_DISABLE_REACT_DEVTOOLS: '1',
            },
            port: 3000,
            reuseExistingServer: true,
            timeout: 120_000,
          },
          {
            command: 'corepack pnpm exec next dev --turbopack -p 3001',
            env: {
              ...process.env,
              NEXT_PUBLIC_APP_URL: 'http://localhost:3001',
              NEXT_DIST_DIR: '.next-playwright-local',
              NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
              NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'playwright-placeholder-supabase-publishable-key',
              SUPABASE_SECRET_KEY: 'playwright-placeholder-supabase-secret-key',
              DISCORD_APPLICATION_ID: '123456789012345678',
              DISCORD_CLIENT_SECRET: 'discord-client-secret-playwright',
              CSRF_SECRET: 'csrf-secret-playwright-32chars-minimum',
              NEXTAUTH_SECRET: 'nextauth-secret-playwright-32chars-minimum',
              WEBHOOK_REPLAY_SECRET: 'webhook-replay-secret-playwright-32chars',
              SOMNIBOT_DASHBOARD_LOCAL_MODE: '1',
              SESSION_TOKEN: 'playwright-local-session-token',
              NEXT_PUBLIC_DISABLE_REACT_DEVTOOLS: '1',
            },
            port: 3001,
            reuseExistingServer: true,
            timeout: 120_000,
          },
        ],
      }
    : {}),
});
