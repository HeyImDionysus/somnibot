import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  REGULAR_LOCAL_DASHBOARD_HOSTNAME,
  REGULAR_LOCAL_DASHBOARD_PORT,
  normalizeBaseUrl,
  validatePublicCallbackBaseUrl,
} from './runtime-profile.js';

const execFileAsync = promisify(execFile);

export const TAILSCALE_FUNNEL_HTTPS_PORT = 443;
export const TAILSCALE_DNS_PROPAGATION_WAIT_MS = 10 * 60 * 1000;
export const SOMNIBOT_FUNNEL_TARGET = `http://${REGULAR_LOCAL_DASHBOARD_HOSTNAME}:${REGULAR_LOCAL_DASHBOARD_PORT}`;

const DEFAULT_COMMAND_TIMEOUT_MS = 12_000;
const HEALTH_PROBE_TIMEOUT_MS = 8_000;
const TS_NET_HOST_RE = /(?:https:\/\/)?([a-z0-9][a-z0-9.-]*\.ts\.net)(?::(443|8443|10000))?/i;

export interface TailscaleCommandResult {
  stdout: string;
  stderr: string;
}

export type TailscaleRunner = (args: string[], options?: {
  timeoutMs?: number;
}) => Promise<TailscaleCommandResult>;

export type TailscaleReadinessState =
  | 'ready'
  | 'not-installed'
  | 'not-logged-in'
  | 'not-configured'
  | 'needs-dashboard'
  | 'needs-policy'
  | 'unsupported-platform'
  | 'error';

export interface TailscaleStatusInfo {
  backendState: string;
  loggedIn: boolean;
  dnsName: string;
  hostName: string;
  user: string;
}

export interface FunnelStatusInfo {
  publicUrl: string;
  target: string;
  enabled: boolean;
  allowFunnel: boolean;
  raw: string;
}

export interface TailscaleReadiness {
  state: TailscaleReadinessState;
  installed: boolean;
  loggedIn: boolean;
  funnelEnabled: boolean;
  publicCallbackBaseUrl: string;
  dashboardTarget: string;
  commandPreview: string[];
  dnsPropagationWaitMs: number;
  message: string;
  detail?: string;
  version?: string;
  status?: TailscaleStatusInfo;
  funnel?: FunnelStatusInfo;
}

export interface CallbackProbeResult {
  ok: boolean;
  url: string;
  status?: number;
  error?: string;
}

export class TailscaleCommandError extends Error {
  code?: string;
  stdout: string;
  stderr: string;

  constructor(message: string, options: {
    code?: string;
    stdout?: string;
    stderr?: string;
  } = {}) {
    super(redactTailscaleOutput(message));
    this.name = 'TailscaleCommandError';
    this.code = options.code;
    this.stdout = redactTailscaleOutput(options.stdout ?? '');
    this.stderr = redactTailscaleOutput(options.stderr ?? '');
  }
}

