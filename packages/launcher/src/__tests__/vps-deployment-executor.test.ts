import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type VpsCommandRunResult,
  type VpsDeploymentExecutionResult,
  VpsDeploymentRunGate,
  redactVpsDeploymentText,
  runVpsDeployment,
} from '../main/vps-deployment-executor';
import { buildVpsDeploymentPlan, type VpsDeploymentCommand } from '../main/vps-deployment-plan';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..');

const completeVpsInput = {
  runtimeMode: 'vps',
  vpsDomain: 'somnibot.example.com',
  vpsSshHost: 'somnibot.example.com',
  vpsSshUser: 'deploy',
  vpsDeployPath: '/opt/somnibot',
  credentialReady: true,
  supabaseAccessTokenReady: true,
};

function buildRequestOverrides(plan = buildVpsDeploymentPlan(completeVpsInput)) {
  return {
    plan,
    operatorApproved: true,
    approvedCommandIds: plan.commands.filter((command) => command.approvalRequired).map((command) => command.id),
  };
}

function successfulCommandResult(command: VpsDeploymentCommand): VpsCommandRunResult {
  if (command.expectedHealthStatus) {
    return { ok: true, output: JSON.stringify({ status: command.expectedHealthStatus }) };
  }
  return { ok: true };
}

function executionResult(state: VpsDeploymentExecutionResult['state']): VpsDeploymentExecutionResult {
  return {
    state,
    planStatus: 'ready',
    canRetry: false,
    commandStates: [],
    logs: [],
    manualBlockReasons: [],
    redactedOutput: [],
  };
}

