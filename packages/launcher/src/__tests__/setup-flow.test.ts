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
        ],
      },
    });

    const validationStep = status.steps.find(step => step.id === 'provider-validation');
    const startStep = status.steps.find(step => step.id === 'start-local');
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
    expect(validationStep?.status).toBe('recoverable-error');
    expect(validationStep?.detail).toContain('Discord server: Bot is not in server 1464713668766732393');
    expect(status.firstBlockingStepId).toBe('provider-validation');
    expect(status.primaryAction).toEqual({
      label: 'Re-check Providers',
      enabled: true,
      status: 'ready',
    });
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
