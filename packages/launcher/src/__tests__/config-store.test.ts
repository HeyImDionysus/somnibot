/**
 * V5 Audit §13.P3b — Launcher unit tests for config-store logic.
 *
 * Tests config validation plus the production IPC masking and save filtering.
 */

import { describe, it, expect } from 'vitest';
import { buildDbUrlEnv } from '../main/supabase-db-url.js';
import {
  MASKED_SECRET,
  maskConfigSecrets,
  sanitizeConfigPatchForStorage,
} from '../main/config-bridge.js';

// The config shape from config-store.ts (replicated here since the
// module imports electron-store which isn't available outside Electron).
const REQUIRED_FOR_LAUNCH = [
  'discordToken',
  'supabaseUrl',
  'supabaseSecretKey',
] as const;

interface LauncherConfig {
  discordToken: string;
  discordApplicationId: string;
  discordClientSecret: string;
  discordGuildId: string;
  supabaseUrl: string;
  supabaseSecretKey: string;
  supabasePublishableKey: string;
  supabaseDbPassword: string;
  supabaseAccessToken: string;
  supabaseDiscordAuthProviderConfigured: boolean;
  paypalClientId: string;
  paypalClientSecret: string;
  paypalWebhookId: string;
  paypalSandbox: boolean;
  runtimeMode: 'regular-local' | 'vps';
  publicCallbackBaseUrl: string;
  vpsDomain: string;
  vpsSshHost: string;
  vpsSshUser: string;
  vpsDeployPath: string;
  tailscaleAuthKey?: string;
  lavalinkEnabled: boolean;
}

function isReadyToLaunch(config: LauncherConfig): boolean {
  return REQUIRED_FOR_LAUNCH.every((key) => {
    const val = config[key as keyof LauncherConfig];
    return typeof val === 'string' && val.length > 0;
  });
}

