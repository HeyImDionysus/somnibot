import { describe, expect, it } from 'vitest';
import { parseEnv } from 'node:util';
import { type LauncherConfig } from '../main/config-store';
import {
  type VpsCommandRunResult,
  VpsDeploymentRunGate,
} from '../main/vps-deployment-executor';
import { buildVpsDeploymentPlanFromConfig, handleVpsDeploymentRunRequest } from '../main/vps-deployment-request';
import { type VpsDeploymentCommand, type VpsDeploymentPlan } from '../main/vps-deployment-plan';
import { dotenvValue } from '../main/vps-env-materializer';

const completeConfig: LauncherConfig = {
  discordToken: 'discord-token',
  discordApplicationId: 'discord-app',
  discordClientSecret: 'discord-secret',
  discordGuildId: '',
  guilds: [],
  supabaseUrl: 'https://projectref.supabase.co',
  supabaseSecretKey: 'supabase-secret',
  supabasePublishableKey: 'supabase-publishable',
  supabaseDbPassword: 'database-password',
  supabaseAccessToken: 'supabase-management-token',
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
        persistGeneratedSecrets: async () => {},
      },
    );

    expect(result.state).toBe('manual-blocked');
    expect(confirmCalls).toBe(1);
    expect(runnerCreated).toBe(false);
  });

  it('executes live commands when main-process approval confirms them', async () => {
    const executedCommandIds: string[] = [];
    let handoffCalls = 0;

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
        persistGeneratedSecrets: async () => {},
        runApprovedDeployment: async (execute) => {
          handoffCalls += 1;
          return execute();
        },
      },
    );

    expect(result.state).toBe('success');
    expect(handoffCalls).toBe(1);
    expect(executedCommandIds).toEqual([
      'enter-deploy-path',
      'write-env-file',
      'protect-env-file',
      'start-stack',
      'install-health-recovery',
      'check-stack',
      'check-dashboard',
      'check-health',
      'check-lavalink',
    ]);
  });

  it('streams saved credentials to the VPS env writer without placing them in argv or results', async () => {
    let envWriter: VpsDeploymentCommand | undefined;

    const result = await handleVpsDeploymentRunRequest(
      completeConfig,
      { dryRun: false },
      {
        confirmApproval: async (plan) => approvalFor(plan),
        createCommandRunner: () => async (command) => {
          if (command.id === 'write-env-file') envWriter = command;
          return successfulCommand(command);
        },
        runGate: new VpsDeploymentRunGate(),
        persistGeneratedSecrets: async () => {},
      },
    );

    expect(result.state).toBe('success');
    expect(envWriter?.sensitiveStdin).toContain("DISCORD_TOKEN='discord-token'");
    expect(envWriter?.sensitiveStdin).toContain("PAYPAL_CLIENT_SECRET='paypal-client-secret'");
    expect(envWriter?.sensitiveStdin).toContain("SUPABASE_DB_URL='postgresql://postgres:database-password@db.projectref.supabase.co:5432/postgres'");
    expect(envWriter?.args.join(' ')).not.toContain('discord-token');
    expect(envWriter?.redactedDisplay).not.toContain('paypal-client-secret');
    expect(JSON.stringify(result)).not.toContain('database-password');
  });

  it('keeps dry-run plans placeholder-only and never attaches credential stdin', async () => {
    const plan = buildVpsDeploymentPlanFromConfig(completeConfig);

    expect(plan.environment?.redactedEnvFile).toContain('SUPABASE_DB_URL=<SUPABASE_DB_URL>');
    expect(plan.commands.find((command) => command.id === 'write-env-file')?.sensitiveStdin).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain(completeConfig.discordToken);
    expect(JSON.stringify(plan)).not.toContain(completeConfig.paypalClientSecret);
  });

  it('serializes dotenv special characters without changing backslashes', () => {
    const original = "back\\slash'quote$dollar#hash and spaces";

    expect(dotenvValue(original)).toBe("'back\\slash\\'quote$dollar#hash and spaces'");
  });

  it('persists one generated service-secret generation and reuses it on retry', async () => {
    const retryConfig: LauncherConfig = { ...completeConfig };
    const envPayloads: string[] = [];
    let persistCalls = 0;
    const events: string[] = [];
    const runtime = {
      confirmApproval: async (plan: VpsDeploymentPlan) => {
        events.push('confirm');
        return approvalFor(plan);
      },
      createCommandRunner: () => async (command: VpsDeploymentCommand) => {
        if (command.id === 'write-env-file') envPayloads.push(command.sensitiveStdin ?? '');
        return successfulCommand(command);
      },
      runGate: new VpsDeploymentRunGate(),
      persistGeneratedSecrets: async (patch: Partial<LauncherConfig>) => {
        events.push('persist');
        persistCalls += 1;
        Object.assign(retryConfig, patch);
      },
    };

    await handleVpsDeploymentRunRequest(retryConfig, { dryRun: false }, runtime);
    await handleVpsDeploymentRunRequest(retryConfig, { dryRun: false }, runtime);

    expect(persistCalls).toBe(1);
    expect(events.slice(0, 2)).toEqual(['confirm', 'persist']);
    expect(envPayloads).toHaveLength(2);
    for (const key of ['CSRF_SECRET', 'NEXTAUTH_SECRET', 'WEBHOOK_REPLAY_SECRET', 'VALKEY_PASSWORD', 'LAVALINK_PASSWORD']) {
      const value = parseEnv(envPayloads[0] ?? '')[key];
      expect(value).toBeTruthy();
      expect(parseEnv(envPayloads[1] ?? '')[key]).toBe(value);
    }
    const firstHolder = parseEnv(envPayloads[0] ?? '').SOMNIBOT_RUNTIME_HOLDER_ID;
    expect(firstHolder).toMatch(/^[a-f0-9]{64}$/);
    expect(parseEnv(envPayloads[1] ?? '').SOMNIBOT_RUNTIME_HOLDER_ID).toBe(firstHolder);
  });

  it('allows VPS mechanics without PayPal while leaving payments disabled', async () => {
    let envPayload = '';
    const result = await handleVpsDeploymentRunRequest(
      {
        ...completeConfig,
        paypalClientId: '',
        paypalClientSecret: '',
        paypalWebhookId: '',
      },
      { dryRun: false },
      {
        confirmApproval: async (plan) => approvalFor(plan),
        createCommandRunner: () => async (command) => {
          if (command.id === 'write-env-file') envPayload = command.sensitiveStdin ?? '';
          return successfulCommand(command);
        },
        runGate: new VpsDeploymentRunGate(),
        persistGeneratedSecrets: async () => {},
      },
    );

    expect(result.state).toBe('success');
    expect(parseEnv(envPayload).PAYPAL_CLIENT_ID).toBe('');
    expect(parseEnv(envPayload).PAYPAL_CLIENT_SECRET).toBe('');
  });

  it('runs no remote command when generated service secrets cannot be persisted', async () => {
    let approvalCalls = 0;
    let runnerCalls = 0;
    const result = await handleVpsDeploymentRunRequest(
      { ...completeConfig },
      { dryRun: false },
      {
        confirmApproval: async (plan) => {
          approvalCalls += 1;
          return approvalFor(plan);
        },
        createCommandRunner: () => async (command) => {
          runnerCalls += 1;
          return successfulCommand(command);
        },
        runGate: new VpsDeploymentRunGate(),
        persistGeneratedSecrets: async () => {
          throw new Error('simulated local keychain failure');
        },
      },
    );

    expect(result.state).toBe('blocked');
    expect(approvalCalls).toBe(1);
    expect(runnerCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain('simulated local keychain failure');
  });

  it('cancelling before approval performs no persistence, sync, audit, or remote execution', async () => {
    let confirmCalls = 0;
    let persistCalls = 0;
    let runnerCalls = 0;
    const audits: unknown[] = [];
    const result = await handleVpsDeploymentRunRequest(
      { ...completeConfig },
      { dryRun: false, cancelRequested: true, operatorApproved: true },
      {
        confirmApproval: async () => {
          confirmCalls += 1;
          return { operatorApproved: true, approvedCommandIds: [] };
        },
        createCommandRunner: () => async () => {
          runnerCalls += 1;
          return { ok: true };
        },
        runGate: new VpsDeploymentRunGate(),
        persistGeneratedSecrets: async () => {
          persistCalls += 1;
        },
        recordAudit: (entry) => audits.push(entry),
      },
    );

    expect(result.state).toBe('cancelled');
    expect(confirmCalls).toBe(0);
    expect(persistCalls).toBe(0);
    expect(runnerCalls).toBe(0);
    expect(audits).toEqual([]);
  });

  it('does not use native approval or live runners for dry-run requests', async () => {
    const result = await handleVpsDeploymentRunRequest(
      completeConfig,
      {
        dryRun: true,
        operatorApproved: true,
        approvedCommandIds: ['write-env-file', 'protect-env-file', 'start-stack', 'install-health-recovery'],
      },
      {
        confirmApproval: async () => {
          throw new Error('native approval should not be requested for dry-runs');
        },
        createCommandRunner: () => {
          throw new Error('live command runner should not be created for dry-runs');
        },
        runGate: new VpsDeploymentRunGate(),
        persistGeneratedSecrets: async () => {},
        runApprovedDeployment: async () => {
          throw new Error('runtime handoff should not run for dry-runs');
        },
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
        persistGeneratedSecrets: async () => {},
      },
    );

    expect(result.state).toBe('blocked');
    expect(result.blockedReason).toContain('No execution plan is available');
  });

  it('records approval-decision and execution audit entries for a live approved run', async () => {
    const audits: Array<{ action: string; success?: boolean }> = [];

    const result = await handleVpsDeploymentRunRequest(
      completeConfig,
      { dryRun: false, operatorApproved: false, approvedCommandIds: [] },
      {
        confirmApproval: async (plan) => approvalFor(plan),
        createCommandRunner: () => async (command) => successfulCommand(command),
        runGate: new VpsDeploymentRunGate(),
        persistGeneratedSecrets: async () => {},
        recordAudit: (entry) => audits.push(entry),
      },
    );

    expect(result.state).toBe('success');
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('launcher.vps_deployment.approval_decision');
    expect(actions).toContain('launcher.vps_deployment.executed');
    expect(audits.find((a) => a.action === 'launcher.vps_deployment.approval_decision')?.success).toBe(true);
    expect(audits.find((a) => a.action === 'launcher.vps_deployment.executed')?.success).toBe(true);
  });

  it('records a denied approval decision and skips the execution audit', async () => {
    const audits: Array<{ action: string; success?: boolean }> = [];

    const result = await handleVpsDeploymentRunRequest(
      completeConfig,
      { dryRun: false, operatorApproved: true, approvedCommandIds: ['start-stack'] },
      {
        confirmApproval: async () => ({ operatorApproved: false, approvedCommandIds: [] }),
        createCommandRunner: () => async (command) => successfulCommand(command),
        runGate: new VpsDeploymentRunGate(),
        persistGeneratedSecrets: async () => {},
        recordAudit: (entry) => audits.push(entry),
      },
    );

    expect(result.state).toBe('manual-blocked');
    const decision = audits.find((a) => a.action === 'launcher.vps_deployment.approval_decision');
    expect(decision?.success).toBe(false);
    expect(audits.some((a) => a.action === 'launcher.vps_deployment.executed')).toBe(false);
  });

  it('does not emit audit entries for dry-run requests', async () => {
    const audits: Array<{ action: string }> = [];

    await handleVpsDeploymentRunRequest(
      completeConfig,
      { dryRun: true, operatorApproved: true, approvedCommandIds: ['start-stack'] },
      {
        confirmApproval: async () => {
          throw new Error('native approval should not be requested for dry-runs');
        },
        createCommandRunner: () => {
          throw new Error('live command runner should not be created for dry-runs');
        },
        runGate: new VpsDeploymentRunGate(),
        persistGeneratedSecrets: async () => {},
        recordAudit: (entry) => audits.push(entry),
      },
    );

    expect(audits).toEqual([]);
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
      persistGeneratedSecrets: async () => {},
    };

    const first = handleVpsDeploymentRunRequest(completeConfig, { dryRun: false }, runtime);
    const second = handleVpsDeploymentRunRequest(completeConfig, { dryRun: false }, runtime);

    await Promise.resolve();
    await Promise.resolve();

    expect(confirmCalls).toBe(1);
    expect(releaseApproval).toBeDefined();
    releaseApproval?.();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.state)).toEqual(['success', 'success']);
    expect(confirmCalls).toBe(1);
  });
});
