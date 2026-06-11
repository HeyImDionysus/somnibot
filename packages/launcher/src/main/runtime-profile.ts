export const REGULAR_LOCAL_DASHBOARD_PORT = 3456;
export const REGULAR_LOCAL_DASHBOARD_HOSTNAME = '127.0.0.1';
export const REGULAR_LOCAL_OPERATOR_DASHBOARD_URL = `http://localhost:${REGULAR_LOCAL_DASHBOARD_PORT}`;

export const VPS_DASHBOARD_PORT = 3000;
export const VPS_DASHBOARD_HOSTNAME = '0.0.0.0';
export const VPS_FALLBACK_OPERATOR_DASHBOARD_URL = `http://localhost:${VPS_DASHBOARD_PORT}`;

export type RuntimeMode = 'regular-local' | 'vps';

export interface RuntimeNetworkingConfig {
  runtimeMode?: RuntimeMode | string;
  publicCallbackBaseUrl?: string;
  vpsDomain?: string;
  vpsSshHost?: string;
  vpsSshUser?: string;
  vpsDeployPath?: string;
}

export interface RuntimeProfile {
  runtimeMode: RuntimeMode;
  operatorDashboardUrl: string;
  publicCallbackBaseUrl: string;
  authCallbackUrl: string;
  paypalWebhookUrl: string;
  dashboardPort: string;
  dashboardHostname: string;
  lavalinkHost: string;
  lavalinkPort: string;
  valkeyUrl: string;
}

export interface RuntimeValidationOptions {
  allowLocalTesting?: boolean;
}

export function normalizeRuntimeMode(value: unknown): RuntimeMode {
  return value === 'vps' ? 'vps' : 'regular-local';
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function isLocalHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(hostname);
}

export function normalizeBaseUrl(
  value: string | undefined,
  options: { addHttpsForBareDomain?: boolean } = {},
): string {
  const trimmed = value?.trim();
  if (!trimmed) return '';

  const candidate = options.addHttpsForBareDomain && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? `https://${trimmed}`
    : trimmed;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.pathname = stripTrailingSlashes(parsed.pathname);
    if (parsed.pathname === '') parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return stripTrailingSlashes(parsed.toString());
  } catch {
    return '';
  }
}

export function normalizeVpsDomain(value: string | undefined): string {
  return normalizeBaseUrl(value, { addHttpsForBareDomain: true });
}

export function getProviderCallbackUrls(publicCallbackBaseUrl: string): {
  authCallbackUrl: string;
  paypalWebhookUrl: string;
} {
  const base = stripTrailingSlashes(publicCallbackBaseUrl);
  if (!base) {
    return {
      authCallbackUrl: '',
      paypalWebhookUrl: '',
    };
  }
  return {
    authCallbackUrl: `${base}/api/auth/callback`,
    paypalWebhookUrl: `${base}/api/paypal/webhook`,
  };
}

export function validatePublicCallbackBaseUrl(
  value: string,
  options: RuntimeValidationOptions = {},
): string[] {
  const errors: string[] = [];
  const normalized = normalizeBaseUrl(value);
  if (!normalized) {
    return ['Public callback URL must be a valid HTTP or HTTPS URL.'];
  }

  const parsed = new URL(normalized);
  const local = isLocalHostname(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(options.allowLocalTesting && local)) {
    errors.push('Public callback URL must use HTTPS unless local testing is explicitly allowed.');
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    errors.push('Public callback URL must be the dashboard base URL, not a nested path.');
  }
  return errors;
}

