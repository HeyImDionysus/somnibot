import { describe, expect, it } from 'vitest';
import { type LauncherConfig } from '../main/config-store';
import {
  type VpsCommandRunResult,
  VpsDeploymentRunGate,
} from '../main/vps-deployment-executor';
import { handleVpsDeploymentRunRequest } from '../main/vps-deployment-request';
import { type VpsDeploymentCommand, type VpsDeploymentPlan } from '../main/vps-deployment-plan';

const completeConfig: LauncherConfig = {
  discordToken: 'discord-token',
  discordApplicationId: 'discord-app',
  discordClientSecret: 'discord-secret',
  discordGuildId: '',
  guilds: [],
  supabaseUrl: 'https://supabase.example.com',
  supabaseSecretKey: 'supabase-secret',
  supabasePublishableKey: 'supabase-publishable',
  supabaseDbPassword: '',
  supabaseAccessToken: 'supabase-management-token',
  supabaseDiscordAuthProviderConfigured: false,
  paypalClientId: 'paypal-client-id',
  paypalClientSecret: 'paypal-client-secret',
  paypalWebhookId: 'paypal-webhook-id',
  paypalSandbox: true,
  runtimeMode: 'vps',
  publicCallbackBaseUrl: 'https://somnibot.example.com',
  vpsDomain: 'somnibot.example.com',
  vpsSshHost: 'somnibot.example.com',
  vpsSshUser: 'deploy',
  vpsDeployPath: '/opt/somnibot',
  firstRunComplete: false,
  lavalinkEnabled: false,
  lastPids: { bot: null, dashboard: null, lavalink: null, valkey: null },
};

function approvalFor(plan: VpsDeploymentPlan) {
  return {
    operatorApproved: true,
    approvedCommandIds: plan.commands
      .filter((command) => command.approvalRequired)
      .map((command) => command.id),
  };
}

function successfulCommand(command: VpsDeploymentCommand): VpsCommandRunResult {
  if (command.expectedHealthStatus) {
    return { ok: true, output: JSON.stringify({ status: command.expectedHealthStatus }) };
  }

  return { ok: true };
}

describe('VPS deployment run request coordinator', () => {
  it('ignores renderer-supplied approvals for live VPS runs', async () => {
    let confirmCalls = 0;
    let runnerCreated = false;

    const result = await handleVpsDeploymentRunRequest(
      completeConfig,
      {
        dryRun: false,
        operatorApproved: true,
        approvedCommandIds: ['protect-env-file', 'start-stack'],
      },
      {
        confirmApproval: async () => {
          confirmCalls += 1;
          return { operatorApproved: false, approvedCommandIds: [] };
        },
        createCommandRunner: () => {
          runnerCreated = true;
          return async (command) => successfulCommand(command);
        },
        runGate: new VpsDeploymentRunGate(),
      },
    );

    expect(result.state).toBe('manual-blocked');
    expect(confirmCalls).toBe(1);
    expect(runnerCreated).toBe(false);
  });

  it('executes live commands when main-process approval confirms them', async () => {
    const executedCommandIds: string[] = [];

    const result = await handleVpsDeploymentRunRequest(
      completeConfig,
      {
        dryRun: false,
        operatorApproved: false,
        approvedCommandIds: [],
      },
      {
        confirmApproval: async (plan) => approvalFor(plan),
        createCommandRunner: () => async (command) => {
          executedCommandIds.push(command.id);
          return successfulCommand(command);
        },
        runGate: new VpsDeploymentRunGate(),
      },
    );

    expect(result.state).toBe('success');
    expect(executedCommandIds).toEqual([
      'enter-deploy-path',
      'protect-env-file',
      'start-stack',
      'check-stack',
      'check-health',
    ]);
  });

  it('does not use native approval or live runners for dry-run requests', async () => {
    const result = await handleVpsDeploymentRunRequest(
      completeConfig,
      {
        dryRun: true,
        operatorApproved: true,
        approvedCommandIds: ['protect-env-file', 'start-stack'],
      },
      {
        confirmApproval: async () => {
          throw new Error('native approval should not be requested for dry-runs');
        },
        createCommandRunner: () => {
          throw new Error('live command runner should not be created for dry-runs');
        },
        runGate: new VpsDeploymentRunGate(),
      },
    );

    expect(result.state).toBe('dry-run');
  });

  it('blocks VPS deployment requests until auth-provider setup is ready', async () => {
    const result = await handleVpsDeploymentRunRequest(
      {
        ...completeConfig,
        supabaseAccessToken: '',
        supabaseDiscordAuthProviderConfigured: false,
      },
      { dryRun: true },
      {
        confirmApproval: async () => {
          throw new Error('native approval should not be requested for blocked plans');
        },
        createCommandRunner: () => {
          throw new Error('live command runner should not be created for blocked plans');
        },
        runGate: new VpsDeploymentRunGate(),
      },
    );

    expect(result.state).toBe('blocked');
    expect(result.blockedReason).toContain('No execution plan is available');
  });

  it('single-flights concurrent live requests through the run gate', async () => {
    let confirmCalls = 0;
    let releaseApproval: (() => void) | undefined;
    const runGate = new VpsDeploymentRunGate();

    const runtime = {
      confirmApproval: async (plan: VpsDeploymentPlan) => {
        confirmCalls += 1;
        return new Promise<void>((resolve) => {
          releaseApproval = resolve;
        }).then(() => approvalFor(plan));
      },
      createCommandRunner: () => async (command: VpsDeploymentCommand) => successfulCommand(command),
      runGate,
    };

    const first = handleVpsDeploymentRunRequest(completeConfig, { dryRun: false }, runtime);
    const second = handleVpsDeploymentRunRequest(completeConfig, { dryRun: false }, runtime);

    expect(confirmCalls).toBe(1);
    expect(releaseApproval).toBeDefined();
    releaseApproval?.();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.state)).toEqual(['success', 'success']);
    expect(confirmCalls).toBe(1);
  });
});
