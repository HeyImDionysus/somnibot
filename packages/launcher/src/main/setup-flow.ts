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
import type { DashboardHealthEvaluation } from './setup-automation-health.js';
import { buildVpsDeploymentPlan, type VpsDeploymentPlan } from './vps-deployment-plan.js';
import {
  buildVpsHealthVerification,
  type VpsHealthVerification,
  type VpsHealthVerificationInput,
} from './vps-health-verification.js';
import type { ProviderValidationCheck } from './validators.js';

export type SetupStepStatus = 'pending' | 'loading' | 'success' | 'recoverable-error' | 'blocked';

export interface LocalServiceReadiness {
  bot?: string;
  dashboard?: string;
  lavalink?: string;
  dashboardHealth?: DashboardHealthEvaluation;
}

export interface SupabaseDiscordAuthProviderStatus {
  ready?: boolean;
  providerEnabled?: boolean;
  callbackAllowListReady?: boolean;
  missingCallbackUrls?: string[];
  manualConfigured?: boolean;
  statusReason?: string;
  statusDetail?: string;
}

export interface PublicCallbackProbeStatus {
  ok?: boolean;
  url?: string;
  status?: number;
  error?: string;
}

export interface PayPalWebhookProofStatus {
  ok?: boolean;
  webhookUrl?: string;
  status?: string;
  message?: string;
  error?: string;
}

export interface SetupFlowInput extends RuntimeNetworkingConfig, Partial<Pick<
  VpsHealthVerificationInput,
  'httpsDashboardProbe' | 'apiHealthProbe' | 'supabaseCallbackAllowList' | 'lavalink'
>> {
  discordGuildId?: string;
  credentialReady?: boolean;
  providerValidation?: {
    valid: boolean;
    errors?: string[];
    checks: ProviderValidationCheck[];
  };
  paypalReady?: boolean;
  paypalWebhook?: PayPalWebhookProofStatus;
  callbackProbe?: PublicCallbackProbeStatus;
  supabaseAccessTokenReady?: boolean;
  supabaseDiscordAuthProviderConfigured?: boolean;
  supabaseDiscordAuthProviderStatus?: SupabaseDiscordAuthProviderStatus;
  tailscaleAuthKeyReady?: boolean;
  tailscaleReadinessState?: 'ready'
    | 'not-installed'
    | 'not-logged-in'
    | 'needs-permission'
    | 'not-configured'
    | 'needs-dashboard'
    | 'needs-policy'
    | 'unsupported-platform'
    | 'error';
  dashboardOnline?: boolean;
  localServiceReadiness?: LocalServiceReadiness;
  checking?: boolean;
}

