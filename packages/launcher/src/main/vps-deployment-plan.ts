import {
  normalizeVpsDomain,
  normalizeRuntimeMode,
  resolveRuntimeProfile,
  validateRuntimeNetworkingConfig,
  type RuntimeNetworkingConfig,
} from './runtime-profile.js';
import { planVpsSshPreflight } from './vps-preflight.js';

export type VpsDeploymentPlanStatus = 'blocked' | 'ready';
export const VPS_DEPLOYMENT_BUILD_TIMEOUT_MS = 45 * 60 * 1000;

export interface VpsDeploymentPlanInput extends RuntimeNetworkingConfig {
  credentialReady?: boolean;
  paypalReady?: boolean;
  supabaseAccessTokenReady?: boolean;
  supabaseDiscordAuthProviderConfigured?: boolean;
  lastGoodCommit?: string;
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
  executable: string;
  args: string[];
  redactedArgs: string[];
  redactedDisplay: string;
  changesRemote: boolean;
  approvalRequired: boolean;
  commandCategory: 'env' | 'service' | 'probe' | 'rollback';
  executionTimeoutMs?: number;
  expectedHealthStatus?: 'healthy';
  /** Main-process-only input. Never included in displays, logs, or renderer payloads. */
  sensitiveStdin?: string;
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

export const ENV_FILE_PERMISSIONS = '0600' as const;
const SSH_BASE_ARGS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'StrictHostKeyChecking=yes',
] as const;
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

function hasAuthProviderSetupPath(input: Pick<VpsDeploymentPlanInput, 'supabaseAccessTokenReady' | 'supabaseDiscordAuthProviderConfigured'>): boolean {
  return Boolean(input.supabaseAccessTokenReady || input.supabaseDiscordAuthProviderConfigured);
}

function buildEnvironmentVariables(
  publicBaseUrl: string,
  domain: string,
  authProvider: Pick<VpsDeploymentPlanInput, 'supabaseAccessTokenReady' | 'supabaseDiscordAuthProviderConfigured'>,
): VpsDeploymentEnvVar[] {
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
    envVar('SUPABASE_DB_URL', '<SUPABASE_DB_URL>', { secret: true, required: true, source: 'placeholder' }),
    envVar('SUPABASE_ACCESS_TOKEN', authProvider.supabaseAccessTokenReady ? '<SUPABASE_ACCESS_TOKEN>' : '', {
      secret: true,
      required: !authProvider.supabaseDiscordAuthProviderConfigured,
      source: authProvider.supabaseAccessTokenReady ? 'placeholder' : 'derived',
    }),
    envVar('SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED', authProvider.supabaseDiscordAuthProviderConfigured ? 'true' : 'false', {
      secret: false,
      required: true,
      source: 'derived',
    }),
    envVar('NEXT_PUBLIC_SUPABASE_URL', '<SUPABASE_PROJECT_URL>', { secret: false, required: true, source: 'placeholder' }),
    envVar('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '<SUPABASE_PUBLISHABLE_KEY>', { secret: false, required: true, source: 'placeholder' }),
    envVar('CSRF_SECRET', '<node-scripts-gen-secret-mjs>', { secret: true, required: true, source: 'generated-placeholder' }),
    envVar('NEXTAUTH_SECRET', '<node-scripts-gen-secret-mjs>', { secret: true, required: true, source: 'generated-placeholder' }),
    envVar('WEBHOOK_REPLAY_SECRET', '<node-scripts-gen-secret-mjs>', { secret: true, required: true, source: 'generated-placeholder' }),
    envVar('VALKEY_PASSWORD', '<node-scripts-gen-secret-mjs-16>', { secret: true, required: true, source: 'generated-placeholder' }),
    envVar('VALKEY_URL', 'redis://:<VALKEY_PASSWORD>@valkey:6379', { secret: true, required: true, source: 'placeholder' }),
    envVar('LAVALINK_HOST', 'lavalink', { secret: false, required: true, source: 'derived' }),
    envVar('LAVALINK_PORT', '2333', { secret: false, required: true, source: 'derived' }),
    envVar('LAVALINK_PASSWORD', '<node-scripts-gen-secret-mjs-16>', { secret: true, required: true, source: 'generated-placeholder' }),
    envVar('PAYPAL_CLIENT_ID', '<PAYPAL_CLIENT_ID>', { secret: false, required: false, source: 'placeholder' }),
    envVar('PAYPAL_CLIENT_SECRET', '<PAYPAL_CLIENT_SECRET>', { secret: true, required: false, source: 'placeholder' }),
    envVar('PAYPAL_SANDBOX', 'true', { secret: false, required: false, source: 'derived' }),
    envVar('PAYPAL_API_BASE', 'https://api-m.sandbox.paypal.com', { secret: false, required: false, source: 'derived' }),
    envVar('PAYPAL_WEBHOOK_ID', '<PAYPAL_WEBHOOK_ID>', { secret: true, required: false, source: 'placeholder' }),
  ];
}

