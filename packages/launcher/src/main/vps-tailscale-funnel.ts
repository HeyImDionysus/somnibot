import {
  normalizeBaseUrl,
  normalizeVpsTailscaleFunnelUrl,
} from './runtime-profile.js';
import {
  parseFunnelStatusJson,
  parseFunnelStatusText,
  parseTailscaleStatusJson,
  redactTailscaleOutput,
} from './tailscale-service.js';
import type { VpsDeploymentCommand } from './vps-deployment-plan.js';

export const VPS_TAILSCALE_FUNNEL_TARGET = 'http://127.0.0.1:3456';

export type VpsTailscaleFunnelState =
  | 'not-installed'
  | 'login-required'
  | 'installed'
  | 'policy-required'
  | 'permission-required'
  | 'verified'
  | 'error';

export interface VpsTailscaleFunnelReadiness {
  state: VpsTailscaleFunnelState;
  installed: boolean;
  loggedIn: boolean;
  funnelEnabled: boolean;
  publicUrl: string;
  target: string;
  message: string;
  nextAction: string;
  commandPreview: string[];
}

const STATUS_BEGIN = 'SOMNIBOT_TAILSCALE_STATUS_BEGIN';
const STATUS_END = 'SOMNIBOT_TAILSCALE_STATUS_END';
const FUNNEL_BEGIN = 'SOMNIBOT_TAILSCALE_FUNNEL_BEGIN';
const FUNNEL_END = 'SOMNIBOT_TAILSCALE_FUNNEL_END';

export const VPS_TAILSCALE_STATUS_SCRIPT = `set -u
if ! command -v tailscale >/dev/null 2>&1; then
  printf '%s\n' 'SOMNIBOT_TAILSCALE_NOT_INSTALLED'
  exit 0
fi
printf '%s\n' '${STATUS_BEGIN}'
tailscale status --json 2>&1 || true
printf '%s\n' '${STATUS_END}'
printf '%s\n' '${FUNNEL_BEGIN}'
tailscale funnel status --json 2>&1 || tailscale funnel status 2>&1 || true
printf '%s\n' '${FUNNEL_END}'
`;

function section(output: string, begin: string, end: string): string {
  const start = output.indexOf(begin);
  const finish = output.indexOf(end);
  if (start < 0 || finish <= start) return '';
  return output.slice(start + begin.length, finish).trim();
}

function readiness(
  state: VpsTailscaleFunnelState,
  overrides: Partial<Omit<VpsTailscaleFunnelReadiness, 'state'>>,
): VpsTailscaleFunnelReadiness {
  return {
    state,
    installed: state !== 'not-installed',
    loggedIn: false,
    funnelEnabled: false,
    publicUrl: '',
    target: '',
    message: 'Remote Tailscale Funnel status needs attention.',
    nextAction: 'Re-run SSH preflight after resolving the remote Tailscale step.',
    commandPreview: [],
    ...overrides,
  };
}

