import type { LauncherConfig } from './config-store.js';
import type { LauncherAuditEntry } from './audit-log.js';
import type { VpsDeploymentApprovalDecision } from './vps-deployment-approval.js';
import {
  runVpsDeployment,
  type VpsDeploymentCommandRunner,
  type VpsDeploymentExecutionResult,
  VpsDeploymentRunGate,
} from './vps-deployment-executor.js';
import {
  buildVpsRollbackPlan,
  type VpsDeploymentPlan,
} from './vps-deployment-plan.js';
import { approvalCoversPlan, vpsDeploymentPlanInputFromConfig } from './vps-deployment-request.js';

export interface VpsRollbackRunRequest {
  lastGoodCommit: string;
  cancelRequested?: boolean;
}

export interface VpsRollbackRunRuntime {
  confirmApproval: (plan: VpsDeploymentPlan) => Promise<VpsDeploymentApprovalDecision>;
  createCommandRunner: () => VpsDeploymentCommandRunner;
  runGate: VpsDeploymentRunGate;
  recordAudit?: (entry: LauncherAuditEntry) => void;
}

export function buildVpsRollbackPlanFromConfig(
  config: LauncherConfig,
  lastGoodCommit: string,
): VpsDeploymentPlan {
  return buildVpsRollbackPlan({
    ...vpsDeploymentPlanInputFromConfig(config),
    lastGoodCommit,
  });
}

export async function handleVpsRollbackRunRequest(
  config: LauncherConfig,
  request: VpsRollbackRunRequest,
  runtime: VpsRollbackRunRuntime,
): Promise<VpsDeploymentExecutionResult> {
  const execute = async (): Promise<VpsDeploymentExecutionResult> => {
    const plan = buildVpsRollbackPlanFromConfig(config, request.lastGoodCommit);
    if (request.cancelRequested || plan.status !== 'ready') {
      return runVpsDeployment({
        plan,
        operatorApproved: false,
        approvedCommandIds: [],
        cancelRequested: Boolean(request.cancelRequested),
        dryRun: false,
      });
    }

    const approval = await runtime.confirmApproval(plan);
    const approvedForExecution = approvalCoversPlan(plan, approval);
    runtime.recordAudit?.({
      action: 'launcher.vps_rollback.approval_decision',
      category: 'security',
      targetType: 'vps_rollback',
      targetId: plan.target?.sshTarget ?? undefined,
      details: {
        sshTarget: plan.target?.sshTarget ?? null,
        lastGoodCommit: request.lastGoodCommit,
        approvedCommandCount: approval.approvedCommandIds.length,
      },
      success: approvedForExecution,
    });

    const result = await runVpsDeployment({
      plan,
      operatorApproved: approval.operatorApproved,
      approvedCommandIds: approval.approvedCommandIds,
      dryRun: false,
      ...(approvedForExecution ? { commandRunner: runtime.createCommandRunner() } : {}),
    });

    if (approvedForExecution) {
      runtime.recordAudit?.({
        action: 'launcher.vps_rollback.executed',
        category: 'security',
        targetType: 'vps_rollback',
        targetId: plan.target?.sshTarget ?? undefined,
        details: {
          sshTarget: plan.target?.sshTarget ?? null,
          lastGoodCommit: request.lastGoodCommit,
          state: result.state,
          commandCount: plan.commands.length,
        },
        success: result.state === 'success',
      });
    }

    return result;
  };

  return runtime.runGate.run(execute);
}
