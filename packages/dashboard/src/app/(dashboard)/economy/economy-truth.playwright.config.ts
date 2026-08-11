import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /economy-truth\.spec\.ts/,
  workers: 1,
  reporter: 'line',
  timeout: 120_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:3012',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'corepack pnpm --filter @somnibot/shared build && corepack pnpm exec next dev --turbopack -p 3012',
    cwd: '../../../..',
    env: {
      ...process.env,
      NEXT_PUBLIC_APP_URL: 'http://localhost:3012',
      NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'playwright-placeholder-supabase-publishable-key',
      SUPABASE_SECRET_KEY: 'playwright-placeholder-supabase-secret-key',
      DISCORD_APPLICATION_ID: '123456789012345678',
      DISCORD_CLIENT_SECRET: 'discord-client-secret-playwright',
      CSRF_SECRET: 'csrf-secret-playwright-32chars-minimum',
      NEXTAUTH_SECRET: 'nextauth-secret-playwright-32chars-minimum',
      WEBHOOK_REPLAY_SECRET: 'webhook-replay-secret-playwright-32chars',
      SOMNIBOT_DASHBOARD_LOCAL_MODE: '1',
      SESSION_TOKEN: 'economy-truth-playwright-session',
    },
    port: 3012,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