describe('VPS deployment execution bridge', () => {
  it('redacts shared deployment/preflight text surfaces', () => {
    const secret = 'sb_secret_XXXXXXXXXXXXXXXXX';
    const accessToken = 'sbp_abcdefghijklmnopqrstuvwxyz123456';
    const redacted = redactVpsDeploymentText(`token=${secret} SUPABASE_ACCESS_TOKEN=${accessToken} header Bearer ${secret}`);

    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(accessToken);
    expect(redacted).toContain('[redacted]');
  });

  it('defaults to dry-run when no command runner is supplied', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const result = await runVpsDeployment(buildRequestOverrides(plan));

    expect(result.state).toBe('dry-run');
    expect(result.canRetry).toBe(true);
    expect(result.planStatus).toBe('ready');
    expect(result.logs.some((log) => log.code === 'vps-deployment-dry-run')).toBe(true);
    expect(result.commandStates.some((command) => command.status === 'skipped')).toBe(true);
  });

  it('does not invoke the command runner while in dry-run mode', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    let commandCalls = 0;
    const result = await runVpsDeployment({
      ...buildRequestOverrides(plan),
      dryRun: true,
      commandRunner: async () => {
        commandCalls += 1;
        return { ok: true };
      },
    });

    expect(result.state).toBe('dry-run');
    expect(commandCalls).toBe(0);
  });

  it('requires explicit operator approval before any live execution path is available', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const result = await runVpsDeployment({
      ...buildRequestOverrides(plan),
      operatorApproved: false,
    });

    expect(result.state).toBe('manual-blocked');
    expect(result.manualBlockReasons.join(' ')).toContain('explicit GUI/operator approval');
  });

  it('represents missing per-command approvals as manual-blocked', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const request = buildRequestOverrides(plan);
    const result = await runVpsDeployment({
      ...request,
      approvedCommandIds: request.approvedCommandIds.slice(0, 1),
    });

    expect(result.state).toBe('manual-blocked');
    expect(result.manualBlockReasons.join(' ')).toContain('Missing explicit approval');
  });

  it('keeps logs/progress redacted when command output contains secrets', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const request = buildRequestOverrides(plan);
    const secret = 'sb_secret_XXXXXXXXXXXXXXXXX';

    const result = await runVpsDeployment({
      ...request,
      dryRun: false,
      commandRunner: async (command) => {
        if (command.id === 'check-stack') {
          return {
            ok: true,
            output: `Probe used token ${secret} and header Bearer ${secret}`,
          };
        }

        return successfulCommandResult(command);
      },
    });

    expect(result.state).toBe('success');
    expect(JSON.stringify(result.logs)).not.toContain(secret);
    expect(JSON.stringify(result.redactedOutput ?? [])).not.toContain(secret);
    expect(result.commandStates.find((command) => command.commandId === 'check-stack')?.detail).not.toContain(secret);
  });

  it('hands live runners SSH-wrapped remote commands instead of local docker or chmod commands', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const executedCommands: Array<{ id: string; executable: string; args: string[] }> = [];

    const result = await runVpsDeployment({
      ...buildRequestOverrides(plan),
      dryRun: false,
      commandRunner: async (command) => {
        executedCommands.push({ id: command.id, executable: command.executable, args: command.args });
        return successfulCommandResult(command);
      },
    });

    expect(result.state).toBe('success');
    expect(result.healthProof).toMatchObject({
      httpsDashboardProbe: { state: 'success', httpStatus: 200 },
      apiHealthProbe: {
        state: 'success',
        httpStatus: 200,
        response: { status: 'healthy' },
      },
      lavalink: {
        status: 'pass',
      },
    });
    expect(executedCommands.find(command => command.id === 'check-dashboard')).toMatchObject({
      executable: 'curl',
      args: ['-fsS', '-o', '/dev/null', 'https://somnibot.example.com'],
    });
    expect(executedCommands.find(command => command.id === 'check-lavalink')).toMatchObject({
      executable: 'ssh',
      args: expect.arrayContaining(['deploy@somnibot.example.com', 'sh', '-lc']),
    });
    expect(executedCommands.find(command => command.id === 'protect-env-file')).toMatchObject({
      executable: 'ssh',
      args: expect.arrayContaining(['deploy@somnibot.example.com', 'chmod', '0600', '/opt/somnibot/.env']),
    });
    expect(executedCommands.find(command => command.id === 'start-stack')).toMatchObject({
      executable: 'ssh',
      args: expect.arrayContaining(['deploy@somnibot.example.com', 'docker', 'compose', '-f', '/opt/somnibot/docker-compose.prod.yml']),
    });
  });

  it('returns retry when the public health endpoint reports degraded JSON', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const result = await runVpsDeployment({
      ...buildRequestOverrides(plan),
      dryRun: false,
      commandRunner: async (command) => {
        if (command.id === 'check-health') {
          return { ok: true, output: JSON.stringify({ status: 'degraded' }) };
        }

        return successfulCommandResult(command);
      },
    });

    expect(result.state).toBe('retry');
    expect(result.canRetry).toBe(true);
    expect(result.logs.some((log) => log.code === 'vps-deployment-health-retry')).toBe(true);
    expect(result.commandStates.find((command) => command.commandId === 'check-health')).toMatchObject({
      status: 'failed',
      detail: 'Command check-health returned health status degraded; expected healthy.',
    });
  });

  it('returns cancellation state without changing command output when user cancels before run', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const result = await runVpsDeployment({
      ...buildRequestOverrides(plan),
      dryRun: false,
      cancelRequested: true,
      commandRunner: async () => ({ ok: true }),
    });

    expect(result.state).toBe('cancelled');
    expect(result.canRetry).toBe(true);
    expect(result.logs.some((log) => log.code === 'vps-deployment-cancelled')).toBe(true);
  });

  it('returns failure when a command fails and is marked non-retriable', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const result = await runVpsDeployment({
      ...buildRequestOverrides(plan),
      dryRun: false,
      commandRunner: async (command) => {
        if (command.id === 'start-stack') {
          return {
            ok: false,
            exitCode: 1,
            error: 'ssh refused secret',
            retriable: false,
          };
        }

        return { ok: true };
      },
    });

    expect(result.state).toBe('failure');
    expect(result.canRetry).toBe(false);
    expect(result.logs.some((log) => log.code === 'vps-deployment-failure')).toBe(true);
    expect(result.commandStates.find((command) => command.commandId === 'start-stack')?.status).toBe('failed');
  });

  it('returns an immediately executable approved rollback path after a post-env-write failure', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const approvedCommandIds = plan.commands.filter(command => command.approvalRequired).map(command => command.id);
    const result = await runVpsDeployment({
      plan,
      operatorApproved: true,
      approvedCommandIds,
      dryRun: false,
      commandRunner: async (command) => command.id === 'start-stack'
        ? { ok: false, error: 'simulated container build failure', retriable: false }
        : { ok: true },
    });

    expect(result.state).toBe('failure');
    expect(result.recovery).toEqual({
      action: 'vps:run-rollback',
      detail: 'The protected environment write may have completed. Run the approved rollback action with an exact last-good commit SHA before retrying deployment.',
    });
  });

  it('returns retry state for transient failures and allows re-run', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const result = await runVpsDeployment({
      ...buildRequestOverrides(plan),
      dryRun: false,
      commandRunner: async (command) => {
        if (command.id === 'start-stack') {
          return {
            ok: false,
            exitCode: 255,
            error: 'SSH timeout while waiting',
            retriable: true,
          };
        }

        return { ok: true };
      },
    });

    expect(result.state).toBe('retry');
    expect(result.canRetry).toBe(true);
    expect(result.logs.some((log) => log.code === 'vps-deployment-retry')).toBe(true);
  });

  it('coalesces concurrent live invocations and resets after completion', async () => {
    const gate = new VpsDeploymentRunGate();
    const firstResult = executionResult('success');
    const secondResult = executionResult('dry-run');
    let runnerCalls = 0;
    let releaseFirst: ((result: VpsDeploymentExecutionResult) => void) | undefined;

    const first = gate.run(() => {
      runnerCalls += 1;
      return new Promise<VpsDeploymentExecutionResult>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const concurrent = gate.run(async () => {
      runnerCalls += 1;
      return secondResult;
    });

    expect(concurrent).toBe(first);
    expect(runnerCalls).toBe(1);
    expect(releaseFirst).toBeDefined();
    releaseFirst?.(firstResult);
    await expect(concurrent).resolves.toBe(firstResult);

    await expect(gate.run(async () => {
      runnerCalls += 1;
      return secondResult;
    })).resolves.toBe(secondResult);
    expect(runnerCalls).toBe(2);
  });

  it('contains no shell-string command execution primitives by default', () => {
    const source = readFileSync(path.join(srcDir, 'main', 'vps-deployment-executor.ts'), 'utf8');

    expect(source).not.toContain('node:child_process');
    expect(source).not.toContain('spawn(');
    expect(source).not.toContain('exec(');
    expect(source).not.toContain('execFile');
  });
});
