import { describe, expect, it, vi } from 'vitest';
import { confirmVpsDeploymentApproval } from '../main/vps-deployment-approval';
import { buildVpsDeploymentPlan } from '../main/vps-deployment-plan';

const completeVpsInput = {
  runtimeMode: 'vps',
  vpsDomain: 'somnibot.example.com',
  vpsSshHost: 'somnibot.example.com',
  vpsSshUser: 'deploy',
  vpsDeployPath: '/opt/somnibot',
  credentialReady: true,
  supabaseAccessTokenReady: true,
};

describe('VPS deployment approval confirmation', () => {
  it('approves only approval-required command IDs after the native dialog confirms', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });

    const approval = await confirmVpsDeploymentApproval(plan, { showMessageBox });

    expect(approval).toEqual({
      operatorApproved: true,
      approvedCommandIds: ['write-env-file', 'protect-env-file', 'start-stack', 'install-health-recovery'],
    });
    expect(showMessageBox).toHaveBeenCalledOnce();
  });

  it('keeps deployment blocked when the native dialog is cancelled', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });

    const approval = await confirmVpsDeploymentApproval(plan, { showMessageBox });

    expect(approval).toEqual({
      operatorApproved: false,
      approvedCommandIds: [],
    });
  });

  it('does not show a confirmation dialog for blocked deployment plans', async () => {
    const plan = buildVpsDeploymentPlan({ runtimeMode: 'regular-local' });
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });

    const approval = await confirmVpsDeploymentApproval(plan, { showMessageBox });

    expect(approval).toEqual({
      operatorApproved: false,
      approvedCommandIds: [],
    });
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('shows the redacted target and command summary in the native dialog', async () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });

    await confirmVpsDeploymentApproval(plan, { showMessageBox });

    const options = showMessageBox.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      type: 'warning',
      buttons: ['Cancel', 'Run VPS deployment'],
      defaultId: 0,
      cancelId: 0,
      title: 'Confirm VPS deployment',
    });
    expect(options?.detail).toContain('Target: deploy@somnibot.example.com (https://somnibot.example.com)');
    expect(options?.detail).toContain('[approval required] ssh ');
    expect(options?.detail).toContain('docker compose');
    expect(options?.detail).not.toContain('sb_secret_');
    expect(options?.detail).not.toContain('Bearer ');
  });
});