export function redactTailscaleOutput(value: string): string {
  return value
    .replace(/tskey-[A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*/g, '[redacted-tailscale-key]')
    .replace(/(authkey=)[^\s&]+/gi, '$1[redacted]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1[redacted]');
}

export function buildEnableFunnelArgs(
  target = SOMNIBOT_FUNNEL_TARGET,
  httpsPort = TAILSCALE_FUNNEL_HTTPS_PORT,
): string[] {
  if (![443, 8443, 10000].includes(httpsPort)) {
    throw new Error('Tailscale Funnel can only listen on ports 443, 8443, or 10000.');
  }

  return ['funnel', '--bg', `--https=${httpsPort}`, '--yes', target];
}

export function buildFunnelStatusArgs(json = true): string[] {
  return json ? ['funnel', 'status', '--json'] : ['funnel', 'status'];
}

export function buildStatusArgs(): string[] {
  return ['status', '--json'];
}

export function buildVersionArgs(): string[] {
  return ['version'];
}

export function buildLoginWithAuthKeyArgs(authKeyFilePath: string): string[] {
  return ['login', `--auth-key=file:${authKeyFilePath}`, '--timeout=30s'];
}

export const defaultTailscaleRunner: TailscaleRunner = async (args, options = {}) => {
  try {
    const result = await execFileAsync('tailscale', args, {
      timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });

    return {
      stdout: redactTailscaleOutput(result.stdout),
      stderr: redactTailscaleOutput(result.stderr),
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };

    throw new TailscaleCommandError(error.message || 'Tailscale command failed.', {
      code: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    });
  }
};

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeDnsName(value: string): string {
  return value.trim().replace(/\.$/, '').toLowerCase();
}

export function parseTailscaleStatusJson(stdout: string): TailscaleStatusInfo {
  const parsed = objectValue(parseJson(stdout));
  const self = objectValue(parsed.Self);
  const user = objectValue(parsed.User);
  const backendState = stringValue(parsed.BackendState);
  const dnsName = normalizeDnsName(stringValue(self.DNSName));

  return {
    backendState,
    loggedIn: backendState === 'Running',
    dnsName,
    hostName: stringValue(self.HostName),
    user: stringValue(user.LoginName) || stringValue(user.DisplayName),
  };
}

interface TsNetEndpoint {
  host: string;
  port: number;
  hostPort: string;
  publicUrl: string;
}

function extractTsNetEndpoint(value: string): TsNetEndpoint | null {
  const match = value.match(TS_NET_HOST_RE);
  const host = match?.[1]?.toLowerCase() ?? '';
  if (!host) return null;
  const port = Number(match?.[2] ?? TAILSCALE_FUNNEL_HTTPS_PORT);

  return {
    host,
    port,
    hostPort: `${host}:${port}`,
    publicUrl: port === 443 ? `https://${host}` : `https://${host}:${port}`,
  };
}

function extractDashboardTarget(value: string): string {
  const targetMatch = value.match(/https?:\/\/(?:127\.0\.0\.1|localhost):3456(?:\/[^\s|"'\\]*)?/i);
  return targetMatch?.[0] ?? '';
}

interface FunnelMatch {
  endpoint: TsNetEndpoint;
  target: string;
}

function findFunnelMatch(value: unknown, scopedEndpoint: TsNetEndpoint | null = null): FunnelMatch | null {
  if (typeof value === 'string') {
    const endpoint = extractTsNetEndpoint(value) ?? scopedEndpoint;
    const target = extractDashboardTarget(value);
    return endpoint && target ? { endpoint, target } : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findFunnelMatch(item, scopedEndpoint);
      if (match) return match;
    }
    return null;
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childScopedEndpoint = extractTsNetEndpoint(key) ?? scopedEndpoint;
      const directMatch = findFunnelMatch(child, childScopedEndpoint);
      if (directMatch) return directMatch;
    }
  }

  return null;
}

function hasAllowFunnel(parsed: unknown, endpoint: TsNetEndpoint | null): boolean {
  if (!endpoint) return false;
  const allowFunnel = objectValue(objectValue(parsed).AllowFunnel);
  return allowFunnel[endpoint.hostPort] === true;
}

export function parseFunnelStatusJson(stdout: string): FunnelStatusInfo {
  const parsed = parseJson(stdout);
  const match = findFunnelMatch(parsed);
  const allowFunnel = hasAllowFunnel(parsed, match?.endpoint ?? null);
  const target = match?.target ?? '';
  const enabled = Boolean(match?.endpoint && target && allowFunnel);

  return {
    publicUrl: enabled ? match?.endpoint.publicUrl ?? '' : '',
    target,
    enabled,
    allowFunnel,
    raw: redactTailscaleOutput(stdout),
  };
}

export function parseFunnelStatusText(stdout: string): FunnelStatusInfo {
  let endpoint: TsNetEndpoint | null = null;
  let target = '';

  for (const line of stdout.split(/\r?\n/)) {
    const lineEndpoint = extractTsNetEndpoint(line);
    if (lineEndpoint) endpoint = lineEndpoint;

    const lineTarget = extractDashboardTarget(line);
    if (endpoint && lineTarget) {
      target = lineTarget;
      break;
    }
  }
  const enabled = Boolean(endpoint && target);

  return {
    publicUrl: endpoint ? endpoint.publicUrl : '',
    target,
    enabled,
    allowFunnel: enabled,
    raw: redactTailscaleOutput(stdout),
  };
}

export async function getFunnelStatus(runner: TailscaleRunner = defaultTailscaleRunner): Promise<FunnelStatusInfo> {
  try {
    const result = await runner(buildFunnelStatusArgs(true));
    const parsed = parseFunnelStatusJson(result.stdout);
    if (parsed.publicUrl || parsed.target) return parsed;
  } catch {
    // Older Tailscale clients may not support JSON for funnel status.
  }

  const result = await runner(buildFunnelStatusArgs(false));
  return parseFunnelStatusText(`${result.stdout}\n${result.stderr}`);
}

function platformWarningMessage(): string {
  if (process.platform === 'darwin') {
    return 'Tailscale Funnel on macOS requires a Tailscale app variant that exposes the CLI Funnel feature.';
  }
  return '';
}

function isUnsupportedFunnelText(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes('funnel') && (
    normalized.includes('unsupported')
    || normalized.includes('not supported')
    || normalized.includes('not available')
    || normalized.includes('unavailable')
    || normalized.includes('unknown command')
    || normalized.includes('unknown subcommand')
    || normalized.includes('not implemented')
  );
}

function commandPreview(): string[] {
  return ['tailscale', ...buildEnableFunnelArgs()];
}

function readinessBase(overrides: Partial<TailscaleReadiness>): TailscaleReadiness {
  return {
    state: 'error',
    installed: false,
    loggedIn: false,
    funnelEnabled: false,
    publicCallbackBaseUrl: '',
    dashboardTarget: SOMNIBOT_FUNNEL_TARGET,
    commandPreview: commandPreview(),
    dnsPropagationWaitMs: TAILSCALE_DNS_PROPAGATION_WAIT_MS,
    message: 'Tailscale readiness could not be determined.',
    ...overrides,
  };
}

export async function getTailscaleReadiness(
  runner: TailscaleRunner = defaultTailscaleRunner,
): Promise<TailscaleReadiness> {
  const platformWarning = platformWarningMessage();

  let version = '';
  try {
    const versionResult = await runner(buildVersionArgs(), { timeoutMs: 5_000 });
    version = redactTailscaleOutput(versionResult.stdout.split('\n')[0]?.trim() ?? '');
  } catch (err) {
    const error = err as TailscaleCommandError;
    if (error.code === 'ENOENT') {
      return readinessBase({
        state: 'not-installed',
        message: 'Tailscale CLI was not found on this machine.',
        detail: 'Install Tailscale and sign in before enabling the public callback.',
      });
    }

    return readinessBase({
      state: 'error',
      installed: true,
      message: 'Tailscale CLI could not be checked.',
      detail: error.stderr || error.message,
    });
  }

  let status: TailscaleStatusInfo;
  try {
    const statusResult = await runner(buildStatusArgs(), { timeoutMs: 8_000 });
    status = parseTailscaleStatusJson(statusResult.stdout);
  } catch (err) {
    const error = err as TailscaleCommandError;
    return readinessBase({
      state: 'error',
      installed: true,
      version,
      message: 'Tailscale status could not be read.',
      detail: error.stderr || error.message || platformWarning,
    });
  }

  if (!status.loggedIn) {
    return readinessBase({
      state: 'not-logged-in',
      installed: true,
      version,
      status,
      message: 'Tailscale is installed, but this machine is not signed in.',
      detail: platformWarning || 'Sign in with the Tailscale app or CLI, then check again.',
    });
  }

  try {
    const funnel = await getFunnelStatus(runner);
    if (!funnel.enabled) {
      return readinessBase({
        state: 'not-configured',
        installed: true,
        loggedIn: true,
        version,
        status,
        funnel,
        message: 'Tailscale is signed in. Funnel is not enabled for SomniBot yet.',
        detail: platformWarning,
      });
    }

    return readinessBase({
      state: 'needs-dashboard',
      installed: true,
      loggedIn: true,
      funnelEnabled: true,
      version,
      status,
      funnel,
      publicCallbackBaseUrl: funnel.publicUrl,
      message: 'Tailscale Funnel is configured. Start the dashboard, then verify the callback health check.',
      detail: platformWarning,
    });
  } catch (err) {
    const error = err as TailscaleCommandError;
    const text = `${error.stderr}\n${error.stdout}\n${error.message}`.toLowerCase();
    if (isUnsupportedFunnelText(text)) {
      return readinessBase({
        state: 'unsupported-platform',
        installed: true,
        loggedIn: true,
        version,
        status,
        message: 'This Tailscale install does not support the CLI Funnel feature.',
        detail: error.stderr || error.message || platformWarning,
      });
    }

    if (text.includes('funnel') && (text.includes('policy') || text.includes('permission') || text.includes('attribute'))) {
      return readinessBase({
        state: 'needs-policy',
        installed: true,
        loggedIn: true,
        version,
        status,
        message: 'This tailnet does not currently allow Funnel for this machine.',
        detail: error.stderr || error.message,
      });
    }

    return readinessBase({
      state: 'error',
      installed: true,
      loggedIn: true,
      version,
      status,
      message: 'Tailscale Funnel status could not be read.',
      detail: error.stderr || error.message,
    });
  }
}

function authKeyMissingReadiness(): TailscaleReadiness {
  return readinessBase({
    state: 'not-logged-in',
    installed: true,
    message: 'Tailscale is installed, but this machine is not signed in.',
    detail: 'Add a Tailscale auth key, then enable Funnel again.',
  });
}

export async function loginWithTailscaleAuthKey(
  authKey: string,
  runner: TailscaleRunner = defaultTailscaleRunner,
): Promise<TailscaleReadiness> {
  const trimmed = authKey.trim();
  if (!trimmed) return authKeyMissingReadiness();

  let dir = '';
  try {
    dir = await mkdtemp(join(tmpdir(), 'somnibot-tailscale-auth-'));
    const authKeyPath = join(dir, 'authkey');
    await writeFile(authKeyPath, trimmed, { mode: 0o600 });
    await runner(buildLoginWithAuthKeyArgs(authKeyPath), { timeoutMs: 60_000 });
  } catch (err) {
    const error = err as TailscaleCommandError;
    const text = `${error.stderr ?? ''}\n${error.stdout ?? ''}\n${error.message ?? ''}`.toLowerCase();

    if (error.code === 'ENOENT') {
      return readinessBase({
        state: 'not-installed',
        message: 'Tailscale CLI was not found on this machine.',
        detail: 'Install Tailscale before enabling the public callback.',
      });
    }

    if (text.includes('permission') || text.includes('policy') || text.includes('attribute')) {
      return readinessBase({
        state: 'needs-policy',
        installed: true,
        message: 'Tailscale rejected auth or Funnel setup because tailnet policy approval is needed.',
        detail: error.stderr || error.message,
      });
    }

    return readinessBase({
      state: 'not-logged-in',
      installed: true,
      message: 'Tailscale auth failed.',
      detail: error.stderr || error.message,
    });
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return getTailscaleReadiness(runner);
}

export async function enableSomniBotFunnel(
  runner: TailscaleRunner = defaultTailscaleRunner,
  options: { authKey?: string } = {},
): Promise<TailscaleReadiness> {
  const authKey = options.authKey?.trim() ?? '';
  if (authKey) {
    const readiness = await getTailscaleReadiness(runner);
    if (readiness.state === 'not-installed' || readiness.state === 'needs-policy' || readiness.state === 'error') {
      return readiness;
    }
    if (!readiness.loggedIn || readiness.state === 'not-logged-in') {
      const loginReadiness = await loginWithTailscaleAuthKey(authKey, runner);
      if (!loginReadiness.loggedIn) return loginReadiness;
      if (loginReadiness.funnelEnabled && loginReadiness.publicCallbackBaseUrl) {
        return loginReadiness;
      }
    } else if (readiness.funnelEnabled && readiness.publicCallbackBaseUrl) {
      return readiness;
    }
  }

  const args = buildEnableFunnelArgs();

  try {
    await runner(args, { timeoutMs: 30_000 });
  } catch (err) {
    const error = err as TailscaleCommandError;
    const text = `${error.stderr}\n${error.stdout}\n${error.message}`.toLowerCase();
    if (isUnsupportedFunnelText(text)) {
      return readinessBase({
        state: 'unsupported-platform',
        installed: true,
        loggedIn: true,
        message: 'This Tailscale install does not support the CLI Funnel feature.',
        detail: error.stderr || error.message,
      });
    }

    if (text.includes('login') || text.includes('not logged in') || text.includes('not signed in')) {
      return readinessBase({
        state: 'not-logged-in',
        installed: true,
        message: 'Tailscale is installed, but this machine is not signed in.',
        detail: error.stderr || error.message,
      });
    }

    if (text.includes('permission') || text.includes('policy') || text.includes('attribute')) {
      return readinessBase({
        state: 'needs-policy',
        installed: true,
        loggedIn: true,
        message: 'Tailscale rejected the Funnel change because tailnet policy approval is needed.',
        detail: error.stderr || error.message,
      });
    }

    return readinessBase({
      state: 'error',
      installed: true,
      loggedIn: true,
      message: 'Tailscale Funnel could not be enabled.',
      detail: error.stderr || error.message,
    });
  }

  return getTailscaleReadiness(runner);
}

export async function probePublicCallbackHealth(
  publicCallbackBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CallbackProbeResult> {
  const normalized = normalizeBaseUrl(publicCallbackBaseUrl);
  const validationErrors = normalized
    ? validatePublicCallbackBaseUrl(normalized)
    : ['Public callback URL must be a valid HTTP or HTTPS URL.'];

  if (validationErrors.length > 0) {
    return {
      ok: false,
      url: normalized,
      error: validationErrors.join('\n'),
    };
  }

  const parsed = new URL(normalized);
  if (!parsed.hostname.endsWith('.ts.net')) {
    return {
      ok: false,
      url: normalized,
      error: 'Tailscale callback verification only accepts Funnel URLs on ts.net hostnames.',
    };
  }

  const url = `${normalized}/api/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });

    return {
      ok: res.ok,
      url,
      status: res.status,
      error: res.ok ? undefined : `Health check returned HTTP ${res.status}.`,
    };
  } catch (err) {
    const error = err as Error;
    return {
      ok: false,
      url,
      error: error.name === 'AbortError'
        ? 'Health check timed out. Tailscale DNS can take up to 10 minutes after enabling Funnel.'
        : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
