import { buildVpsDeploymentPlan, type VpsDeploymentPlanInput } from './vps-deployment-plan.js';

export type VpsHealthCheckStatus = 'pending' | 'running' | 'pass' | 'fail' | 'manual';
export type VpsHealthVerificationStatus = 'blocked' | VpsHealthCheckStatus;

export type VpsProbeState = 'pending' | 'running' | 'success' | 'failure' | 'timeout';

export interface VpsDashboardHealthPayload {
  status?: 'healthy' | 'degraded' | string;
  services?: {
    config?: 'valid' | 'invalid' | 'unknown' | string;
    valkey?: 'connected' | 'fallback' | string;
    bot?: 'online' | 'offline' | 'unknown' | string;
  };
  botRuntime?: {
    bootId?: string | null;
    heartbeatAt?: number | null;
  };
  timestamp?: string;
}

export interface VpsHealthProbeResult {
  state?: VpsProbeState;
  httpStatus?: number;
  response?: VpsDashboardHealthPayload;
  error?: string;
  elapsedMs?: number;
}

export interface VpsManualHealthSignal {
  status?: VpsHealthCheckStatus;
  detail?: string;
  missingCallbackUrls?: string[];
}

export interface VpsHealthVerificationInput extends VpsDeploymentPlanInput {
  httpsDashboardProbe?: VpsHealthProbeResult;
  apiHealthProbe?: VpsHealthProbeResult;
  supabaseCallbackAllowList?: VpsManualHealthSignal;
  lavalink?: VpsManualHealthSignal;
}

export interface VpsHealthCheck {
  id: 'https-dashboard'
    | 'api-health'
    | 'supabase-callback-allow-list'
    | 'bot-diagnostics'
    | 'valkey-private-url'
    | 'lavalink-private-url';
  label: string;
  status: VpsHealthCheckStatus;
  summary: string;
  detail: string;
  manualAction?: boolean;
  diagnostics: Record<string, string>;
}

export interface VpsHealthVerification {
  status: VpsHealthVerificationStatus;
  blockedReasons: string[];
  checks: VpsHealthCheck[];
  redactedDiagnostics: Record<string, Record<string, string>>;
}

const DEFAULT_PENDING_DETAIL = 'This check is modeled only. Run the approved smoke step and feed the result back into the launcher.';

function redactDiagnosticValue(value: unknown): string {
  return String(value ?? '')
    .replace(/(DISCORD_TOKEN|DISCORD_CLIENT_SECRET|SUPABASE_SECRET_KEY|PAYPAL_CLIENT_SECRET|PAYPAL_WEBHOOK_ID|VALKEY_PASSWORD|LAVALINK_PASSWORD|NEXTAUTH_SECRET|CSRF_SECRET|WEBHOOK_REPLAY_SECRET)=([^\s,;]+)/gi, '$1=[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/sb_secret_[A-Za-z0-9._-]+/g, '[redacted-supabase-secret]')
    .replace(/(redis:\/\/:)[^@]+(@)/gi, '$1[redacted]$2')
    .replace(/MTI[A-Za-z0-9._-]{10,}/g, '[redacted-discord-token]');
}

function redactedDiagnostics(diagnostics: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(diagnostics)
      .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
      .map(([key, value]) => [key, redactDiagnosticValue(value)]),
  );
}

function check(input: Omit<VpsHealthCheck, 'diagnostics'> & {
  diagnostics?: Record<string, unknown>;
}): VpsHealthCheck {
  return {
    ...input,
    summary: redactDiagnosticValue(input.summary),
    detail: redactDiagnosticValue(input.detail),
    diagnostics: redactedDiagnostics(input.diagnostics ?? {}),
  };
}

