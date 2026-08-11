import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { LauncherConfig } from '../main/config-store';
import { buildSetupStatus } from '../main/setup-flow';
import { buildVpsDeploymentPlan, buildVpsFunnelComposeOverride } from '../main/vps-deployment-plan';
import { materializeVpsDeploymentPlan, type PersistedVpsSecrets } from '../main/vps-env-materializer';

const baseInput = {
  runtimeMode: 'vps',
  vpsSshHost: '203.0.113.10',
  vpsSshUser: 'deploy',
  vpsDeployPath: '/opt/somnibot',
  credentialReady: true,
  paypalReady: true,
  supabaseAccessTokenReady: true,
};

const funnelConfig = {
  discordToken: 'discord-token',
  discordApplicationId: 'discord-application-id',
  discordClientSecret: 'discord-client-secret',
  discordGuildId: '',
  guilds: [],
  supabaseUrl: 'https://projectref.supabase.co',
  supabaseSecretKey: 'supabase-secret',
  supabasePublishableKey: 'supabase-publishable',
  supabaseDbPassword: 'database-password',
  supabaseAccessToken: 'supabase-access-token',
  supabaseDiscordAuthProviderConfigured: false,
  paypalClientId: 'paypal-client-id',
  paypalClientSecret: 'paypal-client-secret',
  paypalWebhookId: 'paypal-webhook-id',
  paypalWebhookProofKey: '',
  paypalSandbox: true,
  vpsCsrfSecret: 'csrf-secret',
  vpsNextAuthSecret: 'next-auth-secret',
  vpsWebhookReplaySecret: 'webhook-replay-secret',
  vpsValkeyPassword: 'valkey-password',
  vpsLavalinkPassword: 'lavalink-password',
  runtimeMode: 'vps',
  publicCallbackBaseUrl: '',
  vpsPublicAccessMode: 'tailscale-funnel',
  vpsDomain: '',
  vpsTailscaleFunnelUrl: 'https://somnibot-vps.tailbd9d28.ts.net',
  vpsTailscaleFunnelVerifiedUrl: 'https://somnibot-vps.tailbd9d28.ts.net',
  vpsSshHost: '203.0.113.10',
  vpsSshUser: 'deploy',
  vpsDeployPath: '/opt/somnibot',
  firstRunComplete: false,
  lavalinkEnabled: true,
  autoInstallOnQuit: true,
  keychainRequired: true,
  ownerBrandName: 'SomniBot',
  updatePromptBeforeDownload: true,
  sdkCacheTtlMs: 60_000,
  lastPids: { bot: null, dashboard: null, lavalink: null, valkey: null },
} satisfies LauncherConfig & PersistedVpsSecrets;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('VPS public access modes', () => {
  it('keeps the conventional domain and Caddy contract', () => {
    // Given a conventional domain VPS deployment.
    const input = { ...baseInput, vpsPublicAccessMode: 'domain', vpsDomain: 'bot.example.com' };

    // When the launcher builds its deployment plan.
    const plan = buildVpsDeploymentPlan(input);

    // Then Caddy remains the public edge and owns ports 80/443.
    expect(plan.status).toBe('ready');
    expect(plan.target?.publicBaseUrl).toBe('https://bot.example.com');
    expect(plan.reverseProxy?.publicPorts).toEqual(['80/tcp', '443/tcp']);
    expect(plan.serviceLayout).toContainEqual(expect.objectContaining({ name: 'caddy', exposure: 'public' }));
  });

  it('allows a missing purchased domain only when the exact Funnel URL was remotely verified', () => {
    // Given Funnel mode with an exact verified ts.net HTTPS origin.
    const input = {
      ...baseInput,
      vpsPublicAccessMode: 'tailscale-funnel',
      vpsDomain: '',
      vpsTailscaleFunnelUrl: 'https://somnibot-vps.tailbd9d28.ts.net',
      vpsTailscaleFunnelVerifiedUrl: 'https://somnibot-vps.tailbd9d28.ts.net',
    };

    // When the launcher builds its deployment plan.
    const plan = buildVpsDeploymentPlan(input);

    // Then the plan derives callbacks from Funnel and excludes bundled Caddy.
    expect(plan.status).toBe('ready');
    expect(plan.target).toMatchObject({
      domain: 'somnibot-vps.tailbd9d28.ts.net',
      publicBaseUrl: 'https://somnibot-vps.tailbd9d28.ts.net',
      composeProjectName: 'somnibot-prod',
    });
    expect(plan.environment?.redactedEnvFile).toContain('DASHBOARD_URL=https://somnibot-vps.tailbd9d28.ts.net');
    expect(plan.environment?.redactedEnvFile).toContain('PAYPAL_WEBHOOK_URL=https://somnibot-vps.tailbd9d28.ts.net/api/paypal/webhook');
    expect(plan.environment?.redactedEnvFile).toContain('COMPOSE_PROJECT_NAME=somnibot-prod');
    expect(plan.environment?.redactedEnvFile).toContain('DOMAIN=');
    expect(plan.reverseProxy).toBeNull();
    expect(plan.serviceLayout).not.toContainEqual(expect.objectContaining({ name: 'caddy' }));
    expect(plan.serviceLayout).toContainEqual(expect.objectContaining({
      name: 'dashboard',
      exposure: 'private',
      endpoint: '127.0.0.1:3456 -> dashboard:3000',
    }));
    expect(plan.commands).toContainEqual(expect.objectContaining({ id: 'write-funnel-compose-override' }));
    expect(plan.commands.find(command => command.id === 'start-stack')?.args).toEqual(expect.arrayContaining([
      '-f',
      '/opt/somnibot/docker-compose.prod.yml',
      '-f',
      '/opt/somnibot/.somnibot/launcher-tailscale-funnel.compose.yml',
    ]));
    const composeOverride = buildVpsFunnelComposeOverride();
    expect(composeOverride).toContain('127.0.0.1:3456:3000');
    expect(composeOverride).toContain('profiles: ["somnibot-domain-edge"]');
    expect(composeOverride).not.toContain('0.0.0.0:3456');
  });

  it('parses the generated Funnel environment and override with real Docker Compose', () => {
    // Given the exact environment and override that the launcher streams to a Funnel VPS.
    const plan = buildVpsDeploymentPlan({
      ...funnelConfig,
      credentialReady: true,
      paypalReady: true,
      supabaseAccessTokenReady: true,
    });
    const materialized = materializeVpsDeploymentPlan(plan, funnelConfig);
    const envFile = materialized.commands.find(command => command.id === 'write-env-file')?.sensitiveStdin;
    const composeOverride = materialized.commands.find(command => command.id === 'write-funnel-compose-override')?.sensitiveStdin;
    expect(envFile).toBeTypeOf('string');
    expect(composeOverride).toBeTypeOf('string');
    const environment = parseEnv(envFile ?? '');
    expect(environment.DOMAIN).toBe('funnel-disabled.invalid');
    expect(environment.DASHBOARD_URL).toBe('https://somnibot-vps.tailbd9d28.ts.net');
    expect(environment.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL).toBe('https://somnibot-vps.tailbd9d28.ts.net');
    expect(environment.PAYPAL_WEBHOOK_URL).toBe('https://somnibot-vps.tailbd9d28.ts.net/api/paypal/webhook');

    const root = mkdtempSync(path.join(tmpdir(), 'somnibot-funnel-compose-'));
    try {
      writeFileSync(path.join(root, '.env'), envFile ?? '');
      writeFileSync(path.join(root, 'docker-compose.prod.yml'), readFileSync(new URL('../../../../docker-compose.prod.yml', import.meta.url)));
      writeFileSync(path.join(root, 'launcher-tailscale-funnel.compose.yml'), composeOverride ?? '');

      // When the real Compose parser resolves the generated files.
      const composeArgs = [
        'compose',
        '--env-file', '.env',
        '-f', 'docker-compose.prod.yml',
        '-f', 'launcher-tailscale-funnel.compose.yml',
      ];
      const result = spawnSync('docker', [...composeArgs, 'config', '--format', 'json'], { cwd: root, encoding: 'utf8' });

      // Then interpolation and the loopback-only profile override are valid.
      expect(result.status, result.stderr).toBe(0);
      const parsed: unknown = JSON.parse(result.stdout);
      expect(isRecord(parsed)).toBe(true);
      if (!isRecord(parsed)) throw new Error('Docker Compose config must return a JSON object.');
      const services = isRecord(parsed.services) ? parsed.services : {};
      expect(Object.keys(services)).not.toContain('caddy');
      const dashboard = isRecord(services.dashboard) ? services.dashboard : {};
      const ports = Array.isArray(dashboard.ports) ? dashboard.ports : [];
      expect(ports).toContainEqual(expect.objectContaining({ host_ip: '127.0.0.1', published: '3456', target: 3000 }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks Funnel mode when the URL is invalid, unverified, or verified for a different host', () => {
    // Given three untrusted Funnel configurations.
    const invalid = buildVpsDeploymentPlan({
      ...baseInput,
      vpsPublicAccessMode: 'tailscale-funnel',
      vpsTailscaleFunnelUrl: 'https://example.com',
    });
    const decorated = buildVpsDeploymentPlan({
      ...baseInput,
      vpsPublicAccessMode: 'tailscale-funnel',
      vpsTailscaleFunnelUrl: 'https://bot.example.ts.net?redirect=untrusted',
      vpsTailscaleFunnelVerifiedUrl: 'https://bot.example.ts.net',
    });
    const unverified = buildVpsDeploymentPlan({
      ...baseInput,
      vpsPublicAccessMode: 'tailscale-funnel',
      vpsTailscaleFunnelUrl: 'https://bot.example.ts.net',
    });
    const stale = buildVpsDeploymentPlan({
      ...baseInput,
      vpsPublicAccessMode: 'tailscale-funnel',
      vpsTailscaleFunnelUrl: 'https://new.example.ts.net',
      vpsTailscaleFunnelVerifiedUrl: 'https://old.example.ts.net',
    });

    // When the plans are inspected, then none can be approved.
    expect(invalid.status).toBe('blocked');
    expect(invalid.blockedReasons.join(' ')).toContain('*.ts.net');
    expect(unverified.status).toBe('blocked');
    expect(unverified.blockedReasons.join(' ')).toContain('remote Tailscale Funnel status');
    expect(stale.status).toBe('blocked');
    expect(stale.blockedReasons.join(' ')).toContain('current Funnel URL');
    expect(decorated.status).toBe('blocked');
    expect(decorated.blockedReasons.join(' ')).toContain('query or fragment');
  });

  it('does not call VPS setup complete before public HTTPS health proof passes', () => {
    // Given a remotely verified Funnel configuration but no public health result.
    const input = {
      ...baseInput,
      vpsPublicAccessMode: 'tailscale-funnel',
      vpsTailscaleFunnelUrl: 'https://bot.example.ts.net',
      vpsTailscaleFunnelVerifiedUrl: 'https://bot.example.ts.net',
      credentialReady: false,
    };

    // When setup status is built.
    const status = buildSetupStatus(input);

    // Then the public-edge step is clear and completion remains blocked on proof.
    expect(status.steps).toContainEqual(expect.objectContaining({
      id: 'vps-public-access',
      status: 'success',
    }));
    expect(status.completion.status).not.toBe('complete');
    expect(status.completion.requiredStepIds).toContain('vps-health-verification');
    expect(status.summary.authCallbackUrl).toBe('https://bot.example.ts.net/api/auth/callback');
    expect(status.summary.paypalWebhookUrl).toBe('https://bot.example.ts.net/api/paypal/webhook');
  });
});
