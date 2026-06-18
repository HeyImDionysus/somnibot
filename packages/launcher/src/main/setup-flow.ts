import {
  REGULAR_LOCAL_OPERATOR_DASHBOARD_URL,
  getProviderCallbackUrls,
  normalizeBaseUrl,
  normalizeRuntimeMode,
  normalizeVpsDomain,
  validateRuntimeNetworkingConfig,
  type RuntimeMode,
  type RuntimeNetworkingConfig,
} from './runtime-profile.js';
import { buildVpsDeploymentPlan, type VpsDeploymentPlan } from './vps-deployment-plan.js';
import { buildVpsHealthVerification, type VpsHealthVerification } from './vps-health-verification.js';

export type SetupStepStatus = 'pending' | 'loading' | 'success' | 'recoverable-error' | 'blocked';

export interface SetupFlowInput extends RuntimeNetworkingConfig {
  credentialReady?: boolean;
  supabaseAccessTokenReady?: boolean;
  supabaseDiscordAuthProviderConfigured?: boolean;
  dashboardOnline?: boolean;
  checking?: boolean;
}

export interface SetupStep {
  id: string;
  label: string;
  status: SetupStepStatus;
  summary: string;
  detail: string;
  actionLabel?: string;
  manualAction?: boolean;
}

export interface SetupSummary {
  runtimeMode: RuntimeMode;
  runtimeLabel: string;
  localDashboardUrl: string;
  publicCallbackUrl: string;
  authCallbackUrl: string;
  paypalWebhookUrl: string;
  diagnostics: Record<string, string>;
}

export interface SetupPrimaryAction {
  label: string;
  enabled: boolean;
  status: 'ready' | 'loading' | 'blocked';
  blockedReason?: string;
}

export interface SetupStatus {
  runtimeMode: RuntimeMode;
  summary: SetupSummary;
  steps: SetupStep[];
  primaryAction: SetupPrimaryAction;
  firstBlockingStepId: string | null;
  deploymentPlan?: VpsDeploymentPlan;
  healthVerification?: VpsHealthVerification;
}

const UNSET_DISPLAY = 'Not set yet';

