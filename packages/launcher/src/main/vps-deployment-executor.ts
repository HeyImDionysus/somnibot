import { type VpsDeploymentCommand, type VpsDeploymentPlan, type VpsDeploymentPlanStatus } from './vps-deployment-plan.js';
import type {
  VpsDashboardHealthPayload,
  VpsHealthProbeResult,
  VpsManualHealthSignal,
} from './vps-health-verification.js';

export type VpsDeploymentExecutionState =
  | 'blocked'
  | 'manual-blocked'
  | 'dry-run'
  | 'running'
  | 'retry'
  | 'cancelled'
  | 'failure'
  | 'success';

export type VpsDeploymentExecutionLogLevel = 'info' | 'warn' | 'error';

export interface VpsDeploymentExecutionLog {
  level: VpsDeploymentExecutionLogLevel;
  code: string;
  message: string;
  detail?: string;
}

export interface VpsDeploymentCommandExecutionState {
  commandId: string;
  executable: string;
  redactedDisplay: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
  detail?: string;
}

export interface VpsCommandRunResult {
  ok: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
  retriable?: boolean;
}

export interface VpsDeploymentHealthProof {
  httpsDashboardProbe?: VpsHealthProbeResult;
  apiHealthProbe?: VpsHealthProbeResult;
  lavalink?: VpsManualHealthSignal;
}

export type VpsDeploymentCommandRunner = (
  command: VpsDeploymentCommand,
  _meta: { index: number; total: number; }
) => Promise<VpsCommandRunResult>;

export interface VpsDeploymentExecutionInput {
  plan: VpsDeploymentPlan;
  operatorApproved: boolean;
  approvedCommandIds: string[];
  dryRun?: boolean;
  cancelRequested?: boolean;
  commandRunner?: VpsDeploymentCommandRunner;
}

export interface VpsDeploymentExecutionResult {
  state: VpsDeploymentExecutionState;
  planStatus: VpsDeploymentPlanStatus;
  canRetry: boolean;
  commandStates: VpsDeploymentCommandExecutionState[];
  logs: VpsDeploymentExecutionLog[];
  manualBlockReasons: string[];
  blockedReason?: string;
  redactedOutput?: string[];
  healthProof?: VpsDeploymentHealthProof;
}

export class VpsDeploymentRunGate {
  private active: Promise<VpsDeploymentExecutionResult> | null = null;

  run(execute: () => Promise<VpsDeploymentExecutionResult>): Promise<VpsDeploymentExecutionResult> {
    if (this.active) return this.active;

    let active: Promise<VpsDeploymentExecutionResult> | null = null;
    const clearActive = (): void => {
      if (active && this.active === active) {
        this.active = null;
      }
    };

    active = execute().then(
      (result) => {
        clearActive();
        return result;
      },
      (error: unknown) => {
        clearActive();
        throw error;
      },
    );
    this.active = active;
    return active;
  }
}

