import { type VpsDeploymentPlan } from './vps-deployment-plan.js';

export interface VpsDeploymentConfirmationOptions {
  type: 'warning';
  buttons: string[];
  defaultId: number;
  cancelId: number;
  title: string;
  message: string;
  detail: string;
}

export interface VpsDeploymentConfirmationDialog {
  showMessageBox: (options: VpsDeploymentConfirmationOptions) => Promise<{ response: number }>;
}

export interface VpsDeploymentApprovalDecision {
  operatorApproved: boolean;
  approvedCommandIds: string[];
}

function approvalCommandIds(plan: VpsDeploymentPlan): string[] {
  return plan.commands
    .filter(command => command.approvalRequired)
    .map(command => command.id);
}

function commandSummary(plan: VpsDeploymentPlan): string {
  return plan.commands
    .map(command => `${command.approvalRequired ? '[approval required]' : '[read-only]'} ${command.redactedDisplay}`)
    .join('\n');
}

export async function confirmVpsDeploymentApproval(
  plan: VpsDeploymentPlan,
  dialog: VpsDeploymentConfirmationDialog,
): Promise<VpsDeploymentApprovalDecision> {
  if (plan.status !== 'ready') {
    return {
      operatorApproved: false,
      approvedCommandIds: [],
    };
  }

  const target = plan.target;
  const result = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'Run VPS deployment'],
    defaultId: 0,
    cancelId: 0,
    title: 'Confirm VPS deployment',
    message: 'Run the VPS deployment commands now?',
    detail: [
      `Target: ${target?.sshTarget ?? 'unknown'} (${target?.publicBaseUrl ?? 'unknown'})`,
      `Source: ${target?.repositoryUrl ?? 'unknown'} @ ${target?.repositoryRef ?? 'unknown'}`,
      '',
      'This approval is handled in the launcher main process. Review the commands below before continuing.',
      '',
      commandSummary(plan),
    ].join('\n'),
  });

  if (result.response !== 1) {
    return {
      operatorApproved: false,
      approvedCommandIds: [],
    };
  }

  return {
    operatorApproved: true,
    approvedCommandIds: approvalCommandIds(plan),
  };
}