function displayUrlWithoutPort(value: string): string {
  if (!value) return UNSET_DISPLAY;

  try {
    const parsed = new URL(value);
    parsed.port = '';
    parsed.pathname = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/+$/, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

function hasVpsSshTarget(input: SetupFlowInput): boolean {
  return Boolean(input.vpsSshHost?.trim() && input.vpsSshUser?.trim() && input.vpsDeployPath?.trim());
}

function hasAuthProviderPath(input: SetupFlowInput): boolean {
  return Boolean(input.supabaseAccessTokenReady || input.supabaseDiscordAuthProviderConfigured);
}

function buildAuthProviderStep(input: SetupFlowInput): SetupStep {
  if (input.supabaseAccessTokenReady) {
    return {
      id: 'auth-provider',
      label: 'Supabase Auth',
      status: 'success',
      summary: 'Discord auth provider can be configured automatically.',
      detail: 'The launcher will use the Supabase Management API token to enable Discord auth and keep callback URLs allow-listed.',
    };
  }

  if (input.supabaseDiscordAuthProviderConfigured) {
    return {
      id: 'auth-provider',
      label: 'Supabase Auth',
      status: 'success',
      summary: 'Manual Discord auth provider setup is confirmed.',
      detail: 'The launcher will pass this confirmation to the dashboard so setup can continue without a Management API token.',
    };
  }

  return {
    id: 'auth-provider',
    label: 'Supabase Auth',
    status: 'blocked',
    summary: 'Waiting for auth-provider setup access.',
    detail: 'Add a Supabase Management API token so the launcher can configure Discord auth, or confirm that Discord auth and callback URLs are already configured in Supabase.',
    actionLabel: 'Add token or confirm manual setup',
    manualAction: true,
  };
}

function buildSummary(input: SetupFlowInput, runtimeMode: RuntimeMode): SetupSummary {
  const regularPublicBase = normalizeBaseUrl(input.publicCallbackBaseUrl);
  const vpsPublicBase = normalizeVpsDomain(input.vpsDomain);
  const publicCallbackBaseUrl = runtimeMode === 'vps' ? vpsPublicBase : regularPublicBase;
  const callbacks = getProviderCallbackUrls(publicCallbackBaseUrl);
  const operatorDashboardUrl = runtimeMode === 'vps'
    ? publicCallbackBaseUrl
    : REGULAR_LOCAL_OPERATOR_DASHBOARD_URL;

  return {
    runtimeMode,
    runtimeLabel: runtimeMode === 'vps' ? 'VPS' : 'Regular local',
    localDashboardUrl: displayUrlWithoutPort(operatorDashboardUrl),
    publicCallbackUrl: displayUrlWithoutPort(publicCallbackBaseUrl),
    authCallbackUrl: displayUrlWithoutPort(callbacks.authCallbackUrl),
    paypalWebhookUrl: displayUrlWithoutPort(callbacks.paypalWebhookUrl),
    diagnostics: {
      operatorDashboardUrl: operatorDashboardUrl || UNSET_DISPLAY,
      publicCallbackBaseUrl: publicCallbackBaseUrl || UNSET_DISPLAY,
      authCallbackUrl: callbacks.authCallbackUrl || UNSET_DISPLAY,
      paypalWebhookUrl: callbacks.paypalWebhookUrl || UNSET_DISPLAY,
    },
  };
}

function buildRegularLocalSteps(input: SetupFlowInput): SetupStep[] {
  const callbackRaw = input.publicCallbackBaseUrl?.trim() ?? '';
  const callbackErrors = callbackRaw
    ? validateRuntimeNetworkingConfig({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: callbackRaw,
    })
    : [];

  const callbackStep: SetupStep = !callbackRaw
    ? {
      id: 'regular-callback',
      label: 'Tailscale public callback',
      status: 'blocked',
      summary: 'Waiting for a public callback URL.',
      detail: 'Set up Tailscale Funnel and paste the HTTPS URL for this machine before validating credentials.',
      actionLabel: 'Paste Tailscale Funnel URL',
      manualAction: true,
    }
    : callbackErrors.length > 0
      ? {
        id: 'regular-callback',
        label: 'Tailscale public callback',
        status: 'recoverable-error',
        summary: 'The public callback URL needs attention.',
        detail: callbackErrors.join('\n'),
        actionLabel: 'Fix callback URL',
      }
      : {
        id: 'regular-callback',
        label: 'Tailscale public callback',
        status: 'success',
        summary: 'Public provider callbacks are ready.',
        detail: 'Discord auth and PayPal webhooks will use the configured public callback URL.',
      };

  const credentialStep: SetupStep = input.credentialReady
    ? {
      id: 'credentials',
      label: 'Credentials',
      status: 'success',
      summary: 'Required credentials are filled in.',
      detail: 'Validation can now check Discord and Supabase.',
    }
    : {
      id: 'credentials',
      label: 'Credentials',
      status: 'pending',
      summary: 'Required credential fields are not complete.',
      detail: 'Fill in Discord and Supabase credentials after the public callback step is ready.',
    };

  const authProviderStep = buildAuthProviderStep(input);

  const startStep: SetupStep = input.checking
    ? {
      id: 'start-local',
      label: 'Start locally',
      status: 'loading',
      summary: 'Checking setup gates.',
      detail: 'The launcher is checking readiness before starting the bot and dashboard.',
    }
    : input.dashboardOnline
      ? {
        id: 'start-local',
        label: 'Start locally',
        status: 'success',
        summary: 'Local dashboard is online.',
        detail: 'The bot and dashboard are running on this machine.',
      }
      : callbackStep.status !== 'success'
        ? {
          id: 'start-local',
          label: 'Start locally',
          status: 'blocked',
          summary: 'Blocked by public callback readiness.',
          detail: 'Finish the Tailscale/public callback step before starting regular local mode.',
          manualAction: true,
        }
        : !input.credentialReady
          ? {
            id: 'start-local',
            label: 'Start locally',
            status: 'pending',
            summary: 'Waiting for credentials.',
            detail: 'Complete the credential fields before validation and start.',
          }
          : !hasAuthProviderPath(input)
            ? {
              id: 'start-local',
              label: 'Start locally',
              status: 'blocked',
              summary: 'Blocked by Supabase auth setup.',
              detail: 'The launcher needs a Supabase Management API token or confirmed manual Discord auth provider setup before it can finish local setup.',
              manualAction: true,
            }
            : {
              id: 'start-local',
              label: 'Start locally',
              status: 'pending',
              summary: 'Ready to set up and start.',
              detail: 'The launcher can validate credentials, configure provider callbacks, then start the local bot and dashboard.',
            };

  return [
    {
      id: 'runtime-choice',
      label: 'Runtime',
      status: 'success',
      summary: 'Regular local selected.',
      detail: 'The bot and dashboard will run on this computer, with public callbacks routed to this machine.',
    },
    callbackStep,
    credentialStep,
    authProviderStep,
    startStep,
  ];
}

function buildVpsSteps(input: SetupFlowInput, deploymentPlan: VpsDeploymentPlan): SetupStep[] {
  const domainRaw = input.vpsDomain?.trim() ?? '';
  const domainErrors = domainRaw
    ? validateRuntimeNetworkingConfig({
      runtimeMode: 'vps',
      vpsDomain: input.vpsDomain,
    })
    : [];

  const domainStep: SetupStep = !domainRaw
    ? {
      id: 'vps-domain',
      label: 'Domain',
      status: 'blocked',
      summary: 'Waiting for the VPS public domain.',
      detail: 'Enter the HTTPS domain that will serve the dashboard and receive provider callbacks.',
      actionLabel: 'Enter VPS domain',
      manualAction: true,
    }
    : domainErrors.length > 0
      ? {
        id: 'vps-domain',
        label: 'Domain',
        status: 'recoverable-error',
        summary: 'The VPS public domain needs attention.',
        detail: domainErrors.join('\n'),
        actionLabel: 'Fix VPS domain',
      }
      : {
        id: 'vps-domain',
        label: 'Domain',
        status: 'success',
        summary: 'VPS public callback domain is ready.',
        detail: 'The dashboard URL and provider callback URL will use this HTTPS domain.',
      };

  const sshStep: SetupStep = hasVpsSshTarget(input)
    ? {
      id: 'vps-ssh',
      label: 'SSH target',
      status: 'success',
      summary: 'SSH and deploy target details are filled in.',
      detail: 'The launcher has the non-secret VPS host, user, and deploy path details for a deployment checklist.',
    }
    : {
      id: 'vps-ssh',
      label: 'SSH target',
      status: 'blocked',
      summary: 'Waiting for SSH/deploy details.',
      detail: 'Enter the VPS SSH host, SSH user, and deployment path. Do not paste private keys or passwords here.',
      actionLabel: 'Enter SSH/deploy details',
      manualAction: true,
    };

  const credentialStep: SetupStep = input.credentialReady
    ? {
      id: 'credentials',
      label: 'Credentials',
      status: 'success',
      summary: 'Required credentials are filled in.',
      detail: 'Credentials can be validated before a separate VPS deployment workflow.',
    }
    : {
      id: 'credentials',
      label: 'Credentials',
      status: 'pending',
      summary: 'Required credential fields are not complete.',
      detail: 'Fill in Discord and Supabase credentials after the VPS readiness steps.',
    };
  const authProviderStep = buildAuthProviderStep(input);

  const deployStep: SetupStep = deploymentPlan.status === 'ready'
    ? {
      id: 'vps-deploy',
      label: 'Deploy',
      status: 'blocked',
      summary: 'Review-only VPS deployment plan is ready.',
      detail: 'Review the redacted env shape, service layout, Caddy outline, approval gates, and rollback commands before any remote change.',
      actionLabel: 'Review dry-run plan',
      manualAction: true,
    }
    : domainStep.status === 'success' && sshStep.status === 'success'
      ? {
        id: 'vps-deploy',
        label: 'Deploy',
        status: 'recoverable-error',
        summary: 'The VPS deployment plan needs attention.',
        detail: deploymentPlan.blockedReasons.join('\n'),
        actionLabel: 'Fix deployment plan',
      }
      : {
      id: 'vps-deploy',
      label: 'Deploy',
      status: 'pending',
      summary: 'Waiting for VPS readiness.',
      detail: 'Finish the domain and SSH/deploy steps before the manual deployment workflow.',
      };

  return [
    {
      id: 'runtime-choice',
      label: 'Runtime',
      status: 'success',
      summary: 'VPS selected.',
      detail: 'The bot and dashboard will run on a VPS with a public HTTPS domain.',
    },
    domainStep,
    sshStep,
    credentialStep,
    authProviderStep,
    deployStep,
  ];
}

function findFirstBlockingStep(steps: SetupStep[]): SetupStep | undefined {
  return steps.find(step => step.status === 'blocked' || step.status === 'recoverable-error');
}

export function buildSetupStatus(input: SetupFlowInput = {}): SetupStatus {
  const runtimeMode = normalizeRuntimeMode(input.runtimeMode);
  let deploymentPlan: VpsDeploymentPlan | undefined;
  let healthVerification: VpsHealthVerification | undefined;
  let steps: SetupStep[];
  if (runtimeMode === 'vps') {
    deploymentPlan = buildVpsDeploymentPlan({ ...input, runtimeMode: 'vps' });
    healthVerification = buildVpsHealthVerification({ ...input, runtimeMode: 'vps' });
    steps = buildVpsSteps(input, deploymentPlan);
  } else {
    steps = buildRegularLocalSteps(input);
  }
  const firstBlocking = findFirstBlockingStep(steps);
  const summary = buildSummary(input, runtimeMode);

  let primaryAction: SetupPrimaryAction;
  if (input.checking) {
    primaryAction = {
      label: 'Checking...',
      enabled: false,
      status: 'loading',
    };
  } else if (runtimeMode === 'vps') {
    primaryAction = {
      label: 'Manual VPS Deploy',
      enabled: false,
      status: 'blocked',
      blockedReason: firstBlocking?.detail ?? 'VPS mode uses a separate manual deployment workflow in this launcher build.',
    };
  } else if (firstBlocking) {
    primaryAction = {
      label: 'Set Up & Start',
      enabled: false,
      status: 'blocked',
      blockedReason: firstBlocking.detail,
    };
  } else if (!input.credentialReady) {
    primaryAction = {
      label: 'Set Up & Start',
      enabled: false,
      status: 'blocked',
      blockedReason: 'Fill in all required credential fields before validation.',
    };
  } else {
    primaryAction = {
      label: 'Set Up & Start',
      enabled: true,
      status: 'ready',
    };
  }

  return {
    runtimeMode,
    summary,
    steps,
    primaryAction,
    firstBlockingStepId: firstBlocking?.id ?? null,
    ...(deploymentPlan ? { deploymentPlan } : {}),
    ...(healthVerification ? { healthVerification } : {}),
  };
}