const REDACTED_PATTERNS = [
  /(DISCORD_TOKEN|DISCORD_CLIENT_SECRET|SUPABASE_SECRET_KEY|SUPABASE_ACCESS_TOKEN|PAYPAL_CLIENT_SECRET|PAYPAL_WEBHOOK_ID|VALKEY_PASSWORD|LAVALINK_PASSWORD|NEXTAUTH_SECRET|CSRF_SECRET|WEBHOOK_REPLAY_SECRET)=[^\s,;]+/g,
  /(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi,
  /([A-Za-z0-9._-]{30,})=([A-Za-z0-9._~+\/-]{8,})/g,
  /sb_secret_[A-Za-z0-9._-]+/g,
  /(redis:\/\/):[^@]+(@valkey:6379)/g,
];

export function redactVpsDeploymentText(value: string): string {
  return REDACTED_PATTERNS.reduce((next, pattern) => next.replace(pattern, '$1[redacted]'), value);
}

function redactText(value: string): string {
  return redactVpsDeploymentText(value);
}

function commandRequiresApproval(command: VpsDeploymentCommand, approvedCommandIds: Set<string>): boolean {
  return !command.approvalRequired || approvedCommandIds.has(command.id);
}

function commandExecutionState(command: VpsDeploymentCommand): VpsDeploymentCommandExecutionState {
  return {
    commandId: command.id,
    executable: command.executable,
    redactedDisplay: command.redactedDisplay,
    status: 'pending',
  };
}

function createLogs(state: VpsDeploymentExecutionState, detail: string): VpsDeploymentExecutionLog[] {
  const level: VpsDeploymentExecutionLogLevel = state === 'failure' || state === 'manual-blocked' || state === 'cancelled' ? 'error' : 'info';
  const code = `vps-deployment-${state}`;
  return [{ level, code, message: `VPS deployment execution state: ${state}`, detail: redactText(detail) }];
}

function validateExpectedHealthStatus(command: VpsDeploymentCommand, output: string | undefined): string | null {
  if (!command.expectedHealthStatus) return null;
  if (!output) {
    return `Command ${command.id} did not return health JSON.`;
  }

  try {
    const parsed = JSON.parse(output);
    if (parsed?.status === command.expectedHealthStatus) {
      return null;
    }
    return `Command ${command.id} returned health status ${String(parsed?.status ?? 'missing')}; expected ${command.expectedHealthStatus}.`;
  } catch {
    return `Command ${command.id} did not return parseable health JSON.`;
  }
}

function healthProofFromCommand(command: VpsDeploymentCommand, output: string | undefined): VpsDeploymentHealthProof | undefined {
  if (command.id === 'check-dashboard') {
    return {
      httpsDashboardProbe: { state: 'success', httpStatus: 200 },
    };
  }

  if (command.id === 'check-lavalink') {
    return {
      lavalink: {
        status: 'pass',
        detail: 'The read-only deployment probe reached Lavalink from inside the VPS stack.',
      },
    };
  }

  if (!command.expectedHealthStatus) return undefined;

  let response: VpsDashboardHealthPayload | undefined;
  try {
    response = output ? JSON.parse(output) as VpsDashboardHealthPayload : undefined;
  } catch {
    response = undefined;
  }

  return {
    apiHealthProbe: {
      state: 'success',
      httpStatus: 200,
      ...(response ? { response } : {}),
    },
  };
}

export async function runVpsDeployment(input: VpsDeploymentExecutionInput): Promise<VpsDeploymentExecutionResult> {
  const approvedCommandIds = new Set(input.approvedCommandIds);
  const commandStates: VpsDeploymentCommandExecutionState[] = input.plan.commands.map(commandExecutionState);
  const manualBlockReasons: string[] = [];
  let healthProof: VpsDeploymentHealthProof | undefined;

  if (input.plan.status !== 'ready') {
    return {
      state: 'blocked',
      planStatus: input.plan.status,
      canRetry: false,
      commandStates,
      logs: createLogs('blocked', 'VPS deployment plan is blocked; no execution plan is available.'),
      manualBlockReasons: ['No execution plan is available until the deployment plan is ready.'],
      blockedReason: 'No execution plan is available until the deployment plan is ready.',
      redactedOutput: [],
    };
  }

  if (!input.operatorApproved) {
    manualBlockReasons.push('An explicit GUI/operator approval action is required before executing VPS deployment commands.');
    return {
      state: 'manual-blocked',
      planStatus: input.plan.status,
      canRetry: false,
      commandStates,
      logs: createLogs('manual-blocked', manualBlockReasons.join(' ')),
      manualBlockReasons,
      blockedReason: manualBlockReasons.join(' '),
      redactedOutput: [],
    };
  }

  const missingApprovals = input.plan.commands
    .filter((command) => command.approvalRequired && !approvedCommandIds.has(command.id));
  if (missingApprovals.length > 0) {
    const missing = missingApprovals.map((command) => command.id);
    manualBlockReasons.push(`Missing explicit approval for approval-required commands: ${missing.join(', ')}.`);
    return {
      state: 'manual-blocked',
      planStatus: input.plan.status,
      canRetry: false,
      commandStates,
      logs: createLogs('manual-blocked', manualBlockReasons.join(' ')),
      manualBlockReasons,
      blockedReason: manualBlockReasons.join(' '),
      redactedOutput: [],
    };
  }

  if (input.cancelRequested) {
    return {
      state: 'cancelled',
      planStatus: input.plan.status,
      canRetry: true,
      commandStates,
      logs: createLogs('cancelled', 'Execution was cancelled before commands ran.'),
      manualBlockReasons: [],
      blockedReason: 'Execution cancelled.',
      redactedOutput: [],
    };
  }

  if (input.dryRun || !input.commandRunner) {
    return {
      state: 'dry-run',
      planStatus: input.plan.status,
      canRetry: true,
      commandStates: input.plan.commands.map((command) => ({
        ...commandExecutionState(command),
        status: commandRequiresApproval(command, approvedCommandIds)
          ? 'skipped'
          : 'pending',
        detail: commandRequiresApproval(command, approvedCommandIds)
          ? 'Would run command in dry-run mode (no live execution).' : 'Approval not provided.',
      })),
      logs: createLogs('dry-run', 'Execution is in dry-run mode. No live SSH, network, or provider writes occur.'),
      manualBlockReasons: [],
      redactedOutput: [],
    };
  }

  const logs: VpsDeploymentExecutionLog[] = [{
    level: 'info',
    code: 'vps-deployment-running',
    message: 'VPS deployment execution started.',
    detail: 'Commands will run using structured SSH command arrays.',
  }];

  for (let index = 0; index < input.plan.commands.length; index += 1) {
    const command = input.plan.commands[index];
    const state = commandStates[index];
    if (!commandRequiresApproval(command, approvedCommandIds)) {
      state.status = 'skipped';
      state.detail = 'No approval provided for an approval-required command.';
      continue;
    }

    state.status = 'running';
    const result = await input.commandRunner(command, { index, total: input.plan.commands.length });
    if (!result.ok) {
      const retriable = Boolean(result.retriable);
      state.status = 'failed';
      state.detail = redactText(result.error || 'Command failed.');

      const terminalState: VpsDeploymentExecutionState = retriable ? 'retry' : 'failure';
      return {
        state: terminalState,
        planStatus: input.plan.status,
        canRetry: retriable,
        commandStates,
        logs: [
          ...logs,
          {
            level: 'error',
            code: retriable ? 'vps-deployment-retry' : 'vps-deployment-failure',
            message: `Command ${command.id} failed with exitCode=${result.exitCode ?? 'n/a'}`,
            detail: state.detail,
          },
        ],
        manualBlockReasons: [],
        redactedOutput: result.output ? [redactText(result.output)] : undefined,
      };
    }

    state.status = 'success';
    state.detail = result.output ? redactText(result.output) : 'Command completed.';
    const healthStatusError = validateExpectedHealthStatus(command, result.output);
    if (healthStatusError) {
      state.status = 'failed';
      state.detail = healthStatusError;
      return {
        state: 'retry',
        planStatus: input.plan.status,
        canRetry: true,
        commandStates,
        logs: [
          ...logs,
          {
            level: 'error',
            code: 'vps-deployment-health-retry',
            message: `Command ${command.id} did not prove healthy deployment status.`,
            detail: healthStatusError,
          },
        ],
        manualBlockReasons: [],
        redactedOutput: result.output ? [redactText(result.output)] : undefined,
      };
    }
    const commandHealthProof = healthProofFromCommand(command, result.output);
    if (commandHealthProof) {
      healthProof = {
        ...(healthProof ?? {}),
        ...commandHealthProof,
      };
    }
  }

  return {
    state: 'success',
    planStatus: input.plan.status,
    canRetry: false,
    commandStates,
    logs: [
      ...logs,
      {
        level: 'info',
        code: 'vps-deployment-success',
        message: 'VPS deployment execution completed.',
        detail: 'All selected commands executed successfully.',
      },
    ],
    manualBlockReasons: [],
    redactedOutput: [],
    ...(healthProof ? { healthProof } : {}),
  };
}
