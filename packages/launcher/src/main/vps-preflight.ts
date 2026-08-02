export type VpsSshPreflightStatus = 'blocked' | 'ready';
export type VpsSshAuthMode = 'agent-or-default-key' | 'identity-file' | 'unsupported-passphrase-key';

export interface VpsSshPreflightInput {
  host?: string;
  user?: string;
  deployPath?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  explicitUserAction?: boolean;
}

export interface VpsSshCommandPlan {
  executable: 'ssh';
  args: string[];
  redactedArgs: string[];
  redactedDisplay: string;
  readOnly: true;
}

export interface VpsSshPreflightEvent {
  level: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  detail?: string;
}

export interface VpsSshPreflightPlan {
  status: VpsSshPreflightStatus;
  canRun: boolean;
  authMode: VpsSshAuthMode;
  blockedReasons: string[];
  warnings: string[];
  command: VpsSshCommandPlan | null;
  redactedInput: {
    host: string;
    user: string;
    deployPath: string;
    privateKeyPath: string;
    privateKeyPassphrase: string;
  };
  logEvents: VpsSshPreflightEvent[];
}

const REDACTED_KEY_PATH = '[redacted-private-key-path]';
const REDACTED_PASSPHRASE = '[redacted-passphrase]';

function normalizeText(value: string | undefined): string {
  return value?.trim() ?? '';
}

function isSafeHost(value: string): boolean {
  return /^[A-Za-z0-9.-]+$/.test(value) && !value.startsWith('-') && !value.includes('..');
}

function isSafeUser(value: string): boolean {
  return /^[a-z_][a-z0-9_-]*[$]?$/i.test(value);
}

function isSafeDeployPath(value: string): boolean {
  return value.startsWith('/')
    && !/[\0\r\n\t]/.test(value)
    && /^[A-Za-z0-9_./:@+-]+$/.test(value)
    && !value.includes('..');
}

function isSafePrivateKeyPath(value: string): boolean {
  return !value || (
    value.startsWith('/')
    && !/[\0\r\n\t]/.test(value)
    && !value.includes('..')
  );
}

function shellDisplayArg(value: string): string {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildRedactedInput(input: Required<Pick<VpsSshPreflightInput, 'host' | 'user' | 'deployPath' | 'privateKeyPath' | 'privateKeyPassphrase'>>) {
  return {
    host: input.host,
    user: input.user,
    deployPath: input.deployPath,
    privateKeyPath: input.privateKeyPath ? REDACTED_KEY_PATH : '',
    privateKeyPassphrase: input.privateKeyPassphrase ? REDACTED_PASSPHRASE : '',
  };
}

function buildCommand(host: string, user: string, deployPath: string, privateKeyPath: string): VpsSshCommandPlan {
  const target = `${user}@${host}`;
  const baseArgs = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=yes',
  ];

  const keyArgs = privateKeyPath
    ? ['-o', 'IdentitiesOnly=yes', '-i', privateKeyPath]
    : [];
  const redactedKeyArgs = privateKeyPath
    ? ['-o', 'IdentitiesOnly=yes', '-i', REDACTED_KEY_PATH]
    : [];
  const remoteReadOnlyCheck = ['--', target, 'test', '-d', deployPath];
  const args = [...baseArgs, ...keyArgs, ...remoteReadOnlyCheck];
  const redactedArgs = [...baseArgs, ...redactedKeyArgs, ...remoteReadOnlyCheck];

  return {
    executable: 'ssh',
    args,
    redactedArgs,
    redactedDisplay: ['ssh', ...redactedArgs].map(shellDisplayArg).join(' '),
    readOnly: true,
  };
}

export function planVpsSshPreflight(input: VpsSshPreflightInput): VpsSshPreflightPlan {
  const normalized = {
    host: normalizeText(input.host),
    user: normalizeText(input.user),
    deployPath: normalizeText(input.deployPath),
    privateKeyPath: normalizeText(input.privateKeyPath),
    privateKeyPassphrase: normalizeText(input.privateKeyPassphrase),
  };

  const blockedReasons: string[] = [];
  const warnings: string[] = [];

  if (!normalized.host) {
    blockedReasons.push('SSH host is required before preflight can be planned.');
  } else if (!isSafeHost(normalized.host)) {
    blockedReasons.push('SSH host must be a hostname or IPv4 address using only letters, numbers, dots, and hyphens.');
  }

  if (!normalized.user) {
    blockedReasons.push('SSH user is required before preflight can be planned.');
  } else if (!isSafeUser(normalized.user)) {
    blockedReasons.push('SSH user must be a simple account name.');
  }

  if (!normalized.deployPath) {
    blockedReasons.push('Deployment path is required before preflight can be planned.');
  } else if (!isSafeDeployPath(normalized.deployPath)) {
    blockedReasons.push('Deployment path must be an absolute path using safe path characters.');
  }

  if (!isSafePrivateKeyPath(normalized.privateKeyPath)) {
    blockedReasons.push('Private key path must be an absolute local path without traversal or control characters.');
  }

  let authMode: VpsSshAuthMode = normalized.privateKeyPath ? 'identity-file' : 'agent-or-default-key';
  if (!normalized.privateKeyPath) {
    warnings.push('No private key path was provided; preflight will rely on the local SSH agent or default SSH keys.');
  }
  if (normalized.privateKeyPassphrase) {
    authMode = 'unsupported-passphrase-key';
    blockedReasons.push('Passphrase-protected key preflight is not supported yet. Load the key into an SSH agent or omit the passphrase.');
  }
  if (normalized.privateKeyPassphrase && !normalized.privateKeyPath) {
    blockedReasons.push('A key passphrase cannot be used without a private key path.');
  }

  if (!input.explicitUserAction) {
    blockedReasons.push('Explicit user action is required before SSH preflight can run.');
  }

  const redactedInput = buildRedactedInput(normalized);
  const command = blockedReasons.length === 0
    ? buildCommand(normalized.host, normalized.user, normalized.deployPath, normalized.privateKeyPath)
    : null;
  const status: VpsSshPreflightStatus = command ? 'ready' : 'blocked';

  const logEvents: VpsSshPreflightEvent[] = [
    {
      level: status === 'ready' ? 'info' : 'warn',
      code: status === 'ready' ? 'vps-preflight-ready' : 'vps-preflight-blocked',
      message: status === 'ready'
        ? 'VPS SSH preflight command is planned and waiting for explicit execution.'
        : 'VPS SSH preflight is blocked.',
      detail: command?.redactedDisplay ?? blockedReasons.join(' '),
    },
  ];

  for (const warning of warnings) {
    logEvents.push({
      level: 'warn',
      code: 'vps-preflight-warning',
      message: warning,
    });
  }

  return {
    status,
    canRun: Boolean(command),
    authMode,
    blockedReasons,
    warnings,
    command,
    redactedInput,
    logEvents,
  };
}
