import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LauncherConfig } from '../main/config-store.js';
import {
  importExistingSomniBotEnv,
  launcherConfigFromExistingEnv,
  mergeMissingLauncherConfig,
  parseExistingSomniBotEnv,
} from '../main/existing-env-import.js';

const emptyConfig: LauncherConfig = {
  discordToken: '', discordApplicationId: '', discordClientSecret: '', discordGuildId: '', guilds: [],
  supabaseUrl: '', supabaseSecretKey: '', supabasePublishableKey: '', supabaseDbPassword: '',
  supabaseAccessToken: '', supabaseDiscordAuthProviderConfigured: false,
  paypalClientId: '', paypalClientSecret: '', paypalWebhookId: '', paypalWebhookProofKey: '', paypalSandbox: true,
  vpsCsrfSecret: '', vpsNextAuthSecret: '', vpsWebhookReplaySecret: '', vpsValkeyPassword: '', vpsLavalinkPassword: '',
  runtimeMode: 'regular-local', publicCallbackBaseUrl: '', vpsDomain: '', vpsSshHost: '', vpsSshUser: '', vpsDeployPath: '',
  tailscaleAuthKey: '', firstRunComplete: false, lavalinkEnabled: false,
  lastPids: { bot: null, dashboard: null, lavalink: null, valkey: null },
};

describe('existing SomniBot environment import', () => {
  it('parses quoted special characters without treating them as comments or interpolation', () => {
    expect(parseExistingSomniBotEnv([
      "DISCORD_TOKEN='token with $ and # characters'",
      'PAYPAL_CLIENT_SECRET="quoted#secret"',
      'SUPABASE_ACCESS_TOKEN=plain-value # operator comment',
      'export DISCORD_APPLICATION_ID=123456789012345678',
    ].join('\n'))).toEqual({
      DISCORD_TOKEN: 'token with $ and # characters',
      PAYPAL_CLIENT_SECRET: 'quoted#secret',
      SUPABASE_ACCESS_TOKEN: 'plain-value',
      DISCORD_APPLICATION_ID: '123456789012345678',
    });
  });

  it('maps the established local and VPS connection contract, including the database URL password', () => {
    const imported = launcherConfigFromExistingEnv({
      DISCORD_TOKEN: 'discord-token',
      DISCORD_APPLICATION_ID: 'discord-app',
      DISCORD_CLIENT_SECRET: 'discord-secret',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SECRET_KEY: 'supabase-secret',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'publishable',
      SUPABASE_DB_URL: 'postgresql://postgres:encoded%20password@db.project.supabase.co:5432/postgres',
      SUPABASE_ACCESS_TOKEN: 'management-token',
      PAYPAL_CLIENT_ID: 'paypal-client',
      PAYPAL_CLIENT_SECRET: 'paypal-secret',
      PAYPAL_WEBHOOK_ID: 'WH-existing',
      PAYPAL_SANDBOX: 'true',
      CSRF_SECRET: 'csrf',
      NEXTAUTH_SECRET: 'nextauth',
      WEBHOOK_REPLAY_SECRET: 'replay',
      VALKEY_PASSWORD: 'valkey',
      LAVALINK_PASSWORD: 'lavalink',
    });

    expect(imported).toMatchObject({
      supabaseDbPassword: 'encoded password',
      supabaseAccessToken: 'management-token',
      paypalClientSecret: 'paypal-secret',
      paypalWebhookId: 'WH-existing',
      paypalSandbox: true,
      vpsCsrfSecret: 'csrf',
      vpsNextAuthSecret: 'nextauth',
      vpsWebhookReplaySecret: 'replay',
      vpsValkeyPassword: 'valkey',
      vpsLavalinkPassword: 'lavalink',
    });
  });

  it('fills only missing fields and never overwrites an established launcher value', () => {
    const patch = mergeMissingLauncherConfig(
      { ...emptyConfig, discordToken: 'current-token', paypalSandbox: false, firstRunComplete: true },
      { discordToken: 'older-token', supabaseDbPassword: 'recovered-password', paypalSandbox: true },
    );
    expect(patch).toEqual({ supabaseDbPassword: 'recovered-password' });
  });

  it('reads a valid SomniBot file and reports field names without returning unrelated variables', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'somnibot-env-import-'));
    const envPath = path.join(root, '.env');
    await writeFile(envPath, [
      'DISCORD_APPLICATION_ID=123456789012345678',
      'SUPABASE_URL=https://project.supabase.co',
      'SUPABASE_SECRET_KEY=service-key',
      'SUPABASE_DB_URL=postgresql://postgres:db-password@db.project.supabase.co/postgres',
      'UNRELATED_SECRET=do-not-import',
    ].join('\n'));

    const result = await importExistingSomniBotEnv(envPath, emptyConfig);
    expect(result.ok).toBe(true);
    expect(result.patch).toMatchObject({ supabaseDbPassword: 'db-password' });
    expect(result.patch).not.toHaveProperty('UNRELATED_SECRET');
    expect(result.importedFields).toContain('supabaseDbPassword');
  });

  it('rejects an arbitrary env file that is not a complete SomniBot connection identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'somnibot-env-import-invalid-'));
    const envPath = path.join(root, '.env');
    await writeFile(envPath, 'PAYPAL_CLIENT_SECRET=unrelated\n');

    const result = await importExistingSomniBotEnv(envPath, emptyConfig);
    expect(result).toMatchObject({ ok: false, patch: {}, importedFields: [] });
    expect(result.error).not.toContain('unrelated');
  });
});
