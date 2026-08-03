import { type LauncherConfig } from './config-store.js';
import { type LauncherAuditEntry } from './audit-log.js';
import { type VpsDeploymentApprovalDecision } from './vps-deployment-approval.js';
import {
  runVpsDeployment,
  type VpsDeploymentCommandRunner,
  type VpsDeploymentExecutionResult,
} from './vps-deployment-executor.js';
import { buildVpsDeploymentPlan, type VpsDeploymentPlan } from './vps-deployment-plan.js';
import { ensurePersistedVpsSecrets, materializeVpsDeploymentPlan, type PersistedVpsSecrets } from './vps-env-materializer.js';

export interface VpsDeploymentRunRequest {
  operatorApproved?: boolean;
  approvedCommandIds?: string[];
  dryRun?: boolean;
  cancelRequested?: boolean;
}

export interface VpsDeploymentRunGate {
  run: (execute: () => Promise<VpsDeploymentExecutionResult>) => Promise<VpsDeploymentExecutionResult>;
}

export interface VpsDeploymentRunRuntime {
  confirmApproval: (plan: VpsDeploymentPlan) => Promise<VpsDeploymentApprovalDecision>;
  createCommandRunner: () => VpsDeploymentCommandRunner;
  runGate: VpsDeploymentRunGate;
  persistGeneratedSecrets: (patch: Partial<PersistedVpsSecrets>) => Promise<void> | void;
  runApprovedDeployment?: (
    execute: () => Promise<VpsDeploymentExecutionResult>,
  ) => Promise<VpsDeploymentExecutionResult>;
  /**
   * [infrastructure-launcher] Optional sink for durable audit entries. Records
   * the operator approval decision and the deployment execution outcome (the
   * "VPS remote execute" + "approval decisions" security operations). Only live
   * (non dry-run) runs, which actually touch the remote host, are audited.
   */
  recordAudit?: (entry: LauncherAuditEntry) => void;
}

export function approvalCoversPlan(plan: VpsDeploymentPlan, approval: VpsDeploymentApprovalDecision): boolean {
  if (!approval.operatorApproved) return false;
  const approvedCommandIds = new Set(approval.approvedCommandIds);
  return plan.commands.every((command) => !command.approvalRequired || approvedCommandIds.has(command.id));
}

function rendererApproval(request: VpsDeploymentRunRequest | undefined): VpsDeploymentApprovalDecision {
  return {
    operatorApproved: Boolean(request?.operatorApproved),
    approvedCommandIds: Array.isArray(request?.approvedCommandIds) ? request.approvedCommandIds : [],
  };
}

export function buildVpsDeploymentPlanFromConfig(config: LauncherConfig): VpsDeploymentPlan {
  return buildVpsDeploymentPlan({
    runtimeMode: config.runtimeMode,
    vpsDomain: config.vpsDomain,
    vpsSshHost: config.vpsSshHost,
    vpsSshUser: config.vpsSshUser,
    vpsDeployPath: config.vpsDeployPath,
    credentialReady: Boolean(
      config.discordToken
      && config.discordApplicationId
      && config.discordClientSecret
      && config.supabaseUrl
      && config.supabaseSecretKey
      && config.supabasePublishableKey
      && config.supabaseDbPassword
    ),
    paypalReady: Boolean(
      config.paypalClientId
      && config.paypalClientSecret
      && config.paypalWebhookId
    ),
    supabaseAccessTokenReady: Boolean(config.supabaseAccessToken),
    supabaseDiscordAuthProviderConfigured: config.supabaseDiscordAuthProviderConfigured,
  });
}

export async function handleVpsDeploymentRunRequest(
  config: LauncherConfig,
  request: VpsDeploymentRunRequest | undefined,
  runtime: VpsDeploymentRunRuntime,
): Promise<VpsDeploymentExecutionResult> {
  const liveRequested = request?.dryRun === false && config.runtimeMode === 'vps';
  const displayPlan = buildVpsDeploymentPlanFromConfig(config);

  const execute = async (): Promise<VpsDeploymentExecutionResult> => {
    let plan = displayPlan;
    let generatedSecretPatch: Partial<PersistedVpsSecrets> = {};
    if (liveRequested && displayPlan.status === 'ready') {
      const prepared = ensurePersistedVpsSecrets(config);
      generatedSecretPatch = prepared.patch;
      plan = materializeVpsDeploymentPlan(displayPlan, prepared.config);
    }

    const approval = liveRequested && plan.status === 'ready' && !request?.cancelRequested
      ? await runtime.confirmApproval(plan)
      : rendererApproval(liveRequested && request?.cancelRequested ? undefined : request);

    const approvedForExecution = liveRequested && plan.status === 'ready' && approvalCoversPlan(plan, approval);
    if (approvedForExecution && Object.keys(generatedSecretPatch).length > 0) {
      try {
        await runtime.persistGeneratedSecrets(generatedSecretPatch);
      } catch {
        plan = {
          ...displayPlan,
          status: 'blocked',
          canApprove: false,
          blockedReasons: [
            ...displayPlan.blockedReasons,
            'Generated VPS service credentials could not be persisted safely; no remote commands were run.',
          ],
          commands: [],
        };
      }
    }

    // [infrastructure-launcher] Audit the operator's approval decision for a
    // live run — an approved or denied VPS deployment is a security-relevant
    // event that must be durably observable.
    if (liveRequested && plan.status === 'ready' && !request?.cancelRequested) {
      runtime.recordAudit?.({
        action: 'launcher.vps_deployment.approval_decision',
        category: 'security',
        targetType: 'vps_deployment',
        targetId: plan.target?.sshTarget ?? undefined,
        details: {
          sshTarget: plan.target?.sshTarget ?? null,
          publicBaseUrl: plan.target?.publicBaseUrl ?? null,
          approvedCommandCount: approval.approvedCommandIds.length,
        },
        success: approval.operatorApproved,
      });
    }

    const executeDeployment = () => runVpsDeployment({
        plan,
        operatorApproved: approval.operatorApproved,
        approvedCommandIds: approval.approvedCommandIds,
        dryRun: request?.dryRun !== false,
        cancelRequested: Boolean(request?.cancelRequested),
        ...(approvedForExecution && plan.status === 'ready' ? { commandRunner: runtime.createCommandRunner() } : {}),
      });
    const result = approvedForExecution && plan.status === 'ready' && runtime.runApprovedDeployment
      ? await runtime.runApprovedDeployment(executeDeployment)
      : await executeDeployment();

    // [infrastructure-launcher] Audit the remote-execution outcome for live
    // runs (VPS remote execute). Dry-runs never touch the host, so they are
    // not recorded.
    if (approvedForExecution && plan.status === 'ready') {
      runtime.recordAudit?.({
        action: 'launcher.vps_deployment.executed',
        category: 'security',
        targetType: 'vps_deployment',
        targetId: plan.target?.sshTarget ?? undefined,
        details: {
          sshTarget: plan.target?.sshTarget ?? null,
          state: result.state,
          planStatus: result.planStatus,
          commandCount: plan.commands.length,
        },
        success: result.state === 'success',
      });
    }

    return result;
  };

  if (!liveRequested) {
    return execute();
  }

  return runtime.runGate.run(execute);
}
