import { validateSupabaseUrl } from './validators.js';

export type ActiveRuntimeMode = 'regular-local' | 'vps';

export interface RuntimeLeaseStatus {
  active: boolean;
  activeMode?: ActiveRuntimeMode;
  leaseExpiresAt?: string;
}

export class RuntimeLeaseStatusUnavailableError extends Error {
  constructor(readonly reason: 'not-installed' | 'unavailable', message: string) {
    super(message);
    this.name = 'RuntimeLeaseStatusUnavailableError';
  }
}

interface RuntimeLeaseRow {
  active?: unknown;
  active_mode?: unknown;
  lease_expires_at?: unknown;
}

function parseRuntimeLeaseStatus(payload: unknown): RuntimeLeaseStatus {
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (!row || typeof row !== 'object') {
    throw new Error('Supabase returned an invalid active-runtime response.');
  }

  const value = row as RuntimeLeaseRow;
  if (typeof value.active !== 'boolean') {
    throw new Error('Supabase returned an invalid active-runtime response.');
  }
  if (!value.active) return { active: false };
  if (value.active_mode !== 'regular-local' && value.active_mode !== 'vps') {
    throw new Error('Supabase returned an invalid active runtime mode.');
  }
  if (typeof value.lease_expires_at !== 'string' || Number.isNaN(Date.parse(value.lease_expires_at))) {
    throw new Error('Supabase returned an invalid active-runtime expiry.');
  }

  return {
    active: true,
    activeMode: value.active_mode,
    leaseExpiresAt: value.lease_expires_at,
  };
}

export async function readRuntimeLeaseStatus(
  supabaseUrl: string,
  supabaseSecretKey: string,
  options: { fetch?: typeof fetch } = {},
): Promise<RuntimeLeaseStatus> {
  const url = supabaseUrl.trim().replace(/\/+$/, '');
  const secretKey = supabaseSecretKey.trim();
  if (!url || !secretKey) {
    throw new Error('Supabase URL and secret key are required to check active runtime ownership.');
  }
  const urlValidation = validateSupabaseUrl(url);
  if (!urlValidation.ok) {
    throw new Error(urlValidation.error || 'Supabase URL is not trusted for active runtime ownership checks.');
  }
  const parsedUrl = new URL(url);
  const isSupabaseProject = parsedUrl.protocol === 'https:'
    && (parsedUrl.hostname.endsWith('.supabase.co') || parsedUrl.hostname.endsWith('.supabase.com'));
  if (!isSupabaseProject) {
    throw new Error('Active runtime ownership checks require an HTTPS Supabase project domain.');
  }

  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${url}/rest/v1/rpc/get_somnibot_runtime`, {
    method: 'POST',
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: unknown } | null;
    const notInstalled = response.status === 404 || body?.code === 'PGRST202';
    throw new RuntimeLeaseStatusUnavailableError(
      notInstalled ? 'not-installed' : 'unavailable',
      `Active runtime ownership check failed with HTTP ${response.status}.`,
    );
  }

  return parseRuntimeLeaseStatus(await response.json());
}

export async function waitForRuntimeLease(
  readStatus: () => Promise<RuntimeLeaseStatus>,
  predicate: (status: RuntimeLeaseStatus) => boolean,
  options: {
    wait?: (delayMs: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
    timeoutMessage?: string;
  } = {},
): Promise<RuntimeLeaseStatus> {
  const wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 55_000);

  while (true) {
    const status = await readStatus();
    if (predicate(status)) return status;
    if (now() >= deadline) {
      throw new Error(options.timeoutMessage || 'Runtime ownership did not reach the required state before the handoff deadline.');
    }
    await wait(500);
  }
}
