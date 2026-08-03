import { describe, expect, it, vi } from 'vitest';
import type { LauncherConfig } from '../main/config-store.js';
import {
  needsCloudCredentialRestore,
  restoreMissingCredentialsOnStartup,
} from '../main/credential-bootstrap.js';

function config(overrides: Partial<LauncherConfig> = {}): LauncherConfig {
  return {
    discordToken: 'local-discord-token',
    discordApplicationId: 'local-app-id',
    discordClientSecret: 'local-client-secret',
    discordGuildId: 'local-guild',
    guilds: [],
    supabaseUrl: 'https://project.supabase.co',
    supabaseSecretKey: 'local-secret-key',
    supabasePublishableKey: 'local-publishable-key',
    supabaseDbPassword: 'local-db-password',
    supabaseAccessToken: 'local-access-token',
    supabaseDiscordAuthProviderConfigured: false,
    paypalClientId: 'local-paypal-client',
    paypalClientSecret: 'local-paypal-secret',
    paypalWebhookId: 'local-webhook',
    paypalWebhookProofKey: 'local-webhook-proof',
    paypalSandbox: true,
    runtimeMode: 'regular-local',
    publicCallbackBaseUrl: 'https://local.tailnet.ts.net',
    vpsDomain: 'somnibot.example.com',
    vpsSshHost: '203.0.113.10',
    vpsSshUser: 'somnibot',
    vpsDeployPath: '/opt/somnibot',
    tailscaleAuthKey: 'local-tailscale-auth-key',
    vpsCsrfSecret: 'local-vps-csrf',
    vpsNextAuthSecret: 'local-vps-nextauth',
    vpsWebhookReplaySecret: 'local-vps-replay',
    vpsValkeyPassword: 'local-vps-valkey',
    vpsLavalinkPassword: 'local-vps-lavalink',
    firstRunComplete: false,
    lavalinkEnabled: false,
    lastPids: { bot: null, dashboard: null, lavalink: null, valkey: null },
    ...overrides,
  };
}

const validDiscord = vi.fn().mockResolvedValue({ ok: true });

describe('startup credential bootstrap', () => {
  it('skips cloud access when the bootstrap identity is absent', async () => {
    const pull = vi.fn();
    const result = await restoreMissingCredentialsOnStartup(
      config({ supabaseSecretKey: '', paypalClientSecret: '' }),
      pull,
      validDiscord,
    );

    expect(result).toEqual({ attempted: false, patch: {}, restoredFields: [] });
    expect(pull).not.toHaveBeenCalled();
  });

  it('skips cloud access when all core connection fields are already present', async () => {
    const pull = vi.fn();
    expect(needsCloudCredentialRestore(config())).toBe(false);

    const result = await restoreMissingCredentialsOnStartup(config(), pull, validDiscord);

    expect(result.attempted).toBe(false);
    expect(pull).not.toHaveBeenCalled();
  });

  it('restores only missing values and never overwrites established local credentials', async () => {
    const current = config({
      supabaseDbPassword: '',
      paypalClientId: '',
      paypalClientSecret: '',
      paypalWebhookId: '',
    });
    const pull = vi.fn().mockResolvedValue({
      ok: true,
      credentials: {
        discordToken: 'older-cloud-discord-token',
        supabaseDbPassword: 'cloud-db-password',
        paypalClientId: 'cloud-paypal-client',
        paypalClientSecret: 'cloud-paypal-secret',
        paypalWebhookId: 'cloud-webhook',
      },
    });

    const result = await restoreMissingCredentialsOnStartup(current, pull, validDiscord);

    expect(pull).toHaveBeenCalledWith(current.supabaseUrl, current.supabaseSecretKey);
    expect(result.patch).toEqual({
      supabaseDbPassword: 'cloud-db-password',
      paypalClientId: 'cloud-paypal-client',
      paypalClientSecret: 'cloud-paypal-secret',
      paypalWebhookId: 'cloud-webhook',
    });
    expect(result.patch).not.toHaveProperty('discordToken');
  });

  it('surfaces a failed restore without changing local state', async () => {
    const result = await restoreMissingCredentialsOnStartup(
      config({ paypalClientSecret: '' }),
      vi.fn().mockResolvedValue({ ok: false, error: 'offline' }),
      validDiscord,
    );

    expect(result).toEqual({
      attempted: true,
      patch: {},
      restoredFields: [],
      error: 'offline',
    });
  });

  it('replaces a definitively rejected local token with a different valid cloud token', async () => {
    const current = config();
    const validate = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'invalid', error: 'rejected' })
      .mockResolvedValueOnce({ ok: true });
    const pull = vi.fn().mockResolvedValue({
      ok: true,
      credentials: { discordToken: 'new-cloud-discord-token' },
    });

    const result = await restoreMissingCredentialsOnStartup(current, pull, validate);

    expect(result).toEqual({
      attempted: true,
      patch: { discordToken: 'new-cloud-discord-token' },
      restoredFields: ['discordToken'],
    });
  });

  it('preserves a rejected local token when no different cloud credential exists', async () => {
    const current = config();
    const result = await restoreMissingCredentialsOnStartup(
      current,
      vi.fn().mockResolvedValue({ ok: true, credentials: { paypalClientId: 'cloud-paypal' } }),
      vi.fn().mockResolvedValue({ ok: false, code: 'invalid', error: 'rejected' }),
    );

    expect(result.patch).toEqual({});
    expect(result.restoredFields).toEqual([]);
    expect(result.error).toMatch(/no different cloud token/i);
  });

  it('does not replace a local token when Discord validation is temporarily unavailable', async () => {
    const pull = vi.fn();
    const result = await restoreMissingCredentialsOnStartup(
      config(),
      pull,
      vi.fn().mockResolvedValue({ ok: false, code: 'unavailable', error: 'offline' }),
    );

    expect(result).toEqual({ attempted: false, patch: {}, restoredFields: [] });
    expect(pull).not.toHaveBeenCalled();
  });
});