export function parseVpsTailscaleFunnelReadiness(
  output: string,
  expectedUrl: string | undefined,
): VpsTailscaleFunnelReadiness {
  const redacted = redactTailscaleOutput(output);
  if (redacted.includes('SOMNIBOT_TAILSCALE_NOT_INSTALLED')) {
    return readiness('not-installed', {
      installed: false,
      message: 'Tailscale is not installed on the VPS.',
      nextAction: 'Install Tailscale from https://tailscale.com/download/linux, then re-run SSH preflight.',
    });
  }

  const statusOutput = section(redacted, STATUS_BEGIN, STATUS_END);
  const funnelOutput = section(redacted, FUNNEL_BEGIN, FUNNEL_END);
  if (!statusOutput) {
    return readiness('error', {
      message: 'Remote Tailscale status could not be read.',
      nextAction: 'Confirm the SSH user can run tailscale status, then re-run SSH preflight.',
    });
  }

  const lowerStatusOutput = statusOutput.toLowerCase();
  if (lowerStatusOutput.includes('permission denied') || lowerStatusOutput.includes('access denied')) {
    return readiness('permission-required', {
      installed: true,
      message: 'The SSH user cannot read remote Tailscale status.',
      nextAction: 'Grant this VPS operator permission to read Tailscale status, then re-run SSH preflight. Do not paste or pass an auth key.',
    });
  }

  const status = parseTailscaleStatusJson(statusOutput);
  if (!status.loggedIn) {
    return readiness('login-required', {
      installed: true,
      message: 'Tailscale is installed on the VPS, but login is required.',
      nextAction: 'SSH into the VPS, run sudo tailscale up, finish the browser login, then re-run SSH preflight.',
      commandPreview: ['sudo', 'tailscale', 'up'],
    });
  }

  const lowerFunnelOutput = funnelOutput.toLowerCase();
  if (lowerFunnelOutput.includes('policy')
    || lowerFunnelOutput.includes('permission')
    || lowerFunnelOutput.includes('attribute')) {
    return readiness('policy-required', {
      installed: true,
      loggedIn: true,
      message: 'The tailnet policy does not currently allow Funnel for this VPS.',
      nextAction: 'Allow Funnel for this VPS in the Tailscale admin policy, then re-run SSH preflight.',
    });
  }

  const funnel = funnelOutput.trim().startsWith('{')
    ? parseFunnelStatusJson(funnelOutput)
    : parseFunnelStatusText(funnelOutput);
  const commandPreview = ['sudo', 'tailscale', 'funnel', '--bg', '--https=443', '--yes', VPS_TAILSCALE_FUNNEL_TARGET];
  if (!funnel.enabled || normalizeBaseUrl(funnel.target) !== VPS_TAILSCALE_FUNNEL_TARGET) {
    return readiness('installed', {
      installed: true,
      loggedIn: true,
      publicUrl: funnel.publicUrl,
      target: funnel.target,
      message: 'Tailscale is connected, but Funnel is not mapped to the SomniBot loopback dashboard.',
      nextAction: `SSH into the VPS and run: ${commandPreview.join(' ')}`,
      commandPreview,
    });
  }

  const actualUrl = normalizeVpsTailscaleFunnelUrl(funnel.publicUrl);
  const normalizedExpectedUrl = normalizeVpsTailscaleFunnelUrl(expectedUrl);
  if (!actualUrl || actualUrl !== normalizedExpectedUrl) {
    return readiness('installed', {
      installed: true,
      loggedIn: true,
      funnelEnabled: true,
      publicUrl: actualUrl,
      target: funnel.target,
      message: 'Remote Funnel is enabled, but its HTTPS URL does not match the launcher field.',
      nextAction: 'Use the exact remote *.ts.net URL shown by Tailscale, then re-run SSH preflight.',
      commandPreview,
    });
  }

  return readiness('verified', {
    installed: true,
    loggedIn: true,
    funnelEnabled: true,
    publicUrl: actualUrl,
    target: funnel.target,
    message: 'Remote Tailscale Funnel maps the exact HTTPS URL to 127.0.0.1:3456.',
    nextAction: 'Review the deployment plan. Setup remains incomplete until the public HTTPS health probes pass.',
    commandPreview,
  });
}

export function buildVpsTailscaleStatusCommand(sshTarget: string): VpsDeploymentCommand {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=yes',
    '--', sshTarget, 'sh', '-s',
  ];
  return {
    id: 'vps-tailscale-status',
    label: 'Check remote Tailscale Funnel status',
    executable: 'ssh',
    args,
    redactedArgs: [...args],
    redactedDisplay: `ssh ${args.join(' ')}`,
    changesRemote: false,
    approvalRequired: false,
    commandCategory: 'probe',
    sensitiveStdin: VPS_TAILSCALE_STATUS_SCRIPT,
  };
}