function buildRedactedEnvFile(variables: VpsDeploymentEnvVar[]): string {
  return variables
    .map((variable) => `${variable.name}=${variable.value}`)
    .join('\n');
}

function buildCommand(
  executable: string,
  args: string[],
  options: Pick<VpsDeploymentCommand, 'id' | 'label' | 'changesRemote' | 'approvalRequired' | 'commandCategory'> & {
    executionTimeoutMs?: number;
    expectedHealthStatus?: 'healthy';
  },
): VpsDeploymentCommand {
  const redactedArgs = args.map((arg) => arg);
  return {
    id: options.id,
    label: options.label,
    executable,
    args,
    redactedArgs,
    redactedDisplay: [executable, ...redactedArgs].map(shellDisplayArg).join(' '),
    changesRemote: options.changesRemote,
    approvalRequired: options.approvalRequired,
    commandCategory: options.commandCategory,
    ...(options.executionTimeoutMs ? { executionTimeoutMs: options.executionTimeoutMs } : {}),
    ...(options.expectedHealthStatus ? { expectedHealthStatus: options.expectedHealthStatus } : {}),
  };
}

function buildRemoteCommand(
  sshTarget: string,
  remoteExecutable: string,
  remoteArgs: string[],
  options: Pick<VpsDeploymentCommand, 'id' | 'label' | 'changesRemote' | 'approvalRequired' | 'commandCategory'> & {
    executionTimeoutMs?: number;
  },
): VpsDeploymentCommand {
  return buildCommand('ssh', [...SSH_BASE_ARGS, '--', sshTarget, remoteExecutable, ...remoteArgs], options);
}

