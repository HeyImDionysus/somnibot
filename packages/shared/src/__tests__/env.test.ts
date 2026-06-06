import { describe, expect, it } from 'vitest';
import { DashboardEnvSchema } from '../validators/env';

const baseDashboardEnv = {
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  DISCORD_APPLICATION_ID: '123456789012345678',
  DISCORD_CLIENT_SECRET: 'discord-client-secret',
  CSRF_SECRET: 'csrf-secret-32chars-minimum-value',
  NEXTAUTH_SECRET: 'nextauth-secret-32chars-minimum-value',
  WEBHOOK_REPLAY_SECRET: 'webhook-replay-secret-32chars-minimum',
};

describe('DashboardEnvSchema', () => {
  it('accepts a dedicated webhook replay secret', () => {
    const result = DashboardEnvSchema.safeParse(baseDashboardEnv);

    expect(result.success).toBe(true);
  });

  it('requires a dedicated webhook replay secret', () => {
    const { WEBHOOK_REPLAY_SECRET: _unused, ...envWithoutReplaySecret } = baseDashboardEnv;

    const result = DashboardEnvSchema.safeParse(envWithoutReplaySecret);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['WEBHOOK_REPLAY_SECRET'],
            message: 'Required',
          }),
        ]),
      );
    }
  });
});