export function validateRuntimeNetworkingConfig(
  config: RuntimeNetworkingConfig,
  options: RuntimeValidationOptions = {},
): string[] {
  const mode = normalizeRuntimeMode(config.runtimeMode);
  const errors: string[] = [];

  if (mode === 'regular-local') {
    if (config.publicCallbackBaseUrl?.trim()) {
      errors.push(...validatePublicCallbackBaseUrl(config.publicCallbackBaseUrl, {
        allowLocalTesting: options.allowLocalTesting,
      }));
    }
    return errors;
  }

  const vpsBase = normalizeVpsDomain(config.vpsDomain || config.publicCallbackBaseUrl);
  if (!vpsBase) {
    errors.push('VPS mode needs a public HTTPS domain before setup can finalize.');
    return errors;
  }

  errors.push(...validatePublicCallbackBaseUrl(vpsBase, { allowLocalTesting: false }));
  const parsed = new URL(vpsBase);
  if (isLocalHostname(parsed.hostname)) {
    errors.push('VPS mode cannot use a localhost callback URL.');
  }
  return errors;
}

export function resolveRuntimeProfile(config: RuntimeNetworkingConfig): RuntimeProfile {
  const runtimeMode = normalizeRuntimeMode(config.runtimeMode);
  const validationErrors = validateRuntimeNetworkingConfig(config);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join('\n'));
  }

  if (runtimeMode === 'vps') {
    const publicCallbackBaseUrl = normalizeVpsDomain(config.vpsDomain || config.publicCallbackBaseUrl)
      || '';
    const callbacks = getProviderCallbackUrls(publicCallbackBaseUrl);

    return {
      runtimeMode,
      operatorDashboardUrl: publicCallbackBaseUrl || VPS_FALLBACK_OPERATOR_DASHBOARD_URL,
      publicCallbackBaseUrl,
      dashboardPort: String(VPS_DASHBOARD_PORT),
      dashboardHostname: VPS_DASHBOARD_HOSTNAME,
      lavalinkHost: 'lavalink',
      lavalinkPort: '2333',
      valkeyUrl: 'redis://valkey:6379',
      ...callbacks,
    };
  }

  const publicCallbackBaseUrl = normalizeBaseUrl(config.publicCallbackBaseUrl)
    || REGULAR_LOCAL_OPERATOR_DASHBOARD_URL;
  const callbacks = getProviderCallbackUrls(publicCallbackBaseUrl);

  return {
    runtimeMode,
    operatorDashboardUrl: REGULAR_LOCAL_OPERATOR_DASHBOARD_URL,
    publicCallbackBaseUrl,
    dashboardPort: String(REGULAR_LOCAL_DASHBOARD_PORT),
    dashboardHostname: REGULAR_LOCAL_DASHBOARD_HOSTNAME,
    lavalinkHost: 'localhost',
    lavalinkPort: '2333',
    valkeyUrl: 'redis://127.0.0.1:6379',
    ...callbacks,
  };
}

export function buildRuntimeEnvVars(config: RuntimeNetworkingConfig): Record<string, string> {
  const profile = resolveRuntimeProfile(config);
  return {
    SOMNIBOT_RUNTIME_MODE: profile.runtimeMode,
    SOMNIBOT_PUBLIC_CALLBACK_REQUIRED: 'true',
    SOMNIBOT_PUBLIC_CALLBACK_BASE_URL: profile.publicCallbackBaseUrl,
    DASHBOARD_URL: profile.operatorDashboardUrl,
    NEXT_PUBLIC_APP_URL: profile.publicCallbackBaseUrl,
    PAYPAL_WEBHOOK_URL: profile.paypalWebhookUrl,
    PORT: profile.dashboardPort,
    HOSTNAME: profile.dashboardHostname,
    LAVALINK_HOST: profile.lavalinkHost,
    LAVALINK_PORT: profile.lavalinkPort,
    VALKEY_URL: profile.valkeyUrl,
  };
}

export function getLauncherLocalStartBlocker(config: RuntimeNetworkingConfig): string | null {
  const validationErrors = validateRuntimeNetworkingConfig(config);
  if (validationErrors.length > 0) {
    return validationErrors.join('\n');
  }

  if (normalizeRuntimeMode(config.runtimeMode) === 'vps') {
    return 'VPS mode uses the guided deployment setup path. Regular local start can only run the bot and dashboard on this machine.';
  }

  return null;
}