export interface SetupStep {
  id: string;
  label: string;
  status: SetupStepStatus;
  summary: string;
  detail: string;
  actionLabel?: string;
  actionKind?: 'discord-invite';
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

export interface SetupCompletionStatus {
  status: 'complete' | 'incomplete' | 'blocked';
  summary: string;
  detail: string;
  requiredStepIds: string[];
  missingStepIds: string[];
  missingLabels: string[];
}

export interface SetupStatus {
  runtimeMode: RuntimeMode;
  summary: SetupSummary;
  steps: SetupStep[];
  completion: SetupCompletionStatus;
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
  return Boolean(
    input.supabaseAccessTokenReady
    || input.supabaseDiscordAuthProviderConfigured
    || input.supabaseDiscordAuthProviderStatus?.ready,
  );
}

function buildAuthProviderStep(input: SetupFlowInput): SetupStep {
  const providerStatus = input.supabaseDiscordAuthProviderStatus;

  if (input.supabaseAccessTokenReady) {
    return {
      id: 'auth-provider',
      label: 'Supabase Auth',
      status: 'success',
      summary: 'Discord auth provider can be configured automatically.',
      detail: 'The launcher will use the Supabase Management API token to enable Discord auth and keep callback URLs allow-listed.',
    };
  }

  if (providerStatus?.ready) {
    const statusDetail = providerStatus?.ready ? providerStatus.statusDetail?.trim() : undefined;
    return {
      id: 'auth-provider',
      label: 'Supabase Auth',
      status: 'success',
      summary: providerStatus.ready && !providerStatus.manualConfigured
        ? 'Discord auth provider readiness is verified.'
        : 'Manual Discord auth provider setup is confirmed.',
      detail: statusDetail || 'The launcher will pass this confirmation to the dashboard so setup can continue without a Management API token.',
    };
  }

  if (providerStatus && providerStatus.ready === false) {
    const statusDetail = providerStatus.statusDetail?.trim();
    const missingCallbacks = Array.isArray(providerStatus.missingCallbackUrls)
      ? providerStatus.missingCallbackUrls.filter(Boolean)
      : [];
    const detailParts = [
      statusDetail,
      providerStatus.statusReason === 'provider-disabled'
        ? 'Discord auth provider is disabled in Supabase.'
        : '',
      providerStatus.statusReason === 'callback-allow-list-missing' && missingCallbacks.length > 0
        ? `Missing callback URLs: ${missingCallbacks.join(', ')}.`
        : '',
      'Add a Supabase Management API token so the launcher can fix this automatically, or confirm the provider manually after updating Supabase.',
    ].filter(Boolean);

    return {
      id: 'auth-provider',
      label: 'Supabase Auth',
      status: 'blocked',
      summary: 'Discord auth provider readiness needs attention.',
      detail: detailParts.join('\n'),
      actionLabel: 'Add token or confirm manual setup',
      manualAction: true,
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

function buildPayPalStep(input: SetupFlowInput): SetupStep {
  const runtimeMode = normalizeRuntimeMode(input.runtimeMode);
  const publicBaseReady = runtimeMode === 'vps'
    ? Boolean(normalizeVpsDomain(input.vpsDomain))
    : Boolean(normalizeBaseUrl(input.publicCallbackBaseUrl));

  if (input.paypalReady) {
    return {
      id: 'paypal-webhook',
      label: 'PayPal webhook',
      status: 'success',
      summary: 'PayPal app and webhook credentials are filled in.',
      detail: 'The bot and dashboard will receive PayPal runtime credentials, and the webhook URL is derived from the active public callback base.',
    };
  }

  if (!publicBaseReady) {
    return {
      id: 'paypal-webhook',
      label: 'PayPal webhook',
      status: 'pending',
      summary: 'Waiting for the public callback URL.',
      detail: 'The launcher needs the public callback base before it can create or update the PayPal webhook.',
    };
  }

  return {
    id: 'paypal-webhook',
    label: 'PayPal webhook',
    status: 'pending',
    summary: 'Waiting for PayPal app and webhook credentials.',
    detail: 'Paste the PayPal app Client ID and Client Secret, then click Create/Update Webhook. The launcher will subscribe the current webhook URL to the handled event catalog and save the returned Webhook ID.',
    actionLabel: 'Add PayPal credentials or create webhook',
    manualAction: true,
  };
}

function buildCredentialStep(input: SetupFlowInput, runtimeLabel: string): SetupStep {
  return input.credentialReady
    ? {
      id: 'credentials',
      label: 'Provider fields',
      status: 'success',
      summary: 'Required provider fields are filled in.',
      detail: `The launcher can validate Discord and Supabase before ${runtimeLabel} setup continues.`,
    }
    : {
      id: 'credentials',
      label: 'Provider fields',
      status: 'pending',
      summary: 'Required provider fields are not complete.',
      detail: 'Fill in the Discord bot, Discord OAuth, and Supabase project fields before validation.',
    };
}

function buildProviderValidationStep(input: SetupFlowInput): SetupStep {
  if (!input.credentialReady) {
    return {
      id: 'provider-validation',
      label: 'Provider validation',
      status: 'pending',
      summary: 'Waiting for provider fields.',
      detail: 'After the required fields are filled, validation checks the Discord bot, Discord OAuth app, Discord server, and Supabase project.',
    };
  }

  if (input.checking) {
    return {
      id: 'provider-validation',
      label: 'Provider validation',
      status: 'loading',
      summary: 'Checking provider readiness.',
      detail: 'The launcher is verifying Discord and Supabase without exposing secrets in the setup steps.',
    };
  }

  const validation = input.providerValidation;
  const checks = Array.isArray(validation?.checks) ? validation.checks : [];
  if (checks.length === 0) {
    return {
      id: 'provider-validation',
      label: 'Provider validation',
      status: 'pending',
      summary: 'Provider checks will run during setup.',
      detail: 'Setup validates the Discord bot token, Application ID, optional server membership, client secret presence, and Supabase API keys before services start.',
    };
  }

  const failedChecks = checks.filter(check => check.status === 'failed');
  if (failedChecks.length > 0) {
    return {
      id: 'provider-validation',
      label: 'Provider validation',
      status: 'recoverable-error',
      summary: `${failedChecks.length} provider check${failedChecks.length === 1 ? '' : 's'} need attention.`,
      detail: failedChecks
        .map(check => `${check.label}: ${check.detail || check.summary}`)
        .join('\n'),
      actionLabel: 'Fix and retry',
    };
  }

  return {
    id: 'provider-validation',
    label: 'Provider validation',
    status: 'success',
    summary: 'Discord and Supabase provider checks passed.',
    detail: checks
      .filter(check => check.status === 'success')
      .map(check => `${check.label}: ${check.summary}`)
      .join('\n'),
  };
}

function getProviderCheck(input: SetupFlowInput, id: ProviderValidationCheck['id']): ProviderValidationCheck | undefined {
  const checks = Array.isArray(input.providerValidation?.checks) ? input.providerValidation.checks : [];
  return checks.find(check => check.id === id);
}

function formatLocalServiceDetail(readiness: LocalServiceReadiness | undefined): string {
  if (!readiness) {
    return 'Start setup so the launcher can check the dashboard health endpoint after services boot.';
  }

  const processSummary = [
    readiness.dashboard ? `dashboard process=${readiness.dashboard}` : '',
    readiness.bot ? `bot process=${readiness.bot}` : '',
    readiness.lavalink && readiness.lavalink !== 'offline' ? `lavalink=${readiness.lavalink}` : '',
  ].filter(Boolean);
  const health = readiness.dashboardHealth;
  const healthSummary = health?.services
    ? Object.entries(health.services).map(([name, state]) => `${name}=${state}`)
    : [];
  const parts = [
    ...processSummary,
    ...healthSummary,
  ];

  return parts.length > 0
    ? parts.join(', ')
    : 'No local runtime services have reported status yet.';
}

function buildRunningLocalStep(input: SetupFlowInput): SetupStep {
  const readiness = input.localServiceReadiness;
  const health = readiness?.dashboardHealth;

  if (health?.ok) {
    return {
      id: 'start-local',
      label: 'Runtime health',
      status: 'success',
      summary: 'Local runtime health is verified.',
      detail: `The dashboard health endpoint proves the bot heartbeat and required services are ready: ${formatLocalServiceDetail(readiness)}.`,
    };
  }

  return {
    id: 'start-local',
    label: 'Runtime health',
    status: 'pending',
    summary: 'Waiting for local runtime health proof.',
    detail: health?.error
      ? `${health.error} Re-run setup after the bot, dashboard, and Valkey are healthy.`
      : `The launcher sees local services starting, but /api/health has not proved the bot heartbeat yet. ${formatLocalServiceDetail(readiness)}`,
    actionLabel: 'Re-check runtime',
  };
}

function buildDiscordServerStep(input: SetupFlowInput): SetupStep {
  const guildId = input.discordGuildId?.trim() ?? '';
  const inviteDetail = guildId
    ? 'Open the bot invite for the entered server, authorize SomniBot, then re-check providers so the launcher can verify membership.'
    : 'Open the bot invite, choose the server in Discord, then re-check providers. If one server should be locked in, paste its Guild ID before inviting.';

  if (!input.credentialReady) {
    return {
      id: 'discord-server',
      label: 'Discord server',
      status: 'pending',
      summary: 'Waiting for Discord app fields.',
      detail: 'Enter the bot token, Application ID, and client secret before inviting or verifying the bot.',
    };
  }

  if (input.checking) {
    return {
      id: 'discord-server',
      label: 'Discord server',
      status: 'loading',
      summary: 'Checking bot server readiness.',
      detail: 'The launcher is verifying that the bot token works and that the bot can see the selected Discord server.',
    };
  }

  const guildCheck = getProviderCheck(input, 'discord-guild');
  if (!guildCheck) {
    return {
      id: 'discord-server',
      label: 'Discord server',
      status: 'pending',
      summary: 'Ready to invite and verify the bot.',
      detail: inviteDetail,
      actionLabel: 'Open bot invite',
      actionKind: 'discord-invite',
      manualAction: true,
    };
  }

  if (guildCheck.status === 'failed') {
    return {
      id: 'discord-server',
      label: 'Discord server',
      status: 'recoverable-error',
      summary: 'Bot server membership needs attention.',
      detail: [
        guildCheck.detail || guildCheck.summary,
        inviteDetail,
      ].join('\n'),
      actionLabel: 'Open bot invite',
      actionKind: 'discord-invite',
      manualAction: true,
    };
  }

  if (guildCheck.status === 'skipped') {
    return {
      id: 'discord-server',
      label: 'Discord server',
      status: 'pending',
      summary: 'Waiting for a valid Discord bot token.',
      detail: guildCheck.summary,
    };
  }

  return {
    id: 'discord-server',
    label: 'Discord server',
    status: 'success',
    summary: 'Discord server readiness verified.',
    detail: guildCheck.summary,
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
    // The regular-local dashboard listens on a non-default port, so stripping
    // it produces an unusable operator URL. VPS summaries still hide their
    // internal service port behind the public HTTPS origin.
    localDashboardUrl: runtimeMode === 'vps'
      ? displayUrlWithoutPort(operatorDashboardUrl)
      : operatorDashboardUrl,
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

  let callbackStep: SetupStep;
  if (callbackRaw && callbackErrors.length > 0) {
    callbackStep = {
      id: 'regular-callback',
      label: 'Tailscale public callback',
      status: 'recoverable-error',
      summary: 'The public callback URL needs attention.',
      detail: callbackErrors.join('\n'),
      actionLabel: 'Fix callback URL',
    };
  } else if (callbackRaw) {
    callbackStep = {
      id: 'regular-callback',
      label: 'Tailscale public callback',
      status: 'success',
      summary: 'Public provider callbacks are ready.',
      detail: 'Discord auth and PayPal webhooks will use the configured public callback URL.',
    };
  } else {
    switch (input.tailscaleReadinessState) {
      case 'not-installed':
        callbackStep = {
          id: 'regular-callback',
          label: 'Tailscale public callback',
          status: 'blocked',
          summary: 'Tailscale is not installed.',
          detail: 'Install Tailscale on this computer, then the launcher can prepare the public callback automatically.',
          actionLabel: 'Install Tailscale',
          manualAction: true,
        };
        break;
      case 'not-logged-in':
        callbackStep = input.tailscaleAuthKeyReady
          ? {
            id: 'regular-callback',
            label: 'Tailscale public callback',
            status: 'pending',
            summary: 'Tailscale sign-in can be automated.',
            detail: 'The launcher will use the saved Tailscale auth key to sign in, enable Funnel, and fill the public callback URL.',
            actionLabel: 'Sign in during setup',
          }
          : {
            id: 'regular-callback',
            label: 'Tailscale public callback',
            status: 'blocked',
            summary: 'Tailscale is not signed in.',
            detail: 'Sign in to Tailscale on this computer or add a Tailscale auth key so the launcher can sign in during setup.',
            actionLabel: 'Sign in or add auth key',
            manualAction: true,
          };
        break;
      case 'needs-permission':
        callbackStep = {
          id: 'regular-callback',
          label: 'Tailscale public callback',
          status: 'blocked',
          summary: 'Tailscale status needs Windows permission.',
          detail: 'Tailscale is installed, but Windows blocked the launcher from reading its service. Restart SomniBot with the required permission, then check Tailscale again.',
          actionLabel: 'Restart with permission',
          manualAction: true,
        };
        break;
      case 'needs-policy':
        callbackStep = {
          id: 'regular-callback',
          label: 'Tailscale public callback',
          status: 'blocked',
          summary: 'Tailnet policy blocks Funnel.',
          detail: 'Allow Tailscale Funnel for this machine in tailnet policy, then check Tailscale again.',
          actionLabel: 'Allow Funnel in Tailscale',
          manualAction: true,
        };
        break;
      case 'unsupported-platform':
        callbackStep = {
          id: 'regular-callback',
          label: 'Tailscale public callback',
          status: 'blocked',
          summary: 'This Tailscale install cannot use Funnel.',
          detail: 'Use a Tailscale install that exposes the CLI Funnel feature, or paste a valid HTTPS callback URL manually.',
          actionLabel: 'Use supported Tailscale',
          manualAction: true,
        };
        break;
      case 'error':
        callbackStep = {
          id: 'regular-callback',
          label: 'Tailscale public callback',
          status: 'recoverable-error',
          summary: 'Tailscale readiness could not be checked.',
          detail: 'Check Tailscale again or paste a valid HTTPS callback URL manually.',
          actionLabel: 'Check Tailscale',
        };
        break;
      case 'not-configured':
        callbackStep = {
          id: 'regular-callback',
          label: 'Tailscale public callback',
          status: 'pending',
          summary: 'Tailscale is ready for automatic Funnel setup.',
          detail: 'The launcher will enable Funnel and fill the public callback URL during setup.',
          actionLabel: 'Enable during setup',
        };
        break;
      case 'needs-dashboard':
      case 'ready':
        callbackStep = {
          id: 'regular-callback',
          label: 'Tailscale public callback',
          status: 'pending',
          summary: 'Tailscale Funnel is ready to verify.',
          detail: 'The launcher will start the local dashboard, verify the public callback, and keep the callback URL filled in.',
          actionLabel: 'Verify during setup',
        };
        break;
      default:
        callbackStep = {
          id: 'regular-callback',
          label: 'Tailscale public callback',
          status: 'pending',
          summary: 'Public callback will be prepared during setup.',
          detail: 'The launcher will enable or detect Tailscale Funnel during setup. Paste an HTTPS callback URL only if automatic Funnel setup is not available on this machine.',
          actionLabel: 'Enable during setup',
        };
    }
  }

  const callbackBlocksStart = callbackStep.status === 'blocked' || callbackStep.status === 'recoverable-error';

  const credentialStep = buildCredentialStep(input, 'local');
  const discordServerStep = buildDiscordServerStep(input);
  const providerValidationStep = buildProviderValidationStep(input);

  const authProviderStep = buildAuthProviderStep(input);
  const paypalStep = buildPayPalStep(input);

  const localServicesRunning = input.dashboardOnline || input.localServiceReadiness?.dashboard === 'online';
  const startStep: SetupStep = input.checking
    ? {
      id: 'start-local',
      label: 'Runtime health',
      status: 'loading',
      summary: 'Checking setup gates.',
      detail: 'The launcher is checking readiness before starting the bot and dashboard.',
    }
    : localServicesRunning
      ? buildRunningLocalStep(input)
      : callbackBlocksStart
        ? {
          id: 'start-local',
          label: 'Start locally',
          status: 'blocked',
          summary: 'Blocked by public callback readiness.',
          detail: callbackStep.detail,
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
          : providerValidationStep.status === 'recoverable-error'
            ? {
              id: 'start-local',
              label: 'Start locally',
              status: 'pending',
              summary: 'Waiting for provider validation fixes.',
              detail: 'Fix the provider readiness items above, then run setup again. The launcher will re-check everything before starting services.',
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
              detail: 'The launcher can prepare the public callback, validate credentials, configure provider callbacks, then start the local bot and dashboard.',
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
    discordServerStep,
    providerValidationStep,
    authProviderStep,
    paypalStep,
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

  const credentialStep = buildCredentialStep(input, 'VPS');
  const discordServerStep = buildDiscordServerStep(input);
  const providerValidationStep = buildProviderValidationStep(input);
  const authProviderStep = buildAuthProviderStep(input);
  const paypalStep = buildPayPalStep(input);

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
    discordServerStep,
    providerValidationStep,
    authProviderStep,
    paypalStep,
    deployStep,
  ];
}

function findFirstBlockingStep(steps: SetupStep[]): SetupStep | undefined {
  return steps.find(step => (
    step.status === 'blocked'
    || step.status === 'recoverable-error'
  ));
}

function isBlockingStep(step: SetupStep): boolean {
  return step.status === 'blocked' || step.status === 'recoverable-error';
}

function normalizedUrlsMatch(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeBaseUrl(left);
  const normalizedRight = normalizeBaseUrl(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function publicCallbackProbeUrlMatches(probeUrl: string | undefined, publicCallbackBaseUrl: string | undefined): boolean {
  const normalizedProbeUrl = normalizeBaseUrl(probeUrl);
  const normalizedBaseUrl = normalizeBaseUrl(publicCallbackBaseUrl);
  if (!normalizedProbeUrl || !normalizedBaseUrl) return false;

  const normalizedHealthUrl = normalizeBaseUrl(`${normalizedBaseUrl}/api/health`);
  return normalizedProbeUrl === normalizedBaseUrl || normalizedProbeUrl === normalizedHealthUrl;
}

function findMissingSteps(steps: SetupStep[], requiredStepIds: string[]): SetupStep[] {
  return requiredStepIds
    .map(id => steps.find(step => step.id === id))
    .filter((step): step is SetupStep => Boolean(step && step.status !== 'success'));
}

function labelsForSteps(steps: SetupStep[]): string[] {
  return steps.map(step => step.label);
}

function sentenceList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function completionFromMissingSteps(
  requiredStepIds: string[],
  missingSteps: SetupStep[],
  completeSummary: string,
  completeDetail: string,
): SetupCompletionStatus {
  if (missingSteps.length === 0) {
    return {
      status: 'complete',
      summary: completeSummary,
      detail: completeDetail,
      requiredStepIds,
      missingStepIds: [],
      missingLabels: [],
    };
  }

  const hasHardBlock = missingSteps.some(isBlockingStep);
  const missingLabels = labelsForSteps(missingSteps);
  const missingText = sentenceList(missingLabels);

  return {
    status: hasHardBlock ? 'blocked' : 'incomplete',
    summary: hasHardBlock
      ? 'Owner setup cannot be called complete yet.'
      : 'Owner setup is still waiting for proof.',
    detail: `${missingText} ${missingSteps.length === 1 ? 'needs' : 'need'} ${hasHardBlock ? 'attention' : 'completion proof'} before this setup is complete.`,
    requiredStepIds,
    missingStepIds: missingSteps.map(step => step.id),
    missingLabels,
  };
}

function appendMissingProof(
  missingSteps: SetupStep[],
  steps: SetupStep[],
  id: string,
  summary: string,
  detail: string,
): void {
  if (missingSteps.some(step => step.id === id)) return;

  const step = steps.find(item => item.id === id);
  missingSteps.push({
    id,
    label: step?.label ?? id,
    status: 'pending',
    summary,
    detail,
  });
}

function publicCallbackProofReady(input: SetupFlowInput): boolean {
  return Boolean(
    input.callbackProbe?.ok
    && publicCallbackProbeUrlMatches(input.callbackProbe.url, input.publicCallbackBaseUrl),
  );
}

function discordGuildProofReady(input: SetupFlowInput): boolean {
  return Boolean(
    input.discordGuildId?.trim()
    && getProviderCheck(input, 'discord-guild')?.status === 'success',
  );
}

function authProviderProofReady(input: SetupFlowInput): boolean {
  return Boolean(
    input.supabaseDiscordAuthProviderStatus?.ready
    || (
      input.supabaseDiscordAuthProviderConfigured
      && input.supabaseDiscordAuthProviderStatus?.ready !== false
    ),
  );
}

function payPalWebhookProofReady(input: SetupFlowInput, summary: SetupSummary): boolean {
  return Boolean(
    input.paypalWebhook?.ok
    && normalizedUrlsMatch(input.paypalWebhook.webhookUrl, summary.diagnostics.paypalWebhookUrl),
  );
}

function addSharedCompletionProofRequirements(
  input: SetupFlowInput,
  steps: SetupStep[],
  summary: SetupSummary,
  missingSteps: SetupStep[],
  options: { requireCallbackProbe: boolean },
): void {
  if (options.requireCallbackProbe && !publicCallbackProofReady(input)) {
    appendMissingProof(
      missingSteps,
      steps,
      'regular-callback',
      'Waiting for public callback proof.',
      'Verify that the configured public callback URL reaches this launcher before owner setup can be called complete.',
    );
  }

  if (!discordGuildProofReady(input)) {
    appendMissingProof(
      missingSteps,
      steps,
      'discord-server',
      'Waiting for Discord server proof.',
      'Enter a concrete Discord Guild ID and re-check providers so the launcher proves the bot can see the target server.',
    );
  }

  if (!authProviderProofReady(input)) {
    appendMissingProof(
      missingSteps,
      steps,
      'auth-provider',
      'Waiting for Supabase auth proof.',
      'Completion requires dashboard-verified Discord auth readiness or an explicit manual confirmation, not only a Management API token.',
    );
  }

  if (!payPalWebhookProofReady(input, summary)) {
    appendMissingProof(
      missingSteps,
      steps,
      'paypal-webhook',
      'Waiting for current PayPal webhook proof.',
      'Create or update the PayPal webhook for the current callback URL before owner setup can be called complete.',
    );
  }
}

function buildRegularLocalCompletion(
  input: SetupFlowInput,
  steps: SetupStep[],
  summary: SetupSummary,
): SetupCompletionStatus {
  const requiredStepIds = [
    'regular-callback',
    'credentials',
    'discord-server',
    'provider-validation',
    'auth-provider',
    'paypal-webhook',
    'start-local',
  ];
  const missingSteps = findMissingSteps(steps, requiredStepIds);
  addSharedCompletionProofRequirements(input, steps, summary, missingSteps, { requireCallbackProbe: true });

  return completionFromMissingSteps(
    requiredStepIds,
    missingSteps,
    'Regular local owner setup is complete.',
    'Public callbacks, provider credentials, Discord server readiness, Supabase auth, PayPal webhook readiness, and local runtime health are all verified.',
  );
}

function buildVpsCompletion(
  input: SetupFlowInput,
  steps: SetupStep[],
  healthVerification: VpsHealthVerification | undefined,
  summary: SetupSummary,
): SetupCompletionStatus {
  const requiredStepIds = [
    'vps-domain',
    'vps-ssh',
    'credentials',
    'discord-server',
    'provider-validation',
    'auth-provider',
    'paypal-webhook',
    'vps-health-verification',
  ];
  const missingSteps = findMissingSteps(steps, requiredStepIds.filter(id => id !== 'vps-health-verification'));
  addSharedCompletionProofRequirements(input, steps, summary, missingSteps, { requireCallbackProbe: false });

  if (healthVerification?.status !== 'pass') {
    missingSteps.push({
      id: 'vps-health-verification',
      label: 'VPS health verification',
      status: healthVerification?.status === 'fail' || healthVerification?.status === 'blocked' || healthVerification?.status === 'manual'
        ? 'blocked'
        : 'pending',
      summary: 'Waiting for post-deploy VPS health proof.',
      detail: 'The VPS dashboard, /api/health, Supabase callback allow-list, bot heartbeat, Valkey, and Lavalink checks must pass before VPS setup is complete.',
    });
  }

  return completionFromMissingSteps(
    requiredStepIds,
    missingSteps,
    'VPS owner setup is complete.',
    'Domain, SSH target, provider credentials, Discord server readiness, Supabase auth, PayPal webhook readiness, and post-deploy VPS health verification are all proven.',
  );
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
  const providerValidationStep = steps.find(step => step.id === 'provider-validation');
  const callbackStep = steps.find(step => step.id === 'regular-callback');
  const canRetryProviderValidation = runtimeMode === 'regular-local'
    && Boolean(input.credentialReady)
    && providerValidationStep?.status === 'recoverable-error'
    && !(callbackStep && isBlockingStep(callbackStep));
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
  } else if (canRetryProviderValidation) {
    primaryAction = {
      label: 'Re-check Providers',
      enabled: true,
      status: 'ready',
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
  const completion = runtimeMode === 'vps'
    ? buildVpsCompletion(input, steps, healthVerification, summary)
    : buildRegularLocalCompletion(input, steps, summary);

  return {
    runtimeMode,
    summary,
    steps,
    completion,
    primaryAction,
    firstBlockingStepId: firstBlocking?.id ?? null,
    ...(deploymentPlan ? { deploymentPlan } : {}),
    ...(healthVerification ? { healthVerification } : {}),
  };
}
