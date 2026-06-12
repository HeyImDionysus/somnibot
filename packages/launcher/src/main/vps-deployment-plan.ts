import {
  normalizeVpsDomain,
  normalizeRuntimeMode,
  resolveRuntimeProfile,
  validateRuntimeNetworkingConfig,
  type RuntimeNetworkingConfig,
} from './runtime-profile.js';
import { planVpsSshPreflight } from './vps-preflight.js';

export type VpsDeploymentPlanStatus = 'blocked' | 'ready';

export interface VpsDeploymentPlanInput extends RuntimeNetworkingConfig {
  credentialReady?: boolean;
}

export interface VpsDeploymentEnvVar {
  name: string;
  value: string;
  secret: boolean;
  required: boolean;
  source: 'derived' | 'placeholder' | 'generated-placeholder';
}

export interface VpsDeploymentCommand {
  id: string;
  label: string;
  command: string;
  changesRemote: boolean;
  approvalRequired: boolean;
}

export interface VpsDeploymentApprovalGate {
  id: string;
  label: string;
  detail: string;
  requiredBefore: string;
}

export interface VpsDeploymentPlan {
  status: VpsDeploymentPlanStatus;
  canApprove: boolean;
  blockedReasons: string[];
  warnings: string[];
  target: {
    domain: string;
    publicBaseUrl: string;
    sshHost: string;
    sshUser: string;
    sshTarget: string;
    deployPath: string;
    envFilePath: string;
    envFilePermissions: '0600';
    composeFilePath: string;
  } | null;
  environment: {
    filePath: string;
    permissions: '0600';
    variables: VpsDeploymentEnvVar[];
    redactedEnvFile: string;
  } | null;
  serviceLayout: {
    name: string;
    role: string;
    exposure: 'public' | 'private';
    endpoint: string;
  }[];
  reverseProxy: {
    filePath: string;
    publicPorts: string[];
    upstream: string;
    outline: string[];
  } | null;
  commands: VpsDeploymentCommand[];
  approvalGates: VpsDeploymentApprovalGate[];
  rollback: {
    summary: string;
    commands: VpsDeploymentCommand[];
    notes: string[];
  } | null;
}

const ENV_FILE_PERMISSIONS = '0600' as const;
const COMPOSE_FILE = 'docker-compose.prod.yml';
const CADDY_FILE = 'services/caddy/Caddyfile';

function trim(value: string | undefined): string {
  return value?.trim() ?? '';
}

function joinPath(base: string, child: string): string {
  return `${base.replace(/\/+$/, '')}/${child.replace(/^\/+/, '')}`;
}

