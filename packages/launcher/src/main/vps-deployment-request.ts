import { type LauncherConfig } from './config-store.js';
import { type VpsDeploymentApprovalDecision } from './vps-deployment-approval.js';
import {
  runVpsDeployment,
  type VpsDeploymentCommandRunner,
  type VpsDeploymentExecutionResult,
} from './vps-deployment-executor.js';
import { buildVpsDeploymentPlan, type VpsDeploymentPlan } from './vps-deployment-plan.js';

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
      && config.supabasePublishableKey,
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
  const plan = buildVpsDeploymentPlanFromConfig(config);

  const execute = async (): Promise<VpsDeploymentExecutionResult> => {
    const approval = liveRequested
      ? await runtime.confirmApproval(plan)
      : rendererApproval(request);

    return runVpsDeployment({
      plan,
      operatorApproved: approval.operatorApproved,
      approvedCommandIds: approval.approvedCommandIds,
      dryRun: request?.dryRun !== false,
      cancelRequested: Boolean(request?.cancelRequested),
      ...(liveRequested && approval.operatorApproved ? { commandRunner: runtime.createCommandRunner() } : {}),
    });
  };

  if (!liveRequested) {
    return execute();
  }

  return runtime.runGate.run(execute);
}
