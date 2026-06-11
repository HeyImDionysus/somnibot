import { describe, expect, it } from 'vitest';
import { buildSetupStatus } from '../main/setup-flow';

const completeCredentials = { credentialReady: true };

describe('setup flow status', () => {
  it('blocks regular local setup before a Tailscale public callback URL is set', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      ...completeCredentials,
    });

    expect(status.runtimeMode).toBe('regular-local');
    expect(status.firstBlockingStepId).toBe('regular-callback');
    expect(status.primaryAction.enabled).toBe(false);
    expect(status.primaryAction.blockedReason).toContain('Tailscale');
    expect(status.summary.localDashboardUrl).toBe('http://localhost');
    expect(status.summary.localDashboardUrl).not.toContain(':3456');
    expect(status.summary.publicCallbackUrl).toBe('Not set yet');
    expect(status.summary.diagnostics.operatorDashboardUrl).toBe('http://localhost:3456');
  });

  it('enables regular local validation only after callback and credentials are ready', () => {
    const status = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      ...completeCredentials,
    });

    expect(status.primaryAction).toEqual({
      label: 'Validate & Start',
      enabled: true,
      status: 'ready',
    });
    expect(status.firstBlockingStepId).toBeNull();
    expect(status.steps.find(step => step.id === 'regular-callback')?.status).toBe('success');
    expect(status.summary.publicCallbackUrl).toBe('https://somnibot.tailnet.ts.net');
    expect(status.summary.diagnostics.authCallbackUrl).toBe('https://somnibot.tailnet.ts.net/api/auth/callback');
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
      'vps-deploy',
    ]);
    expect(status.steps.find(step => step.id === 'vps-domain')?.status).toBe('success');
    expect(status.steps.find(step => step.id === 'vps-ssh')?.status).toBe('success');
    expect(status.steps.find(step => step.id === 'vps-deploy')?.status).toBe('blocked');
    expect(status.steps.find(step => step.id === 'vps-deploy')?.manualAction).toBe(true);
    expect(status.primaryAction.enabled).toBe(false);
    expect(status.primaryAction.label).toBe('Manual VPS Deploy');
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
    expect(status.summary.localDashboardUrl).not.toContain(':3000');
    expect(status.summary.publicCallbackUrl).not.toContain(':3000');
    expect(status.summary.diagnostics.operatorDashboardUrl).toBe('https://somnibot.example.com:3000');
  });
});
