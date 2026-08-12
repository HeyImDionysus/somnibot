import { describe, expect, it } from 'vitest';
import type { LauncherConfig } from '../main/config-store';
import { VpsDeploymentRunGate, type VpsDeploymentCommandRunner } from '../main/vps-deployment-executor';
import {
  buildVpsRollbackPlanFromConfig,
  handleVpsRollbackRunRequest,
} from '../main/vps-rollback-request';

const config: LauncherConfig = {
  discordToken: 'discord-token',
  discordApplicationId: 'discord-application-id',
  discordClientSecret: 'discord-client-secret',
  discordGuildId: '',
  guilds: [],
  supabaseUrl: 'https://somnibot.supabase.co',
  supabaseSecretKey: 'supabase-secret-key',
  supabasePublishableKey: 'supabase-publishable-key',
  supabaseDbPassword: 'supabase-db-password',
  supabaseAccessToken: 'supabase-access-token',
  supabaseDiscordAuthProviderConfigured: false,
  paypalClientId: 'paypal-client-id',
  paypalClientSecret: 'paypal-client-secret',
  paypalWebhookId: 'paypal-webhook-id',
  paypalWebhookProofKey: '',
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

function approveAll(plan: ReturnType<typeof buildVpsRollbackPlanFromConfig>) {
  return {
    operatorApproved: true,
    approvedCommandIds: plan.commands.filter(command => command.approvalRequired).map(command => command.id),
  };
}

const successfulRunner: VpsDeploymentCommandRunner = async (command) => (
  command.expectedHealthStatus ? { ok: true, output: JSON.stringify({ status: command.expectedHealthStatus }) } : { ok: true }
);

describe('VPS rollback request coordinator', () => {
  it('blocks incomplete credentials and missing Supabase auth setup with deployment readiness warnings', () => {
    const incompleteConfig: LauncherConfig = {
      ...config,
      discordToken: '',
      paypalClientSecret: '',
      supabaseAccessToken: '',
      supabaseDiscordAuthProviderConfigured: false,
    };

    const plan = buildVpsRollbackPlanFromConfig(incompleteConfig, 'b'.repeat(40));

    expect(plan.status).toBe('blocked');
    expect(plan.blockedReasons).toContain(
      'Supabase Discord auth provider setup requires a Management API token or manual provider confirmation before VPS deployment.',
    );
    expect(plan.warnings).toEqual(expect.arrayContaining([
      'Credential fields are not complete yet; the deployment plan will keep secret values as placeholders.',
      'PayPal app/webhook fields are not complete yet; store payments will stay disabled until PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and PAYPAL_WEBHOOK_ID are set.',
    ]));
  });

  it('requires an exact SHA and executes restore before checkout, rebuild, and health verification after approval', async () => {
    const lastGoodCommit = 'c'.repeat(40);
    const executed: string[] = [];
    const audits: Array<{ action: string; success?: boolean }> = [];
    const plan = buildVpsRollbackPlanFromConfig(config, lastGoodCommit);

    const result = await handleVpsRollbackRunRequest(config, { lastGoodCommit }, {
      confirmApproval: async (approvedPlan) => approveAll(approvedPlan),
      createCommandRunner: () => async (command) => {
        executed.push(command.id);
        return successfulRunner(command);
      },
      runGate: new VpsDeploymentRunGate(),
      recordAudit: (entry) => audits.push(entry),
    });

    expect(plan.status).toBe('ready');
    expect(plan.commands.map(command => command.id)).toEqual([
      'rollback-fetch',
      'rollback-restore-env',
      'rollback-checkout',
      'rollback-rebuild',
      'rollback-health',
    ]);
    expect(plan.commands.find(command => command.id === 'rollback-checkout')?.args).toContain(lastGoodCommit);
    expect(result.state).toBe('success');
    expect(executed).toEqual(plan.commands.map(command => command.id));
    expect(audits.map(audit => audit.action)).toEqual([
      'launcher.vps_rollback.approval_decision',
      'launcher.vps_rollback.executed',
    ]);
  });

  it('rejects placeholders before approval or remote execution', async () => {
    let confirmCalls = 0;
    let runnerCalls = 0;
    const result = await handleVpsRollbackRunRequest(config, { lastGoodCommit: '<last-good-commit>' }, {
      confirmApproval: async () => {
        confirmCalls += 1;
        return { operatorApproved: true, approvedCommandIds: [] };
      },
      createCommandRunner: () => async () => {
        runnerCalls += 1;
        return { ok: true };
      },
      runGate: new VpsDeploymentRunGate(),
    });

    expect(result.state).toBe('blocked');
    expect(confirmCalls).toBe(0);
    expect(runnerCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain('<last-good-commit>');
  });

  it('cancels without opening approval or creating a command runner', async () => {
    let confirmCalls = 0;
    let runnerCalls = 0;
    const result = await handleVpsRollbackRunRequest(config, {
      lastGoodCommit: 'd'.repeat(40),
      cancelRequested: true,
    }, {
      confirmApproval: async () => {
        confirmCalls += 1;
        return { operatorApproved: true, approvedCommandIds: [] };
      },
      createCommandRunner: () => async () => {
        runnerCalls += 1;
        return { ok: true };
      },
      runGate: new VpsDeploymentRunGate(),
    });

    expect(result.state).toBe('cancelled');
    expect(confirmCalls).toBe(0);
    expect(runnerCalls).toBe(0);
  });
});