function shellDisplayArg(value: string): string {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function hostnameFromUrl(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

function envVar(
  name: string,
  value: string,
  options: Pick<VpsDeploymentEnvVar, 'secret' | 'required' | 'source'>,
): VpsDeploymentEnvVar {
  return {
    name,
    value,
    ...options,
  };
}

function buildEnvironmentVariables(publicBaseUrl: string, domain: string): VpsDeploymentEnvVar[] {
  return [
    envVar('DOMAIN', domain, { secret: false, required: true, source: 'derived' }),
    envVar('NODE_ENV', 'production', { secret: false, required: true, source: 'derived' }),
    envVar('SOMNIBOT_RUNTIME_MODE', 'vps', { secret: false, required: true, source: 'derived' }),
    envVar('SOMNIBOT_PUBLIC_CALLBACK_REQUIRED', 'true', { secret: false, required: true, source: 'derived' }),
    envVar('SOMNIBOT_PUBLIC_CALLBACK_BASE_URL', publicBaseUrl, { secret: false, required: true, source: 'derived' }),
    envVar('DASHBOARD_URL', publicBaseUrl, { secret: false, required: true, source: 'derived' }),
    envVar('NEXT_PUBLIC_APP_URL', publicBaseUrl, { secret: false, required: true, source: 'derived' }),
    envVar('PAYPAL_WEBHOOK_URL', `${publicBaseUrl}/api/paypal/webhook`, { secret: false, required: false, source: 'derived' }),
    envVar('PORT', '3000', { secret: false, required: true, source: 'derived' }),
    envVar('HOSTNAME', '0.0.0.0', { secret: false, required: true, source: 'derived' }),
    envVar('HEALTH_PORT', '3001', { secret: false, required: true, source: 'derived' }),
    envVar('DISCORD_TOKEN', '<DISCORD_TOKEN>', { secret: true, required: true, source: 'placeholder' }),
    envVar('DISCORD_APPLICATION_ID', '<DISCORD_APPLICATION_ID>', { secret: false, required: true, source: 'placeholder' }),
    envVar('DISCORD_CLIENT_SECRET', '<DISCORD_CLIENT_SECRET>', { secret: true, required: true, source: 'placeholder' }),
    envVar('DISCORD_GUILD_ID', '<optional-discord-guild-id>', { secret: false, required: false, source: 'placeholder' }),
    envVar('SUPABASE_URL', '<SUPABASE_PROJECT_URL>', { secret: false, required: true, source: 'placeholder' }),
    envVar('SUPABASE_SECRET_KEY', '<SUPABASE_SECRET_KEY>', { secret: true, required: true, source: 'placeholder' }),
    envVar('NEXT_PUBLIC_SUPABASE_URL', '<SUPABASE_PROJECT_URL>', { secret: false, required: true, source: 'placeholder' }),
    envVar('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '<SUPABASE_PUBLISHABLE_KEY>', { secret: false, required: true, source: 'placeholder' }),
    envVar('CSRF_SECRET', '<openssl-rand-hex-32>', { secret: true, required: true, source: 'generated-placeholder' }),
    envVar('NEXTAUTH_SECRET', '<openssl-rand-hex-32>', { secret: true, required: true, source: 'generated-placeholder' }),
    envVar('WEBHOOK_REPLAY_SECRET', '<openssl-rand-hex-32>', { secret: true, required: true, source: 'generated-placeholder' }),
    envVar('VALKEY_PASSWORD', '<openssl-rand-hex-16>', { secret: true, required: true, source: 'generated-placeholder' }),
    envVar('VALKEY_URL', 'redis://:<VALKEY_PASSWORD>@valkey:6379', { secret: true, required: true, source: 'placeholder' }),
    envVar('LAVALINK_HOST', 'lavalink', { secret: false, required: true, source: 'derived' }),
    envVar('LAVALINK_PORT', '2333', { secret: false, required: true, source: 'derived' }),
    envVar('LAVALINK_PASSWORD', '<openssl-rand-hex-16>', { secret: true, required: true, source: 'generated-placeholder' }),
    envVar('PAYPAL_CLIENT_ID', '<PAYPAL_CLIENT_ID>', { secret: false, required: false, source: 'placeholder' }),
    envVar('PAYPAL_CLIENT_SECRET', '<PAYPAL_CLIENT_SECRET>', { secret: true, required: false, source: 'placeholder' }),
    envVar('PAYPAL_SANDBOX', 'true', { secret: false, required: false, source: 'derived' }),
    envVar('PAYPAL_API_BASE', 'https://api-m.sandbox.paypal.com', { secret: false, required: false, source: 'derived' }),
    envVar('PAYPAL_WEBHOOK_ID', '<PAYPAL_WEBHOOK_ID>', { secret: true, required: false, source: 'placeholder' }),
  ];
}

function buildRedactedEnvFile(variables: VpsDeploymentEnvVar[]): string {
  return variables
    .map(variable => `${variable.name}=${variable.value}`)
    .join('\n');
}

function buildCommands(deployPath: string, publicBaseUrl: string): VpsDeploymentCommand[] {
  return [
    {
      id: 'enter-deploy-path',
      label: 'Open deployment directory',
      command: `cd ${shellDisplayArg(deployPath)}`,
      changesRemote: false,
      approvalRequired: false,
    },
    {
      id: 'protect-env-file',
      label: 'Protect VPS env file',
      command: `chmod ${ENV_FILE_PERMISSIONS} .env`,
      changesRemote: true,
      approvalRequired: true,
    },
    {
      id: 'start-stack',
      label: 'Build and start production stack',
      command: `docker compose -f ${COMPOSE_FILE} up -d --build`,
      changesRemote: true,
      approvalRequired: true,
    },
    {
      id: 'check-stack',
      label: 'Check container status',
      command: `docker compose -f ${COMPOSE_FILE} ps`,
      changesRemote: false,
      approvalRequired: false,
    },
    {
      id: 'check-health',
      label: 'Check public dashboard health',
      command: `curl -fsS ${shellDisplayArg(`${publicBaseUrl}/api/health`)}`,
      changesRemote: false,
      approvalRequired: false,
    },
  ];
}

function buildRollback(publicBaseUrl: string): VpsDeploymentPlan['rollback'] {
  return {
    summary: 'Return the VPS checkout to a last known-good commit, rebuild containers, and verify dashboard health before calling rollback complete.',
    commands: [
      {
        id: 'rollback-fetch',
        label: 'Refresh remote refs',
        command: 'git fetch origin',
        changesRemote: false,
        approvalRequired: false,
      },
      {
        id: 'rollback-checkout',
        label: 'Checkout approved known-good commit',
        command: 'git checkout <last-good-commit>',
        changesRemote: true,
        approvalRequired: true,
      },
      {
        id: 'rollback-rebuild',
        label: 'Rebuild containers from known-good commit',
        command: `docker compose -f ${COMPOSE_FILE} up -d --build`,
        changesRemote: true,
        approvalRequired: true,
      },
      {
        id: 'rollback-health',
        label: 'Verify public health after rollback',
        command: `curl -fsS ${shellDisplayArg(`${publicBaseUrl}/api/health`)}`,
        changesRemote: false,
        approvalRequired: false,
      },
    ],
    notes: [
      'Database migrations remain forward-only; create a new revert migration instead of editing old migrations.',
      'Provider dashboard callback URLs must still match the active public callback base after rollback.',
      'Treat degraded dependency health as a dependency alert rather than automatic dashboard rollback failure.',
    ],
  };
}

export function buildVpsDeploymentPlan(input: VpsDeploymentPlanInput = {}): VpsDeploymentPlan {
  const runtimeMode = normalizeRuntimeMode(input.runtimeMode);
  const blockedReasons: string[] = [];
  const warnings: string[] = [];

  if (runtimeMode !== 'vps') {
    blockedReasons.push('VPS deployment plans are only available in VPS mode.');
  }

  blockedReasons.push(...validateRuntimeNetworkingConfig({
    runtimeMode,
    vpsDomain: input.vpsDomain,
  }));
  const normalizedDomain = normalizeVpsDomain(input.vpsDomain);
  if (runtimeMode === 'vps' && normalizedDomain) {
    const parsedDomain = new URL(normalizedDomain);
    if (parsedDomain.port) {
      blockedReasons.push('VPS deployment plan requires the public domain without an explicit port because Caddy owns ports 80 and 443.');
    }
  }

  const sshPlan = planVpsSshPreflight({
    host: input.vpsSshHost,
    user: input.vpsSshUser,
    deployPath: input.vpsDeployPath,
    explicitUserAction: true,
  });
  blockedReasons.push(...sshPlan.blockedReasons);

  if (!input.credentialReady) {
    warnings.push('Credential fields are not complete yet; the deployment plan will keep secret values as placeholders.');
  }

  if (blockedReasons.length > 0) {
    return {
      status: 'blocked',
      canApprove: false,
      blockedReasons,
      warnings,
      target: null,
      environment: null,
      serviceLayout: [],
      reverseProxy: null,
      commands: [],
      approvalGates: [],
      rollback: null,
    };
  }

  const profile = resolveRuntimeProfile({
    runtimeMode: 'vps',
    vpsDomain: input.vpsDomain,
  });
  const domain = hostnameFromUrl(profile.publicCallbackBaseUrl);
  const sshHost = trim(input.vpsSshHost);
  const sshUser = trim(input.vpsSshUser);
  const deployPath = trim(input.vpsDeployPath);
  const envFilePath = joinPath(deployPath, '.env');
  const composeFilePath = joinPath(deployPath, COMPOSE_FILE);
  const variables = buildEnvironmentVariables(profile.publicCallbackBaseUrl, domain);

  return {
    status: 'ready',
    canApprove: true,
    blockedReasons: [],
    warnings,
    target: {
      domain,
      publicBaseUrl: profile.publicCallbackBaseUrl,
      sshHost,
      sshUser,
      sshTarget: `${sshUser}@${sshHost}`,
      deployPath,
      envFilePath,
      envFilePermissions: ENV_FILE_PERMISSIONS,
      composeFilePath,
    },
    environment: {
      filePath: envFilePath,
      permissions: ENV_FILE_PERMISSIONS,
      variables,
      redactedEnvFile: buildRedactedEnvFile(variables),
    },
    serviceLayout: [
      {
        name: 'dashboard',
        role: 'Next.js operator dashboard and provider callback receiver',
        exposure: 'public',
        endpoint: 'dashboard:3000 behind Caddy',
      },
      {
        name: 'bot',
        role: 'Discord bot worker',
        exposure: 'private',
        endpoint: 'internal Docker network',
      },
      {
        name: 'caddy',
        role: 'Public HTTPS reverse proxy',
        exposure: 'public',
        endpoint: `${domain}:80/443 -> dashboard:3000`,
      },
      {
        name: 'lavalink',
        role: 'Private music service',
        exposure: 'private',
        endpoint: 'http://lavalink:2333',
      },
      {
        name: 'valkey',
        role: 'Private cache, queues, rate limits, and heartbeat state',
        exposure: 'private',
        endpoint: 'redis://:<VALKEY_PASSWORD>@valkey:6379',
      },
    ],
    reverseProxy: {
      filePath: CADDY_FILE,
      publicPorts: ['80/tcp', '443/tcp'],
      upstream: 'dashboard:3000',
      outline: [
        `Set DOMAIN=${domain} in the VPS env file.`,
        'Caddy terminates public HTTPS and proxies requests to dashboard:3000.',
        'Valkey and Lavalink stay on the private Docker network and are never exposed publicly.',
      ],
    },
    commands: buildCommands(deployPath, profile.publicCallbackBaseUrl),
    approvalGates: [
      {
        id: 'dns-domain',
        label: 'DNS and domain approval',
        detail: 'Confirm the public domain points at the VPS before relying on Caddy HTTPS.',
        requiredBefore: 'Public health or callback verification.',
      },
      {
        id: 'env-file',
        label: 'Environment file approval',
        detail: `Create or update ${envFilePath} with the redacted shape, then chmod ${ENV_FILE_PERMISSIONS}.`,
        requiredBefore: 'Starting or rebuilding containers.',
      },
      {
        id: 'provider-callbacks',
        label: 'Provider callback approval',
        detail: 'Update Discord, Supabase, and PayPal dashboards to use the VPS callback URLs only after human approval.',
        requiredBefore: 'External OAuth/webhook smoke checks.',
      },
      {
        id: 'compose-start',
        label: 'Container start approval',
        detail: `Run docker compose from ${deployPath} only after the env file and provider settings are approved.`,
        requiredBefore: 'Any remote process change.',
      },
    ],
    rollback: buildRollback(profile.publicCallbackBaseUrl),
  };
}