function buildCommands(sshTarget: string, deployPath: string, publicBaseUrl: string): VpsDeploymentCommand[] {
  const composeFilePath = joinPath(deployPath, COMPOSE_FILE);
  const envFilePath = joinPath(deployPath, '.env');
  const lavalinkProbeScript = [
    'docker',
    'compose',
    '-f',
    composeFilePath,
    'exec',
    '-T',
    'bot',
    'node',
    '-e',
    "fetch('http://lavalink:2333/version').then((response) => { if (!response.ok) process.exit(1); return response.text(); }).then((text) => process.stdout.write(text)).catch(() => process.exit(1));",
  ].map(shellDisplayArg).join(' ');

  return [
    buildRemoteCommand(sshTarget, 'test', ['-d', deployPath], {
      id: 'enter-deploy-path',
      label: 'Verify deployment directory',
      changesRemote: false,
      approvalRequired: false,
      commandCategory: 'service',
    }),
    buildRemoteCommand(sshTarget, 'sh', [
      joinPath(deployPath, 'scripts/write-production-env.sh'),
      envFilePath,
    ], {
      id: 'write-env-file',
      label: 'Write protected VPS environment from saved launcher credentials',
      changesRemote: true,
      approvalRequired: true,
      commandCategory: 'env',
    }),
    buildRemoteCommand(sshTarget, 'chmod', [ENV_FILE_PERMISSIONS, envFilePath], {
      id: 'protect-env-file',
      label: 'Protect VPS env file',
      changesRemote: true,
      approvalRequired: true,
      commandCategory: 'env',
    }),
    buildRemoteCommand(sshTarget, 'docker', ['compose', '-f', composeFilePath, 'up', '-d', '--build'], {
      id: 'start-stack',
      label: 'Build and start production stack',
      changesRemote: true,
      approvalRequired: true,
      commandCategory: 'service',
      executionTimeoutMs: VPS_DEPLOYMENT_BUILD_TIMEOUT_MS,
    }),
    buildRemoteCommand(sshTarget, 'sudo', [
      '-n',
      'sh',
      joinPath(deployPath, 'scripts/install-production-health-recovery.sh'),
      deployPath,
    ], {
      id: 'install-health-recovery',
      label: 'Install boot recovery and validated daily Valkey backups',
      changesRemote: true,
      approvalRequired: true,
      commandCategory: 'service',
    }),
    buildRemoteCommand(sshTarget, 'docker', ['compose', '-f', composeFilePath, 'ps'], {
      id: 'check-stack',
      label: 'Check container status',
      changesRemote: false,
      approvalRequired: false,
      commandCategory: 'service',
    }),
    buildCommand('curl', ['-fsS', '-o', '/dev/null', publicBaseUrl], {
      id: 'check-dashboard',
      label: 'Check public dashboard root',
      changesRemote: false,
      approvalRequired: false,
      commandCategory: 'probe',
    }),
    buildCommand('curl', ['-fsS', `${publicBaseUrl}/api/health`], {
      id: 'check-health',
      label: 'Check public dashboard health',
      changesRemote: false,
      approvalRequired: false,
      commandCategory: 'probe',
      expectedHealthStatus: 'healthy',
    }),
    buildRemoteCommand(sshTarget, 'sh', ['-lc', shellDisplayArg(lavalinkProbeScript)], {
      id: 'check-lavalink',
      label: 'Check private Lavalink route from bot container',
      changesRemote: false,
      approvalRequired: false,
      commandCategory: 'probe',
    }),
  ];
}