function checkFromProbe(
  id: Extract<VpsHealthCheck['id'], 'https-dashboard' | 'api-health'>,
  label: string,
  endpoint: string,
  probe: VpsHealthProbeResult | undefined,
  successSummary: string,
): VpsHealthCheck {
  const state = probe?.state ?? 'pending';

  if (state === 'running') {
    return check({
      id,
      label,
      status: 'running',
      summary: `${label} check is running.`,
      detail: 'Waiting for the probe result.',
      diagnostics: { endpoint, elapsedMs: probe?.elapsedMs },
    });
  }

  if (state === 'timeout') {
    return check({
      id,
      label,
      status: 'fail',
      summary: `${label} timed out.`,
      detail: 'The health model did not receive a response before the timeout boundary.',
      diagnostics: { endpoint, elapsedMs: probe?.elapsedMs, error: probe?.error },
    });
  }

  if (state === 'failure') {
    return check({
      id,
      label,
      status: 'fail',
      summary: `${label} failed.`,
      detail: probe?.error ?? 'The probe reported a failure.',
      diagnostics: { endpoint, httpStatus: probe?.httpStatus, error: probe?.error },
    });
  }

  if (state === 'success') {
    const ok = probe?.httpStatus === undefined || (probe.httpStatus >= 200 && probe.httpStatus < 300);
    return check({
      id,
      label,
      status: ok ? 'pass' : 'fail',
      summary: ok ? successSummary : `${label} returned a non-2xx response.`,
      detail: ok ? 'The modeled probe response is acceptable.' : 'Investigate the public dashboard/reverse proxy before continuing.',
      diagnostics: {
        endpoint,
        httpStatus: probe?.httpStatus,
        healthStatus: probe?.response?.status,
        config: probe?.response?.services?.config,
      },
    });
  }

  return check({
    id,
    label,
    status: 'pending',
    summary: `${label} has not run yet.`,
    detail: DEFAULT_PENDING_DETAIL,
    diagnostics: { endpoint },
  });
}

function supabaseCallbackCheck(signal: VpsManualHealthSignal | undefined, expectedCallbackUrl: string): VpsHealthCheck {
  if (!signal?.status || signal.status === 'manual') {
    return check({
      id: 'supabase-callback-allow-list',
      label: 'Supabase callback allow-list',
      status: 'manual',
      summary: 'Supabase callback allow-list needs manual/provider confirmation.',
      detail: 'Confirm the Discord auth callback URL is present in the Supabase redirect allow list.',
      manualAction: true,
      diagnostics: { expectedCallbackUrl },
    });
  }

  if (signal.status === 'pass') {
    return check({
      id: 'supabase-callback-allow-list',
      label: 'Supabase callback allow-list',
      status: 'pass',
      summary: 'Supabase callback allow-list is ready.',
      detail: signal.detail ?? 'The expected callback URL is present.',
      diagnostics: { expectedCallbackUrl },
    });
  }

  if (signal.status === 'fail') {
    return check({
      id: 'supabase-callback-allow-list',
      label: 'Supabase callback allow-list',
      status: 'fail',
      summary: 'Supabase callback allow-list is missing required URLs.',
      detail: signal.detail ?? 'Update Supabase auth redirect URLs before testing Discord login.',
      diagnostics: {
        expectedCallbackUrl,
        missingCallbackUrls: signal.missingCallbackUrls?.join(', '),
      },
    });
  }

  return check({
    id: 'supabase-callback-allow-list',
    label: 'Supabase callback allow-list',
    status: signal.status,
    summary: 'Supabase callback allow-list check is not complete.',
    detail: signal.detail ?? DEFAULT_PENDING_DETAIL,
    diagnostics: { expectedCallbackUrl },
  });
}

function botDiagnosticsCheck(apiHealthProbe: VpsHealthProbeResult | undefined): VpsHealthCheck {
  const botStatus = apiHealthProbe?.response?.services?.bot;

  if (apiHealthProbe?.state === 'running') {
    return check({
      id: 'bot-diagnostics',
      label: 'Bot diagnostics',
      status: 'running',
      summary: 'Waiting for dashboard health response.',
      detail: 'Bot heartbeat is read from /api/health after Valkey responds.',
    });
  }

  if (botStatus === 'online') {
    return check({
      id: 'bot-diagnostics',
      label: 'Bot diagnostics',
      status: 'pass',
      summary: 'Bot heartbeat is online.',
      detail: 'Dashboard health reports a fresh bot heartbeat.',
      diagnostics: { botStatus },
    });
  }

  if (botStatus === 'offline') {
    return check({
      id: 'bot-diagnostics',
      label: 'Bot diagnostics',
      status: 'fail',
      summary: 'Bot heartbeat is offline.',
      detail: 'Dashboard health reports the bot heartbeat as offline or stale.',
      diagnostics: { botStatus },
    });
  }

  return check({
    id: 'bot-diagnostics',
    label: 'Bot diagnostics',
    status: apiHealthProbe?.state === 'success' ? 'manual' : 'pending',
    summary: 'Bot heartbeat needs confirmation.',
    detail: 'The dashboard health response did not prove the bot is online.',
    manualAction: apiHealthProbe?.state === 'success',
    diagnostics: { botStatus: botStatus ?? 'unknown' },
  });
}

