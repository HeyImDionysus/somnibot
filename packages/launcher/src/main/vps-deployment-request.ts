import { type LauncherConfig } from './config-store.js';
import { type LauncherAuditEntry } from './audit-log.js';
import { type VpsDeploymentApprovalDecision } from './vps-deployment-approval.js';
import {
  runVpsDeployment,
  type VpsDeploymentCommandRunner,
  type VpsDeploymentExecutionResult,
} from './vps-deployment-executor.js';
import { buildVpsDeploymentPlan, type VpsDeploymentPlan } from './vps-deployment-plan.js';
import { materializeVpsDeploymentPlan } from './vps-env-materializer.js';

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
  /**
   * [infrastructure-launcher] Optional sink for durable audit entries. Records
   * the operator approval decision and the deployment execution outcome (the
   * "VPS remote execute" + "approval decisions" security operations). Only live
   * (non dry-run) runs, which actually touch the remote host, are audited.
   */
  recordAudit?: (entry: LauncherAuditEntry) => void;
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
  const plan = liveRequested ? materializeVpsDeploymentPlan(displayPlan, config) : displayPlan;

  const execute = async (): Promise<VpsDeploymentExecutionResult> => {
    const approval = liveRequested
      ? await runtime.confirmApproval(plan)
      : rendererApproval(request);

    // [infrastructure-launcher] Audit the operator's approval decision for a
    // live run — an approved or denied VPS deployment is a security-relevant
    // event that must be durably observable.
    if (liveRequested) {
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

    const result = await runVpsDeployment({
      plan,
      operatorApproved: approval.operatorApproved,
      approvedCommandIds: approval.approvedCommandIds,
      dryRun: request?.dryRun !== false,
      cancelRequested: Boolean(request?.cancelRequested),
      ...(liveRequested && approval.operatorApproved ? { commandRunner: runtime.createCommandRunner() } : {}),
    });

    // [infrastructure-launcher] Audit the remote-execution outcome for live
    // runs (VPS remote execute). Dry-runs never touch the host, so they are
    // not recorded.
    if (liveRequested && approval.operatorApproved) {
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