function buildRollback(
  sshTarget: string,
  deployPath: string,
  composeFilePath: string,
  publicBaseUrl: string,
  lastGoodCommit: string,
): VpsDeploymentPlan['rollback'] {
  return {
    summary: 'Return the VPS checkout to a last known-good commit, rebuild containers, and verify dashboard health before calling rollback complete.',
    commands: [
      buildRemoteCommand(sshTarget, 'git', ['-C', deployPath, 'fetch', 'origin'], {
        id: 'rollback-fetch',
        label: 'Refresh remote refs',
        changesRemote: false,
        approvalRequired: false,
        commandCategory: 'service',
      }),
      buildRemoteCommand(sshTarget, 'sh', [
        joinPath(deployPath, 'scripts/restore-production-env.sh'),
        joinPath(deployPath, '.env'),
      ], {
        id: 'rollback-restore-env',
        label: 'Restore the protected pre-deployment environment',
        changesRemote: true,
        approvalRequired: true,
        commandCategory: 'rollback',
      }),
      buildRemoteCommand(sshTarget, 'git', ['-C', deployPath, 'checkout', lastGoodCommit], {
        id: 'rollback-checkout',
        label: 'Checkout approved known-good commit',
        changesRemote: true,
        approvalRequired: true,
        commandCategory: 'service',
      }),
      buildRemoteCommand(sshTarget, 'docker', ['compose', '-f', composeFilePath, 'up', '-d', '--build'], {
        id: 'rollback-rebuild',
        label: 'Rebuild containers from known-good commit',
        changesRemote: true,
        approvalRequired: true,
        commandCategory: 'service',
        executionTimeoutMs: VPS_DEPLOYMENT_BUILD_TIMEOUT_MS,
      }),
      buildCommand('curl', ['-fsS', `${publicBaseUrl}/api/health`], {
        id: 'rollback-health',
        label: 'Verify public health after rollback',
        changesRemote: false,
        approvalRequired: false,
        commandCategory: 'probe',
        expectedHealthStatus: 'healthy',
      }),
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

  if (!input.paypalReady) {
    warnings.push('PayPal app/webhook fields are not complete yet; store payments will stay disabled until PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and PAYPAL_WEBHOOK_ID are set.');
  }

  if (!hasAuthProviderSetupPath(input)) {
    blockedReasons.push('Supabase Discord auth provider setup requires a Management API token or manual provider confirmation before VPS deployment.');
  }

  if (input.lastGoodCommit !== undefined && !/^[0-9a-f]{40}$/i.test(input.lastGoodCommit)) {
    blockedReasons.push('Rollback requires an exact 40-character hexadecimal last-good commit SHA.');
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
  const variables = buildEnvironmentVariables(profile.publicCallbackBaseUrl, domain, input);

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
    commands: buildCommands(`${sshUser}@${sshHost}`, deployPath, profile.publicCallbackBaseUrl),
    approvalGates: [
      {
        id: 'ssh-host-key',
        label: 'Verified SSH host key',
        detail: 'Verify and pin the VPS SSH host key before any preflight or credential transfer; live commands refuse unknown or changed hosts.',
        requiredBefore: 'Any SSH connection to the VPS.',
      },
      {
        id: 'dns-domain',
        label: 'DNS and domain approval',
        detail: 'Confirm the public domain points at the VPS before relying on Caddy HTTPS.',
        requiredBefore: 'Public health or callback verification.',
      },
      {
        id: 'env-file',
        label: 'Environment file approval',
        detail: `Allow the launcher to atomically back up and replace ${envFilePath} from saved credentials with mode ${ENV_FILE_PERMISSIONS}.`,
        requiredBefore: 'Starting or rebuilding containers.',
      },
      {
        id: 'auth-provider',
        label: 'Discord auth provider approval',
        detail: 'Confirm Supabase Discord auth can be configured automatically with a Management API token or was configured manually before deployment.',
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
    rollback: input.lastGoodCommit
      ? buildRollback(`${sshUser}@${sshHost}`, deployPath, composeFilePath, profile.publicCallbackBaseUrl, input.lastGoodCommit)
      : {
        summary: 'Rollback requires an operator-supplied exact 40-character last-good commit before any rollback commands can be approved.',
        commands: [],
        notes: [
          'No rollback command is executable until the launcher receives a validated exact commit SHA.',
          'The protected environment must be restored before an older checkout is selected.',
        ],
      },
  };
}

export function buildVpsRollbackPlan(input: VpsDeploymentPlanInput & { lastGoodCommit: string }): VpsDeploymentPlan {
  const basePlan = buildVpsDeploymentPlan({ ...input, lastGoodCommit: undefined });
  if (!/^[0-9a-f]{40}$/i.test(input.lastGoodCommit)) {
    return {
      ...basePlan,
      status: 'blocked',
      canApprove: false,
      blockedReasons: [...basePlan.blockedReasons, 'Rollback requires an exact 40-character hexadecimal last-good commit SHA.'],
      target: null,
      environment: null,
      serviceLayout: [],
      reverseProxy: null,
      commands: [],
      approvalGates: [],
      rollback: null,
    };
  }

  const plan = buildVpsDeploymentPlan(input);
  if (plan.status !== 'ready' || !plan.rollback) {
    return plan;
  }

  return {
    ...plan,
    environment: null,
    serviceLayout: [],
    reverseProxy: null,
    commands: plan.rollback.commands,
    approvalGates: [],
    rollback: null,
  };
}