describe('Launcher Config', () => {
  const validConfig: LauncherConfig = {
    discordToken: 'my-token',
    discordApplicationId: '12345',
    discordClientSecret: 'secret123',
    discordGuildId: '67890',
    supabaseUrl: 'https://my-project.supabase.co',
    supabaseSecretKey: 'eyJhbGciOiJIUzI1NiJ9',
    supabasePublishableKey: 'eyJhbGciOiJIUzI1NiJ9.pub',
    supabaseDbPassword: 'database-password',
    supabaseAccessToken: 'sbp-access-token',
    supabaseDiscordAuthProviderConfigured: false,
    paypalClientId: 'paypal-client-id',
    paypalClientSecret: 'paypal-client-secret',
    paypalWebhookId: 'paypal-webhook-id',
    paypalSandbox: true,
    runtimeMode: 'regular-local',
    publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
    vpsDomain: '',
    vpsSshHost: '',
    vpsSshUser: '',
    vpsDeployPath: '',
    tailscaleAuthKey: 'tskey-auth-secret',
    lavalinkEnabled: true,
  };

  it('builds a direct session-capable Supabase database URL for migration locks', () => {
    expect(buildDbUrlEnv(
      'https://runnerproof.supabase.co',
      'p@ss word',
    )).toEqual({
      SUPABASE_DB_URL:
        'postgresql://postgres:p%40ss%20word@db.runnerproof.supabase.co:5432/postgres',
    });
  });

  it('does not synthesize a database URL without both a project ref and password', () => {
    expect(buildDbUrlEnv('https://example.com', 'secret')).toEqual({});
    expect(buildDbUrlEnv('https://runnerproof.supabase.co.evil.example', 'secret'))
      .toEqual({});
    expect(buildDbUrlEnv('http://runnerproof.supabase.co', 'secret')).toEqual({});
    expect(buildDbUrlEnv('https://runnerproof.supabase.co', '')).toEqual({});
  });

  it('detects ready-to-launch config', () => {
    expect(isReadyToLaunch(validConfig)).toBe(true);
  });

  it('rejects config missing discordToken', () => {
    expect(isReadyToLaunch({ ...validConfig, discordToken: '' })).toBe(false);
  });

  it('rejects config missing supabaseUrl', () => {
    expect(isReadyToLaunch({ ...validConfig, supabaseUrl: '' })).toBe(false);
  });

  it('rejects config missing supabaseSecretKey', () => {
    expect(isReadyToLaunch({ ...validConfig, supabaseSecretKey: '' })).toBe(false);
  });

  it('masks sensitive fields for display', () => {
    const masked = maskConfigSecrets(validConfig);
    expect(masked.discordToken).toBe(MASKED_SECRET);
    expect(masked.discordClientSecret).toBe(MASKED_SECRET);
    expect(masked.supabaseSecretKey).toBe(MASKED_SECRET);
    expect(masked.supabaseDbPassword).toBe(MASKED_SECRET);
    expect(masked.supabaseAccessToken).toBe(MASKED_SECRET);
    expect(masked.paypalClientSecret).toBe(MASKED_SECRET);
    expect(masked.paypalWebhookId).toBe(MASKED_SECRET);
    expect(masked.tailscaleAuthKey).toBe(MASKED_SECRET);
    // Non-sensitive fields are preserved
    expect(masked.supabaseUrl).toBe(validConfig.supabaseUrl);
    expect(masked.discordGuildId).toBe(validConfig.discordGuildId);
    expect(masked.publicCallbackBaseUrl).toBe(validConfig.publicCallbackBaseUrl);
  });

  it('does not mask empty sensitive fields', () => {
    const emptyConfig = { ...validConfig, discordToken: '', discordClientSecret: '' };
    const masked = maskConfigSecrets(emptyConfig);
    expect(masked.discordToken).toBe('');
    expect(masked.discordClientSecret).toBe('');
  });

  it('strips mask placeholders before save so real secrets are preserved', () => {
    // Simulate what happens: renderer sends back masked values from get-config
    const fromRenderer: Partial<LauncherConfig> = {
      discordToken: MASKED_SECRET,
      discordApplicationId: '12345',
      discordClientSecret: MASKED_SECRET,
      discordGuildId: '67890-new',
      supabaseUrl: 'https://updated.supabase.co',
      supabaseSecretKey: MASKED_SECRET,
      supabaseDbPassword: MASKED_SECRET,
      supabaseAccessToken: MASKED_SECRET,
      paypalClientId: 'paypal-client-id-new',
      paypalClientSecret: MASKED_SECRET,
      paypalWebhookId: MASKED_SECRET,
      paypalSandbox: false,
      tailscaleAuthKey: MASKED_SECRET,
      supabasePublishableKey: 'new-pub-key',
      supabaseDiscordAuthProviderConfigured: true,
      runtimeMode: 'vps',
      vpsDomain: 'somnibot.example.com',
      lastPids: { bot: 1234, dashboard: 5678, lavalink: 9012, valkey: 3456 },
    };

    const sanitized = sanitizeConfigPatchForStorage(fromRenderer);

    // Masked fields should be stripped (not saved, so store keeps the real value)
    expect(sanitized).not.toHaveProperty('discordToken');
    expect(sanitized).not.toHaveProperty('discordClientSecret');
    expect(sanitized).not.toHaveProperty('supabaseSecretKey');
    expect(sanitized).not.toHaveProperty('supabaseDbPassword');
    expect(sanitized).not.toHaveProperty('supabaseAccessToken');
    expect(sanitized).not.toHaveProperty('paypalClientSecret');
    expect(sanitized).not.toHaveProperty('paypalWebhookId');
    expect(sanitized).not.toHaveProperty('tailscaleAuthKey');

    // Non-masked fields are preserved
    expect(sanitized.discordApplicationId).toBe('12345');
    expect(sanitized.discordGuildId).toBe('67890-new');
    expect(sanitized.supabaseUrl).toBe('https://updated.supabase.co');
    expect(sanitized.supabasePublishableKey).toBe('new-pub-key');
    expect(sanitized.supabaseDiscordAuthProviderConfigured).toBe(true);
    expect(sanitized.paypalClientId).toBe('paypal-client-id-new');
    expect(sanitized.paypalSandbox).toBe(false);
    expect(sanitized.runtimeMode).toBe('vps');
    expect(sanitized.vpsDomain).toBe('somnibot.example.com');
    expect(sanitized).not.toHaveProperty('lastPids');
  });

  it('preserves real values when user enters a new secret (not the mask)', () => {
    const fromRenderer: Partial<LauncherConfig> = {
      discordToken: 'brand-new-token',
      supabaseSecretKey: 'brand-new-secret',
      supabaseDbPassword: 'brand-new-db-password',
      supabaseAccessToken: 'brand-new-access-token',
      paypalClientSecret: 'brand-new-paypal-secret',
      paypalWebhookId: 'brand-new-webhook-id',
      tailscaleAuthKey: 'brand-new-tailscale-key',
    };

    const sanitized = sanitizeConfigPatchForStorage(fromRenderer);

    // Real values (not the mask) should be kept
    expect(sanitized.discordToken).toBe('brand-new-token');
    expect(sanitized.supabaseSecretKey).toBe('brand-new-secret');
    expect(sanitized.supabaseDbPassword).toBe('brand-new-db-password');
    expect(sanitized.supabaseAccessToken).toBe('brand-new-access-token');
    expect(sanitized.paypalClientSecret).toBe('brand-new-paypal-secret');
    expect(sanitized.paypalWebhookId).toBe('brand-new-webhook-id');
    expect(sanitized.tailscaleAuthKey).toBe('brand-new-tailscale-key');
  });
});
