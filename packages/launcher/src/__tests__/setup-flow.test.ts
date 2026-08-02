import { describe, expect, it } from 'vitest';
import { buildSetupStatus } from '../main/setup-flow';

const completeCredentials = {
  credentialReady: true,
  supabaseDiscordAuthProviderConfigured: true,
};

describe('setup flow status', () => {
  it('lets regular local setup prepare Tailscale public callback automatically', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      ...completeCredentials,
    });

    expect(status.runtimeMode).toBe('regular-local');
    expect(status.firstBlockingStepId).toBeNull();
    expect(status.primaryAction.enabled).toBe(true);
    expect(status.primaryAction.status).toBe('ready');
    const callbackStep = status.steps.find(step => step.id === 'regular-callback');
    expect(callbackStep?.status).toBe('pending');
    expect(callbackStep?.detail).toContain('enable or detect Tailscale Funnel during setup');
    expect(status.summary.localDashboardUrl).toBe('http://localhost');
    expect(status.summary.localDashboardUrl).not.toContain(':3456');
    expect(status.summary.publicCallbackUrl).toBe('Not set yet');
    expect(status.summary.diagnostics.operatorDashboardUrl).toBe('http://localhost:3456');
  });

  it('blocks regular local setup when Tailscale is known missing', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      tailscaleReadinessState: 'not-installed',
      ...completeCredentials,
    });

    const callbackStep = status.steps.find(step => step.id === 'regular-callback');
    expect(callbackStep?.status).toBe('blocked');
    expect(callbackStep?.summary).toContain('not installed');
    expect(callbackStep?.manualAction).toBe(true);
    expect(status.firstBlockingStepId).toBe('regular-callback');
    expect(status.primaryAction.enabled).toBe(false);
    expect(status.primaryAction.blockedReason).toContain('Install Tailscale');
  });

  it('blocks regular local setup when Tailscale is signed out without an auth key', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      tailscaleReadinessState: 'not-logged-in',
      ...completeCredentials,
    });

    const callbackStep = status.steps.find(step => step.id === 'regular-callback');
    expect(callbackStep?.status).toBe('blocked');
    expect(callbackStep?.detail).toContain('Sign in to Tailscale');
    expect(status.firstBlockingStepId).toBe('regular-callback');
    expect(status.primaryAction.enabled).toBe(false);
  });

  it('reports Windows service permission separately from Tailscale sign-in', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      tailscaleReadinessState: 'needs-permission',
      ...completeCredentials,
    });

    const callbackStep = status.steps.find(step => step.id === 'regular-callback');
    expect(callbackStep?.status).toBe('blocked');
    expect(callbackStep?.summary).toContain('Windows permission');
    expect(callbackStep?.detail).not.toContain('not signed in');
    expect(callbackStep?.manualAction).toBe(true);
  });

  it('lets regular local setup sign in to Tailscale when an auth key is saved', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      tailscaleReadinessState: 'not-logged-in',
      tailscaleAuthKeyReady: true,
      ...completeCredentials,
    });

    const callbackStep = status.steps.find(step => step.id === 'regular-callback');
    expect(callbackStep?.status).toBe('pending');
    expect(callbackStep?.summary).toContain('sign-in can be automated');
    expect(callbackStep?.detail).toContain('saved Tailscale auth key');
    expect(status.firstBlockingStepId).toBeNull();
    expect(status.primaryAction.enabled).toBe(true);
  });

  it('enables regular local validation only after callback and credentials are ready', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      ...completeCredentials,
    });

    expect(status.primaryAction).toEqual({
      label: 'Set Up & Start',
      enabled: true,
      status: 'ready',
    });
    expect(status.firstBlockingStepId).toBeNull();
    expect(status.steps.find(step => step.id === 'regular-callback')?.status).toBe('success');
    expect(status.summary.publicCallbackUrl).toBe('https://somnibot.tailnet.ts.net');
    expect(status.summary.diagnostics.authCallbackUrl).toBe('https://somnibot.tailnet.ts.net/api/auth/callback');
  });

  it('blocks regular local setup when no auth-provider setup path is available', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      credentialReady: true,
    });

    const authStep = status.steps.find(step => step.id === 'auth-provider');
    expect(authStep?.status).toBe('blocked');
    expect(authStep?.manualAction).toBe(true);
    expect(status.firstBlockingStepId).toBe('auth-provider');
    expect(status.primaryAction.enabled).toBe(false);
    expect(status.primaryAction.blockedReason).toContain('Supabase Management API token');
  });

  it('treats a Supabase Management API token as an automatic auth-provider setup path', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      credentialReady: true,
      supabaseAccessTokenReady: true,
    });

    const authStep = status.steps.find(step => step.id === 'auth-provider');
    expect(authStep?.status).toBe('success');
    expect(authStep?.summary).toContain('configured automatically');
    expect(status.primaryAction.enabled).toBe(true);
  });

  it('accepts dashboard-verified Discord auth provider readiness', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      credentialReady: true,
      supabaseDiscordAuthProviderStatus: {
        ready: true,
        providerEnabled: true,
        callbackAllowListReady: true,
        missingCallbackUrls: [],
        manualConfigured: false,
        statusReason: 'ready',
        statusDetail: 'Discord auth provider is enabled and callback URLs are allow-listed.',
      },
    });

    const authStep = status.steps.find(step => step.id === 'auth-provider');
    expect(authStep?.status).toBe('success');
    expect(authStep?.summary).toContain('readiness is verified');
    expect(authStep?.detail).toContain('callback URLs are allow-listed');
    expect(status.primaryAction.enabled).toBe(true);
  });

  it('surfaces missing Supabase auth callback allow-list URLs', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      credentialReady: true,
      supabaseDiscordAuthProviderStatus: {
        ready: false,
        providerEnabled: true,
        callbackAllowListReady: false,
        missingCallbackUrls: ['https://somnibot.tailnet.ts.net/api/auth/callback'],
        manualConfigured: false,
        statusReason: 'callback-allow-list-missing',
        statusDetail: 'Supabase auth callback allow-list is missing: https://somnibot.tailnet.ts.net/api/auth/callback.',
      },
    });

    const authStep = status.steps.find(step => step.id === 'auth-provider');
    expect(authStep?.status).toBe('blocked');
    expect(authStep?.manualAction).toBe(true);
    expect(authStep?.detail).toContain('allow-list is missing');
    expect(authStep?.detail).toContain('Missing callback URLs:');
    expect(authStep?.detail).toContain('https://somnibot.tailnet.ts.net/api/auth/callback');
    expect(status.firstBlockingStepId).toBe('auth-provider');
    expect(status.primaryAction.enabled).toBe(false);
  });

  it('keeps the missing-token auth-provider wall explicit and actionable', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      credentialReady: true,
      supabaseDiscordAuthProviderStatus: {
        ready: false,
        providerEnabled: false,
        callbackAllowListReady: false,
        missingCallbackUrls: ['https://somnibot.tailnet.ts.net/api/auth/callback'],
        manualConfigured: false,
        statusReason: 'management-token-missing',
        statusDetail: 'Add a Supabase Management API token so setup can verify and configure Discord auth, or confirm that Discord auth and callback URLs are already configured in Supabase.',
      },
    });

    const authStep = status.steps.find(step => step.id === 'auth-provider');
    expect(authStep?.status).toBe('blocked');
    expect(authStep?.detail).toContain('Management API token');
    expect(authStep?.detail).toContain('confirm');
    expect(authStep?.detail).not.toContain('Missing callback URLs:');
    expect(authStep?.detail).not.toContain('undefined');
    expect(status.firstBlockingStepId).toBe('auth-provider');
  });

  it('does not describe unknown auth-provider check failures as a disabled provider', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      credentialReady: true,
      supabaseDiscordAuthProviderStatus: {
        ready: false,
        providerEnabled: false,
        callbackAllowListReady: false,
        missingCallbackUrls: ['https://somnibot.tailnet.ts.net/api/auth/callback'],
        manualConfigured: false,
        statusReason: 'unknown',
        statusDetail: 'Discord auth provider readiness could not be verified.',
      },
    });

    const authStep = status.steps.find(step => step.id === 'auth-provider');
    expect(authStep?.status).toBe('blocked');
    expect(authStep?.detail).toContain('could not be verified');
    expect(authStep?.detail).not.toContain('disabled in Supabase');
    expect(authStep?.detail).not.toContain('Missing callback URLs:');
    expect(status.firstBlockingStepId).toBe('auth-provider');
  });

  it('does not let manual confirmation override an explicit dashboard auth failure', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      credentialReady: true,
      supabaseDiscordAuthProviderConfigured: true,
      supabaseDiscordAuthProviderStatus: {
        ready: false,
        providerEnabled: false,
        callbackAllowListReady: false,
        missingCallbackUrls: ['https://somnibot.tailnet.ts.net/api/auth/callback'],
        manualConfigured: false,
        statusReason: 'management-token-missing',
        statusDetail: 'Add a Supabase Management API token so setup can verify and configure Discord auth.',
      },
    });

    const authStep = status.steps.find(step => step.id === 'auth-provider');
    expect(authStep?.status).toBe('blocked');
    expect(authStep?.manualAction).toBe(true);
    expect(authStep?.detail).toContain('Add a Supabase');
    expect(authStep?.detail).toContain('verify and configure');
    expect(status.firstBlockingStepId).toBe('auth-provider');
    expect(status.primaryAction.enabled).toBe(false);
  });

  it('shows PayPal webhook readiness as a first-class setup step', () => {
    const incompleteStatus = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      ...completeCredentials,
    });

    const incompleteStep = incompleteStatus.steps.find(step => step.id === 'paypal-webhook');
    expect(incompleteStep?.status).toBe('pending');
    expect(incompleteStep?.summary).toContain('Waiting for PayPal');
    expect(incompleteStep?.detail).toContain('Create/Update Webhook');
    expect(incompleteStatus.primaryAction.enabled).toBe(true);
    expect(incompleteStatus.completion).toMatchObject({
      status: 'incomplete',
      missingStepIds: expect.arrayContaining(['discord-server', 'provider-validation', 'paypal-webhook', 'start-local']),
      missingLabels: expect.arrayContaining(['Discord server', 'Provider validation', 'PayPal webhook', 'Start locally']),
    });

    const readyStatus = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      paypalReady: true,
      ...completeCredentials,
    });

    const readyStep = readyStatus.steps.find(step => step.id === 'paypal-webhook');
    expect(readyStep?.status).toBe('success');
    expect(readyStep?.detail).toContain('PayPal runtime credentials');
  });

  it('requires dashboard health proof before calling the local runtime ready', () => {
    const degradedStatus = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      ...completeCredentials,
      dashboardOnline: true,
      localServiceReadiness: {
        dashboard: 'online',
        bot: 'starting',
        lavalink: 'offline',
        dashboardHealth: {
          ok: false,
          status: 'degraded',
          services: {
            config: 'valid',
            valkey: 'connected',
            bot: 'offline',
          },
          error: 'Dashboard health is degraded; services: config=valid, valkey=connected, bot=offline.',
        },
      },
    });

    const degradedStep = degradedStatus.steps.find(step => step.id === 'start-local');
    expect(degradedStep?.label).toBe('Runtime health');
    expect(degradedStep?.status).toBe('pending');
    expect(degradedStep?.summary).toContain('Waiting for local runtime health proof');
    expect(degradedStep?.detail).toContain('bot=offline');
    expect(degradedStatus.firstBlockingStepId).toBeNull();
    expect(degradedStatus.primaryAction.enabled).toBe(true);
    expect(degradedStatus.completion).toMatchObject({
      status: 'incomplete',
      missingStepIds: expect.arrayContaining(['discord-server', 'provider-validation', 'paypal-webhook', 'start-local']),
    });
    expect(degradedStatus.completion.detail).toContain('completion proof');

    const readyStatus = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      ...completeCredentials,
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
    });

    const readyStep = readyStatus.steps.find(step => step.id === 'start-local');
    expect(readyStep?.status).toBe('success');
    expect(readyStep?.summary).toContain('runtime health is verified');
    expect(readyStep?.detail).toContain('bot=online');
    expect(readyStep?.detail).toContain('valkey=connected');
  });

  it('treats invalid regular local callback URLs as recoverable errors', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'http://callback.example.com',
      ...completeCredentials,
    });

    const callbackStep = status.steps.find(step => step.id === 'regular-callback');
    expect(callbackStep?.status).toBe('recoverable-error');
    expect(callbackStep?.detail).toContain('HTTPS');
    expect(status.primaryAction.enabled).toBe(false);
  });

  it('surfaces provider validation failures as exact retryable setup items', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      credentialReady: true,
      supabaseDiscordAuthProviderConfigured: true,
      providerValidation: {
        valid: false,
        errors: ['Application ID mismatch.'],
        checks: [
          {
            id: 'discord-bot-token',
            label: 'Discord bot token',
            status: 'success',
            summary: 'Discord bot token verified.',
          },
          {
            id: 'discord-application',
            label: 'Discord application',
            status: 'failed',
            summary: 'Application ID does not match the bot token.',
            detail: 'Application ID mismatch.',
          },
          {
            id: 'discord-guild',
            label: 'Discord server',
            status: 'success',
            summary: 'Server readiness verified: Test Guild.',
          },
        ],
      },
    });

    const validationStep = status.steps.find(step => step.id === 'provider-validation');
    const startStep = status.steps.find(step => step.id === 'start-local');
    const discordStep = status.steps.find(step => step.id === 'discord-server');
    expect(discordStep?.status).toBe('success');
    expect(validationStep?.status).toBe('recoverable-error');
    expect(validationStep?.detail).toContain('Discord application: Application ID mismatch.');
    expect(startStep?.status).toBe('pending');
    expect(startStep?.summary).toContain('provider validation fixes');
    expect(status.firstBlockingStepId).toBe('provider-validation');
    expect(status.primaryAction).toEqual({
      label: 'Re-check Providers',
      enabled: true,
      status: 'ready',
    });
  });

  it('blocks setup after Discord server readiness validation fails', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      credentialReady: true,
      supabaseDiscordAuthProviderConfigured: true,
      providerValidation: {
        valid: false,
        errors: ['Bot is not in server 1464713668766732393, or the Guild ID is wrong.'],
        checks: [
          {
            id: 'discord-bot-token',
            label: 'Discord bot token',
            status: 'success',
            summary: 'Discord bot token verified for SomniBot.',
          },
          {
            id: 'discord-application',
            label: 'Discord application',
            status: 'success',
            summary: 'Application ID matches the bot token.',
          },
          {
            id: 'discord-guild',
            label: 'Discord server',
            status: 'failed',
            summary: 'Discord server membership could not be verified.',
            detail: 'Bot is not in server 1464713668766732393, or the Guild ID is wrong.',
          },
        ],
      },
    });

    const validationStep = status.steps.find(step => step.id === 'provider-validation');
    const discordStep = status.steps.find(step => step.id === 'discord-server');
    expect(discordStep?.status).toBe('recoverable-error');
    expect(discordStep?.summary).toContain('Bot server membership');
    expect(discordStep?.detail).toContain('Open the bot invite');
    expect(discordStep?.actionKind).toBe('discord-invite');
    expect(validationStep?.status).toBe('recoverable-error');
    expect(validationStep?.detail).toContain('Discord server: Bot is not in server 1464713668766732393');
    expect(status.firstBlockingStepId).toBe('discord-server');
    expect(status.primaryAction).toEqual({
      label: 'Re-check Providers',
      enabled: true,
      status: 'ready',
    });
  });

  it('makes Discord bot invite and server verification a first-class setup step', () => {
    const pendingStatus = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      credentialReady: true,
      discordGuildId: '1464713668766732393',
      supabaseDiscordAuthProviderConfigured: true,
    });

    const pendingStep = pendingStatus.steps.find(step => step.id === 'discord-server');
    expect(pendingStep?.status).toBe('pending');
    expect(pendingStep?.summary).toContain('invite and verify');
    expect(pendingStep?.detail).toContain('entered server');
    expect(pendingStep?.actionKind).toBe('discord-invite');

    const readyStatus = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      credentialReady: true,
      supabaseDiscordAuthProviderConfigured: true,
      providerValidation: {
        valid: true,
        errors: [],
        checks: [
          {
            id: 'discord-guild',
            label: 'Discord server',
            status: 'success',
            summary: 'Server readiness verified: Test Guild.',
          },
        ],
      },
    });

    const readyStep = readyStatus.steps.find(step => step.id === 'discord-server');
    expect(readyStep?.status).toBe('success');
    expect(readyStep?.detail).toContain('Test Guild');
  });

  it('makes VPS domain, SSH target, and manual deploy readiness first-class steps', () => {
    const status = buildSetupStatus({
      runtimeMode: 'vps',
      vpsDomain: 'somnibot.example.com',
      vpsSshHost: 'somnibot.example.com',
      vpsSshUser: 'deploy',
      vpsDeployPath: '/opt/somnibot',
      ...completeCredentials,
    });

    expect(status.runtimeMode).toBe('vps');
    expect(status.steps.map(step => step.id)).toEqual([
      'runtime-choice',
      'vps-domain',
      'vps-ssh',
      'credentials',
      'discord-server',
      'provider-validation',
      'auth-provider',
      'paypal-webhook',
      'vps-deploy',
    ]);
    expect(status.steps.find(step => step.id === 'vps-domain')?.status).toBe('success');
    expect(status.steps.find(step => step.id === 'vps-ssh')?.status).toBe('success');
    expect(status.steps.find(step => step.id === 'vps-deploy')?.status).toBe('blocked');
    expect(status.steps.find(step => step.id === 'vps-deploy')?.manualAction).toBe(true);
    expect(status.steps.find(step => step.id === 'vps-deploy')?.summary).toContain('deployment plan is ready');
    expect(status.primaryAction.enabled).toBe(false);
    expect(status.primaryAction.label).toBe('Manual VPS Deploy');
    expect(status.deploymentPlan?.status).toBe('ready');
    expect(status.completion).toMatchObject({
      status: 'incomplete',
      missingStepIds: expect.arrayContaining(['discord-server', 'provider-validation', 'paypal-webhook', 'vps-health-verification']),
      missingLabels: expect.arrayContaining(['Discord server', 'Provider validation', 'PayPal webhook', 'VPS health verification']),
    });
    expect(status.deploymentPlan?.target?.envFilePath).toBe('/opt/somnibot/.env');
    expect(status.deploymentPlan?.environment?.redactedEnvFile).toContain('DISCORD_TOKEN=<DISCORD_TOKEN>');
    expect(status.deploymentPlan?.reverseProxy?.upstream).toBe('dashboard:3000');
    expect(status.healthVerification?.status).toBe('pending');
    expect(status.healthVerification?.checks.map(check => check.id)).toEqual([
      'https-dashboard',
      'api-health',
      'supabase-callback-allow-list',
      'bot-diagnostics',
      'valkey-private-url',
      'lavalink-private-url',
    ]);
  });

  it('marks regular-local owner setup complete only when final-goal proof items are ready', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      callbackProbe: { ok: true, url: 'https://somnibot.tailnet.ts.net/api/health', status: 200 },
      discordGuildId: '1464713668766732393',
      credentialReady: true,
      providerValidation: {
        valid: true,
        errors: [],
        checks: [
          {
            id: 'discord-guild',
            label: 'Discord server',
            status: 'success',
            summary: 'Server readiness verified: Test Guild.',
          },
        ],
      },
      supabaseDiscordAuthProviderConfigured: true,
      paypalReady: true,
      paypalWebhook: {
        ok: true,
        webhookUrl: 'https://somnibot.tailnet.ts.net/api/paypal/webhook',
      },
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
    });

    expect(status.completion).toEqual({
      status: 'complete',
      summary: 'Regular local owner setup is complete.',
      detail: 'Public callbacks, provider credentials, Discord server readiness, Supabase auth, PayPal webhook readiness, and local runtime health are all verified.',
      requiredStepIds: [
        'regular-callback',
        'credentials',
        'discord-server',
        'provider-validation',
        'auth-provider',
        'paypal-webhook',
        'start-local',
      ],
      missingStepIds: [],
      missingLabels: [],
    });
  });

  it('keeps regular-local completion incomplete when manual auth conflicts with dashboard failure', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      callbackProbe: { ok: true, url: 'https://somnibot.tailnet.ts.net/api/health', status: 200 },
      discordGuildId: '1464713668766732393',
      credentialReady: true,
      providerValidation: {
        valid: true,
        errors: [],
        checks: [
          {
            id: 'discord-guild',
            label: 'Discord server',
            status: 'success',
            summary: 'Server readiness verified: Test Guild.',
          },
        ],
      },
      supabaseDiscordAuthProviderConfigured: true,
      supabaseDiscordAuthProviderStatus: {
        ready: false,
        providerEnabled: true,
        callbackAllowListReady: false,
        missingCallbackUrls: ['https://somnibot.tailnet.ts.net/api/auth/callback'],
        manualConfigured: false,
        statusReason: 'callback-allow-list-missing',
        statusDetail: 'Supabase auth callback allow-list is missing.',
      },
      paypalReady: true,
      paypalWebhook: {
        ok: true,
        webhookUrl: 'https://somnibot.tailnet.ts.net/api/paypal/webhook',
      },
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
    });

    expect(status.steps.find(step => step.id === 'auth-provider')?.status).toBe('blocked');
    expect(status.completion).toMatchObject({
      status: 'blocked',
      missingStepIds: expect.arrayContaining(['auth-provider']),
      missingLabels: expect.arrayContaining(['Supabase Auth']),
    });
  });

  it('keeps owner completion incomplete when ready-to-run inputs are not final proof', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://manual.example.com',
      credentialReady: true,
      providerValidation: {
        valid: true,
        errors: [],
        checks: [
          {
            id: 'discord-guild',
            label: 'Discord server',
            status: 'success',
            summary: 'Server auto-detect is ready.',
          },
        ],
      },
      supabaseAccessTokenReady: true,
      paypalReady: true,
      dashboardOnline: true,
      localServiceReadiness: {
        dashboard: 'online',
        bot: 'online',
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
    });

    expect(status.primaryAction.enabled).toBe(true);
    expect(status.completion).toMatchObject({
      status: 'incomplete',
      missingStepIds: expect.arrayContaining([
        'regular-callback',
        'discord-server',
        'auth-provider',
        'paypal-webhook',
      ]),
    });
    expect(status.completion.detail).toContain('completion proof');
  });

  it('keeps VPS owner setup incomplete until post-deploy health verification passes', () => {
    const pendingStatus = buildSetupStatus({
      runtimeMode: 'vps',
      vpsDomain: 'somnibot.example.com',
      vpsSshHost: 'somnibot.example.com',
      vpsSshUser: 'deploy',
      vpsDeployPath: '/opt/somnibot',
      discordGuildId: '1464713668766732393',
      credentialReady: true,
      providerValidation: {
        valid: true,
        errors: [],
        checks: [
          {
            id: 'discord-guild',
            label: 'Discord server',
            status: 'success',
            summary: 'Server readiness verified: Test Guild.',
          },
        ],
      },
      supabaseDiscordAuthProviderConfigured: true,
      paypalReady: true,
      paypalWebhook: {
        ok: true,
        webhookUrl: 'https://somnibot.example.com/api/paypal/webhook',
      },
    });

    expect(pendingStatus.completion).toMatchObject({
      status: 'incomplete',
      missingStepIds: ['vps-health-verification'],
      missingLabels: ['VPS health verification'],
    });

    const completeStatus = buildSetupStatus({
      runtimeMode: 'vps',
      vpsDomain: 'somnibot.example.com',
      vpsSshHost: 'somnibot.example.com',
      vpsSshUser: 'deploy',
      vpsDeployPath: '/opt/somnibot',
      discordGuildId: '1464713668766732393',
      credentialReady: true,
      providerValidation: {
        valid: true,
        errors: [],
        checks: [
          {
            id: 'discord-guild',
            label: 'Discord server',
            status: 'success',
            summary: 'Server readiness verified: Test Guild.',
          },
        ],
      },
      supabaseDiscordAuthProviderConfigured: true,
      paypalReady: true,
      paypalWebhook: {
        ok: true,
        webhookUrl: 'https://somnibot.example.com/api/paypal/webhook',
      },
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

    expect(completeStatus.healthVerification?.status).toBe('pass');
    expect(completeStatus.completion).toMatchObject({
      status: 'complete',
      missingStepIds: [],
      missingLabels: [],
    });
  });

  it('blocks VPS setup when SSH/deploy details are missing', () => {
    const status = buildSetupStatus({
      runtimeMode: 'vps',
      vpsDomain: 'https://somnibot.example.com',
      ...completeCredentials,
    });

    const sshStep = status.steps.find(step => step.id === 'vps-ssh');
    expect(sshStep?.status).toBe('blocked');
    expect(sshStep?.manualAction).toBe(true);
    expect(status.firstBlockingStepId).toBe('vps-ssh');
    expect(status.deploymentPlan?.status).toBe('blocked');
    expect(status.deploymentPlan?.blockedReasons).toContain('SSH host is required before preflight can be planned.');
    expect(status.deploymentPlan?.target).toBeNull();
    expect(status.healthVerification?.status).toBe('blocked');
    expect(status.healthVerification?.blockedReasons).toContain('SSH host is required before preflight can be planned.');
  });

  it('does not let a regular-local callback URL satisfy the VPS domain step', () => {
    const status = buildSetupStatus({
      runtimeMode: 'vps',
      publicCallbackBaseUrl: 'https://old-tailnet.tailnet.ts.net',
      vpsSshHost: 'somnibot.example.com',
      vpsSshUser: 'deploy',
      vpsDeployPath: '/opt/somnibot',
      ...completeCredentials,
    });

    expect(status.firstBlockingStepId).toBe('vps-domain');
    expect(status.steps.find(step => step.id === 'vps-domain')?.status).toBe('blocked');
    expect(status.summary.publicCallbackUrl).toBe('Not set yet');
  });

  it('uses the VPS domain, not a stale regular-local callback, for VPS diagnostics', () => {
    const status = buildSetupStatus({
      runtimeMode: 'vps',
      publicCallbackBaseUrl: 'https://old-tailnet.tailnet.ts.net',
      vpsDomain: 'somnibot.example.com',
      vpsSshHost: 'somnibot.example.com',
      vpsSshUser: 'deploy',
      vpsDeployPath: '/opt/somnibot',
      ...completeCredentials,
    });

    expect(status.steps.find(step => step.id === 'vps-domain')?.status).toBe('success');
    expect(status.summary.publicCallbackUrl).toBe('https://somnibot.example.com');
    expect(status.summary.diagnostics.publicCallbackBaseUrl).toBe('https://somnibot.example.com');
    expect(status.summary.diagnostics.authCallbackUrl).toBe('https://somnibot.example.com/api/auth/callback');
    expect(status.summary.diagnostics.paypalWebhookUrl).toBe('https://somnibot.example.com/api/paypal/webhook');
    expect(status.summary.diagnostics.publicCallbackBaseUrl).not.toContain('old-tailnet');
  });

  it('surfaces recoverable VPS domain errors for local and non-HTTPS URLs', () => {
    const malformedStatus = buildSetupStatus({
      runtimeMode: 'vps',
      vpsDomain: 'not a domain',
      ...completeCredentials,
    });
    const malformedDomainStep = malformedStatus.steps.find(step => step.id === 'vps-domain');
    expect(malformedDomainStep?.status).toBe('recoverable-error');
    expect(malformedDomainStep?.detail).toContain('VPS public domain must be a valid HTTP or HTTPS URL or bare domain.');

    const status = buildSetupStatus({
      runtimeMode: 'vps',
      vpsDomain: 'http://localhost:3000',
      vpsSshHost: 'somnibot.example.com',
      vpsSshUser: 'deploy',
      vpsDeployPath: '/opt/somnibot',
      ...completeCredentials,
    });

    const domainStep = status.steps.find(step => step.id === 'vps-domain');
    expect(domainStep?.status).toBe('recoverable-error');
    expect(domainStep?.detail).toContain('VPS public domain must use HTTPS.');
    expect(domainStep?.detail).toContain('VPS mode cannot use a localhost callback URL.');
    expect(status.firstBlockingStepId).toBe('vps-domain');
    expect(status.primaryAction.enabled).toBe(false);
  });

  it('hides implementation ports from normal summary copy but keeps them in diagnostics', () => {
    const status = buildSetupStatus({
      runtimeMode: 'vps',
      vpsDomain: 'https://somnibot.example.com:3000',
      vpsSshHost: 'somnibot.example.com',
      vpsSshUser: 'deploy',
      vpsDeployPath: '/opt/somnibot',
    });

    expect(status.summary.localDashboardUrl).toBe('https://somnibot.example.com');
    expect(status.summary.publicCallbackUrl).toBe('https://somnibot.example.com');
    expect(status.summary.authCallbackUrl).toBe('https://somnibot.example.com/api/auth/callback');
    expect(status.summary.paypalWebhookUrl).toBe('https://somnibot.example.com/api/paypal/webhook');
    expect(status.summary.localDashboardUrl).not.toContain(':3000');
    expect(status.summary.publicCallbackUrl).not.toContain(':3000');
    expect(status.summary.authCallbackUrl).not.toContain(':3000');
    expect(status.summary.paypalWebhookUrl).not.toContain(':3000');
    expect(status.summary.diagnostics.operatorDashboardUrl).toBe('https://somnibot.example.com:3000');
    expect(status.summary.diagnostics.authCallbackUrl).toBe('https://somnibot.example.com:3000/api/auth/callback');
  });

  it('surfaces deployment plan errors when SSH details are present but unsafe', () => {
    const status = buildSetupStatus({
      runtimeMode: 'vps',
      vpsDomain: 'somnibot.example.com',
      vpsSshHost: 'somnibot.example.com;touch',
      vpsSshUser: 'deploy',
      vpsDeployPath: '/opt/somnibot',
      ...completeCredentials,
    });

    const deployStep = status.steps.find(step => step.id === 'vps-deploy');
    expect(status.steps.find(step => step.id === 'vps-ssh')?.status).toBe('success');
    expect(deployStep?.status).toBe('recoverable-error');
    expect(deployStep?.detail).toContain('SSH host must be a hostname or IPv4 address');
    expect(status.deploymentPlan?.status).toBe('blocked');
    expect(status.deploymentPlan?.commands).toEqual([]);
  });
});
