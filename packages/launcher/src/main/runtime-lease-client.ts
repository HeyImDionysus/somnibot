import { validateSupabaseUrl } from './validators.js';

export type ActiveRuntimeMode = 'regular-local' | 'vps';

export interface RuntimeLeaseStatus {
  active: boolean;
  activeMode?: ActiveRuntimeMode;
  leaseExpiresAt?: string;
}

/**
 * An active regular-local lease with a managed local stack requires an
 * orderly local stop before waiting for the database lease to clear. This
 * does not claim lease ownership; the subsequent inactive read remains the
 * fail-closed authority for both same-launcher and foreign leases.
 */
export function shouldStopManagedLocalStackBeforeLeaseWait(
  status: RuntimeLeaseStatus,
  localStackRunning: boolean,
): boolean {
  return status.active && status.activeMode === 'regular-local' && localStackRunning;
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

export function canonicalSupabaseProjectOrigin(supabaseUrl: string): string {
  const url = supabaseUrl.trim();
  const urlValidation = validateSupabaseUrl(url);
  if (!urlValidation.ok) {
    throw new Error(urlValidation.error || 'Supabase URL is not trusted for active runtime ownership checks.');
  }

  const parsedUrl = new URL(url);
  const isSupabaseProject = parsedUrl.protocol === 'https:'
    && (parsedUrl.hostname.endsWith('.supabase.co') || parsedUrl.hostname.endsWith('.supabase.com'));
  const isCanonicalOrigin = !parsedUrl.username
    && !parsedUrl.password
    && !parsedUrl.port
    && parsedUrl.pathname === '/'
    && !parsedUrl.search
    && !parsedUrl.hash;
  if (!isSupabaseProject || !isCanonicalOrigin) {
    throw new Error('Active runtime ownership checks require a canonical HTTPS Supabase project origin.');
  }
  return parsedUrl.origin;
}

export function validateSupabaseCredentialPairing(
  savedSupabaseUrl: string,
  patch: { supabaseUrl?: string; supabaseSecretKey?: string },
): string | undefined {
  if (typeof patch.supabaseUrl !== 'string') return undefined;

  const nextSupabaseUrl = patch.supabaseUrl.trim();
  const nextSecretKey = typeof patch.supabaseSecretKey === 'string'
    ? patch.supabaseSecretKey.trim()
    : '';

  // A fresh launcher autosaves its still-empty form while the owner is
  // entering credentials. Preserve that first-run flow, but never allow a
  // service key to be persisted without the project it belongs to.
  if (!nextSupabaseUrl) {
    return nextSecretKey ? 'Supabase URL is required when setting a Supabase secret key.' : undefined;
  }

  const nextOrigin = canonicalSupabaseProjectOrigin(nextSupabaseUrl);
  let savedOrigin = '';
  if (savedSupabaseUrl.trim()) {
    try {
      savedOrigin = canonicalSupabaseProjectOrigin(savedSupabaseUrl);
    } catch {
      // An invalid legacy URL is never considered the same credential target.
    }
  }
  if (nextOrigin === savedOrigin) return undefined;
  if (nextSecretKey) return undefined;
  return 'Changing the Supabase project requires its matching secret key.';
}

export function hasSupabaseProjectOriginChanged(savedSupabaseUrl: string, nextSupabaseUrl: string): boolean {
  const nextUrl = nextSupabaseUrl.trim();
  if (!nextUrl) return savedSupabaseUrl.trim().length > 0;

  const nextOrigin = canonicalSupabaseProjectOrigin(nextUrl);
  if (!savedSupabaseUrl.trim()) return true;
  try {
    return canonicalSupabaseProjectOrigin(savedSupabaseUrl) !== nextOrigin;
  } catch {
    return true;
  }
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
  const projectOrigin = canonicalSupabaseProjectOrigin(url);

  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${projectOrigin}/rest/v1/rpc/get_somnibot_runtime`, {
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
