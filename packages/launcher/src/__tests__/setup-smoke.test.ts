import { describe, expect, it } from 'vitest';
import { buildRuntimeEnvVars } from '../main/runtime-profile';
import { buildSetupStatus } from '../main/setup-flow';
import { buildVpsHealthVerification } from '../main/vps-health-verification';
import type { ProviderValidationCheck } from '../main/validators';

function stepStatuses(status: ReturnType<typeof buildSetupStatus>): Record<string, string> {
  return Object.fromEntries(status.steps.map(step => [step.id, step.status]));
}

function successfulProviderChecks(): ProviderValidationCheck[] {
  return [
    {
      id: 'discord-bot-token',
      label: 'Discord bot token',
      status: 'success',
      summary: 'Bot token belongs to SomniBot.',
    },
    {
      id: 'discord-application',
      label: 'Discord application',
      status: 'success',
      summary: 'Application ID matches the bot token.',
    },
    {
      id: 'discord-client-secret',
      label: 'Discord OAuth secret',
      status: 'success',
      summary: 'Client secret is present for Discord OAuth.',
    },
    {
      id: 'discord-guild',
      label: 'Discord server',
      status: 'success',
      summary: 'Bot can see the selected Discord server.',
    },
    {
      id: 'supabase-project',
      label: 'Supabase project',
      status: 'success',
      summary: 'Supabase URL and API keys are reachable.',
    },
  ];
}