function valkeyCheck(apiHealthProbe: VpsHealthProbeResult | undefined): VpsHealthCheck {
  const valkeyStatus = apiHealthProbe?.response?.services?.valkey;
  const privateUrl = 'redis://:<VALKEY_PASSWORD>@valkey:6379';

  if (valkeyStatus === 'connected') {
    return check({
      id: 'valkey-private-url',
      label: 'Valkey private URL',
      status: 'pass',
      summary: 'Valkey is connected through the private Docker URL.',
      detail: 'Dashboard health reports Valkey connected.',
      diagnostics: { privateUrl, valkeyStatus },
    });
  }

  if (valkeyStatus === 'fallback') {
    return check({
      id: 'valkey-private-url',
      label: 'Valkey private URL',
      status: 'fail',
      summary: 'Valkey is not connected.',
      detail: 'Dashboard health fell back instead of using the private Valkey service.',
      diagnostics: { privateUrl, valkeyStatus },
    });
  }

  return check({
    id: 'valkey-private-url',
    label: 'Valkey private URL',
    status: apiHealthProbe?.state === 'running' ? 'running' : 'pending',
    summary: 'Valkey private URL has not been verified yet.',
    detail: DEFAULT_PENDING_DETAIL,
    diagnostics: { privateUrl, valkeyStatus: valkeyStatus ?? 'unknown' },
  });
}

function lavalinkCheck(signal: VpsManualHealthSignal | undefined): VpsHealthCheck {
  const endpoint = 'http://lavalink:2333';
  const status = signal?.status ?? 'manual';

  if (status === 'pass') {
    return check({
      id: 'lavalink-private-url',
      label: 'Lavalink private URL',
      status: 'pass',
      summary: 'Lavalink private URL is ready.',
      detail: signal?.detail ?? 'The private Lavalink service endpoint is reachable from the stack.',
      diagnostics: { endpoint },
    });
  }

  if (status === 'fail') {
    return check({
      id: 'lavalink-private-url',
      label: 'Lavalink private URL',
      status: 'fail',
      summary: 'Lavalink private URL failed verification.',
      detail: signal?.detail ?? 'Check the lavalink service, password, and Docker network before enabling music.',
      diagnostics: { endpoint },
    });
  }

  return check({
    id: 'lavalink-private-url',
    label: 'Lavalink private URL',
    status,
    summary: status === 'running' ? 'Lavalink verification is running.' : 'Lavalink private URL needs manual confirmation.',
    detail: signal?.detail ?? 'Confirm the private Lavalink service endpoint from inside the VPS stack.',
    manualAction: status === 'manual',
    diagnostics: { endpoint },
  });
}

function aggregateStatus(blockedReasons: string[], checks: VpsHealthCheck[]): VpsHealthVerificationStatus {
  if (blockedReasons.length > 0) return 'blocked';
  if (checks.some(item => item.status === 'fail')) return 'fail';
  if (checks.some(item => item.status === 'running')) return 'running';
  if (checks.some(item => item.status === 'pending')) return 'pending';
  if (checks.some(item => item.status === 'manual')) return 'manual';
  return 'pass';
}

export function buildVpsHealthVerification(input: VpsHealthVerificationInput = {}): VpsHealthVerification {
  const deploymentPlan = buildVpsDeploymentPlan(input);
  const target = deploymentPlan.target;
  const publicBaseUrl = target?.publicBaseUrl ?? '';
  const checks: VpsHealthCheck[] = [
    checkFromProbe(
      'https-dashboard',
      'HTTPS dashboard',
      publicBaseUrl,
      input.httpsDashboardProbe,
      'HTTPS dashboard responded.',
    ),
    checkFromProbe(
      'api-health',
      '/api/health',
      publicBaseUrl ? `${publicBaseUrl}/api/health` : '',
      input.apiHealthProbe,
      '/api/health returned monitor-safe JSON.',
    ),
    supabaseCallbackCheck(input.supabaseCallbackAllowList, target ? `${target.publicBaseUrl}/api/auth/callback` : ''),
    botDiagnosticsCheck(input.apiHealthProbe),
    valkeyCheck(input.apiHealthProbe),
    lavalinkCheck(input.lavalink),
  ];

  return {
    status: aggregateStatus(deploymentPlan.blockedReasons, checks),
    blockedReasons: deploymentPlan.blockedReasons,
    checks,
    redactedDiagnostics: Object.fromEntries(checks.map(item => [item.id, item.diagnostics])),
  };
}