describe('setup end-to-end smoke contract', () => {
  it('carries a regular-local Funnel-ready setup into runtime env values', () => {
    const input = {
      runtimeMode: 'regular-local' as const,
      publicCallbackBaseUrl: 'https://somnibot-laptop.tailnet.ts.net',
      credentialReady: true,
      supabaseDiscordAuthProviderConfigured: true,
      dashboardOnline: true,
      localServiceReadiness: {
        dashboard: 'online',
        bot: 'online',
        lavalink: 'offline',
        dashboardHealth: {
          ok: true,
          status: 'healthy',
          services: {
            config: 'valid',
            valkey: 'connected',
            bot: 'online',
          },
        },
      },
    };

    const status = buildSetupStatus(input);
    const env = buildRuntimeEnvVars(input);

    expect(status.runtimeMode).toBe('regular-local');
    expect(stepStatuses(status)).toEqual({
      'runtime-choice': 'success',
      'regular-callback': 'success',
      credentials: 'success',
      'discord-server': 'pending',
      'provider-validation': 'pending',
      'auth-provider': 'success',
      'paypal-webhook': 'pending',
      'start-local': 'success',
    });
    expect(status.firstBlockingStepId).toBeNull();
    expect(status.primaryAction).toEqual({
      label: 'Set Up & Start',
      enabled: true,
      status: 'ready',
    });

    expect(status.summary.publicCallbackUrl).toBe('https://somnibot-laptop.tailnet.ts.net');
    expect(status.summary.authCallbackUrl).toBe('https://somnibot-laptop.tailnet.ts.net/api/auth/callback');
    expect(status.summary.paypalWebhookUrl).toBe('https://somnibot-laptop.tailnet.ts.net/api/paypal/webhook');
    expect(status.summary.diagnostics.operatorDashboardUrl).toBe(env.DASHBOARD_URL);
    expect(status.summary.diagnostics.publicCallbackBaseUrl).toBe(env.NEXT_PUBLIC_APP_URL);
    expect(status.summary.diagnostics.paypalWebhookUrl).toBe(env.PAYPAL_WEBHOOK_URL);

    expect(env).toMatchObject({
      SOMNIBOT_RUNTIME_MODE: 'regular-local',
      SOMNIBOT_PUBLIC_CALLBACK_REQUIRED: 'true',
      DASHBOARD_URL: 'http://localhost:3456',
      NEXT_PUBLIC_APP_URL: 'https://somnibot-laptop.tailnet.ts.net',
      PAYPAL_WEBHOOK_URL: 'https://somnibot-laptop.tailnet.ts.net/api/paypal/webhook',
      VALKEY_URL: 'redis://127.0.0.1:6379',
      LAVALINK_HOST: 'localhost',
    });
  });

  it('proves a fully ready regular-local owner setup has no pending or blocked steps', () => {
    const input = {
      runtimeMode: 'regular-local' as const,
      publicCallbackBaseUrl: 'https://somnibot-laptop.tailnet.ts.net',
      discordGuildId: '123456789012345678',
      credentialReady: true,
      providerValidation: {
        valid: true,
        errors: [],
        checks: successfulProviderChecks(),
      },
      supabaseAccessTokenReady: true,
      paypalReady: true,
      dashboardOnline: true,
      localServiceReadiness: {
        dashboard: 'online',
        bot: 'online',
        lavalink: 'online',
        dashboardHealth: {
          ok: true,
          status: 'healthy',
          services: {
            config: 'valid',
            valkey: 'connected',
            bot: 'online',
          },
        },
      },
    };

    const status = buildSetupStatus(input);
    const env = buildRuntimeEnvVars(input);

    expect(stepStatuses(status)).toEqual({
      'runtime-choice': 'success',
      'regular-callback': 'success',
      credentials: 'success',
      'discord-server': 'success',
      'provider-validation': 'success',
      'auth-provider': 'success',
      'paypal-webhook': 'success',
      'start-local': 'success',
    });
    expect(status.steps.every(step => step.status === 'success')).toBe(true);
    expect(status.firstBlockingStepId).toBeNull();
    expect(status.primaryAction).toEqual({
      label: 'Set Up & Start',
      enabled: true,
      status: 'ready',
    });

    expect(status.summary.publicCallbackUrl).toBe('https://somnibot-laptop.tailnet.ts.net');
    expect(status.summary.authCallbackUrl).toBe('https://somnibot-laptop.tailnet.ts.net/api/auth/callback');
    expect(status.summary.paypalWebhookUrl).toBe('https://somnibot-laptop.tailnet.ts.net/api/paypal/webhook');
    expect(status.summary.diagnostics.operatorDashboardUrl).toBe(env.DASHBOARD_URL);
    expect(status.summary.diagnostics.publicCallbackBaseUrl).toBe(env.NEXT_PUBLIC_APP_URL);
    expect(status.summary.diagnostics.paypalWebhookUrl).toBe(env.PAYPAL_WEBHOOK_URL);

    expect(env).toMatchObject({
      SOMNIBOT_RUNTIME_MODE: 'regular-local',
      SOMNIBOT_PUBLIC_CALLBACK_REQUIRED: 'true',
      DASHBOARD_URL: 'http://localhost:3456',
      NEXT_PUBLIC_APP_URL: 'https://somnibot-laptop.tailnet.ts.net',
      PAYPAL_WEBHOOK_URL: 'https://somnibot-laptop.tailnet.ts.net/api/paypal/webhook',
      VALKEY_URL: 'redis://127.0.0.1:6379',
      LAVALINK_HOST: 'localhost',
    });
  });

  it('carries a VPS owner-ready setup into runtime env and leaves only the manual deploy wall', () => {
    const input = {
      runtimeMode: 'vps' as const,
      publicCallbackBaseUrl: 'https://old-laptop.tailnet.ts.net',
      vpsDomain: 'somnibot.example.com',
      vpsSshHost: 'somnibot.example.com',
      vpsSshUser: 'deploy',
      vpsDeployPath: '/opt/somnibot',
      credentialReady: true,
      discordGuildId: '123456789012345678',
      providerValidation: {
        valid: true,
        errors: [],
        checks: successfulProviderChecks(),
      },
      supabaseAccessTokenReady: true,
      paypalReady: true,
    };

    const status = buildSetupStatus(input);
    const env = buildRuntimeEnvVars(input);
    const health = buildVpsHealthVerification({
      ...input,
      httpsDashboardProbe: { state: 'success', httpStatus: 200 },
      apiHealthProbe: {
        state: 'success',
        httpStatus: 200,
        response: {
          status: 'healthy',
          services: {
            config: 'valid',
            valkey: 'connected',
            bot: 'online',
          },
        },
      },
      supabaseCallbackAllowList: { status: 'pass' },
      lavalink: { status: 'pass' },
    });

    expect(status.runtimeMode).toBe('vps');
    expect(stepStatuses(status)).toEqual({
      'runtime-choice': 'success',
      'vps-domain': 'success',
      'vps-ssh': 'success',
      credentials: 'success',
      'discord-server': 'success',
      'provider-validation': 'success',
      'auth-provider': 'success',
      'paypal-webhook': 'success',
      'vps-deploy': 'blocked',
    });
    expect(status.steps.filter(step => step.id !== 'vps-deploy' && step.status !== 'success')).toEqual([]);
    expect(status.firstBlockingStepId).toBe('vps-deploy');
    expect(status.primaryAction).toMatchObject({
      label: 'Manual VPS Deploy',
      enabled: false,
      status: 'blocked',
    });
    expect(status.deploymentPlan?.status).toBe('ready');
    expect(status.healthVerification?.status).toBe('pending');

    expect(status.summary.publicCallbackUrl).toBe('https://somnibot.example.com');
    expect(status.summary.diagnostics.publicCallbackBaseUrl).toBe(env.NEXT_PUBLIC_APP_URL);
    expect(status.summary.diagnostics.paypalWebhookUrl).toBe(env.PAYPAL_WEBHOOK_URL);
    expect(JSON.stringify({ status, env, health })).not.toContain('old-laptop');

    expect(env).toMatchObject({
      SOMNIBOT_RUNTIME_MODE: 'vps',
      SOMNIBOT_PUBLIC_CALLBACK_REQUIRED: 'true',
      DASHBOARD_URL: 'https://somnibot.example.com',
      NEXT_PUBLIC_APP_URL: 'https://somnibot.example.com',
      PAYPAL_WEBHOOK_URL: 'https://somnibot.example.com/api/paypal/webhook',
      PORT: '3000',
      HOSTNAME: '0.0.0.0',
      VALKEY_URL: 'redis://valkey:6379',
      LAVALINK_HOST: 'lavalink',
    });
    expect(health.status).toBe('pass');
    expect(health.checks.map(check => check.id)).toEqual([
      'https-dashboard',
      'api-health',
      'supabase-callback-allow-list',
      'bot-diagnostics',
      'valkey-private-url',
      'lavalink-private-url',
    ]);
    expect(health.checks.every(check => check.status === 'pass')).toBe(true);
  });
});
