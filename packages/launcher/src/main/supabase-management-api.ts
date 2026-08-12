/**
 * Small, main-process-only client for the Supabase Management API.
 *
 * A personal/fine-grained Supabase token is a control-plane credential.  It
 * can enumerate projects and, when granted `api_gateway_keys_read`, retrieve
 * the project's publishable/secret API keys.  It cannot reveal an existing
 * Postgres password; that remains a separate direct-database credential.
 */

const MANAGEMENT_API_ORIGIN = 'https://api.supabase.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const PROJECT_REF_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface SupabaseProjectSummary {
  ref: string;
  name: string;
  region?: string;
  status?: string;
  url: string;
}

export interface SupabaseProjectCredentials {
  project: SupabaseProjectSummary;
  secretKey?: string;
  publishableKey?: string;
}

export interface SupabaseManagementError {
  ok: false;
  error: string;
  code?: number;
}

export type SupabaseManagementResult<T> = ({ ok: true } & T) | SupabaseManagementError;

interface ManagementApiOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

interface ManagementRequestOptions {
  method?: string;
  body?: unknown;
}

interface RawProject {
  id?: unknown;
  ref?: unknown;
  name?: unknown;
  region?: unknown;
  status?: unknown;
}

interface RawApiKey {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  api_key?: unknown;
  key?: unknown;
}

interface RawPoolerConfig {
  database_type?: unknown;
  db_user?: unknown;
  db_host?: unknown;
  db_port?: unknown;
  db_name?: unknown;
  pool_mode?: unknown;
}

function normalizedToken(token: string): string {
  return token.trim();
}

function projectRef(value: unknown): string | null {
  const ref = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PROJECT_REF_PATTERN.test(ref) ? ref : null;
}

function projectFromRaw(raw: RawProject): SupabaseProjectSummary | null {
  const ref = projectRef(raw.ref ?? raw.id);
  if (!ref) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : ref;
  const region = typeof raw.region === 'string' && raw.region.trim() ? raw.region.trim() : undefined;
  const status = typeof raw.status === 'string' && raw.status.trim() ? raw.status.trim() : undefined;
  return {
    ref,
    name,
    ...(region ? { region } : {}),
    ...(status ? { status } : {}),
    url: `https://${ref}.supabase.co`,
  };
}

function managementError(response: Response, action: string): SupabaseManagementError {
  const detail = response.status === 401 || response.status === 403
    ? 'The Supabase Management API token is missing the required permission or is not accepted.'
    : `Supabase Management API returned HTTP ${response.status} while ${action}.`;
  return { ok: false, error: detail, code: response.status };
}

async function requestJson<T>(
  token: string,
  path: string,
  action: string,
  options: ManagementApiOptions,
  request: ManagementRequestOptions = {},
): Promise<SupabaseManagementResult<{ data: T }>> {
  const normalized = normalizedToken(token);
  if (!normalized) return { ok: false, error: 'Enter a Supabase Management API token first.' };

  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? MANAGEMENT_API_ORIGIN;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...(request.method ? { method: request.method } : {}),
      headers: {
        Accept: 'application/json',
        ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${normalized}`,
      },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return managementError(response, action);
    return { ok: true, data: await response.json() as T };
  } catch (error) {
    return {
      ok: false,
      error: `Supabase Management API could not be reached while ${action}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** List projects visible to the supplied Management API token. */
export async function listSupabaseProjects(
  token: string,
  options: ManagementApiOptions = {},
): Promise<SupabaseManagementResult<{ projects: SupabaseProjectSummary[] }>> {
  const response = await requestJson<RawProject[]>(token, '/v1/projects', 'listing projects', options);
  if (!response.ok) return response;
  const projects = Array.isArray(response.data)
    ? response.data.map(projectFromRaw).filter((project): project is SupabaseProjectSummary => project !== null)
    : [];
  return { ok: true, projects };
}

function keyValue(raw: RawApiKey): string | undefined {
  const value = typeof raw.api_key === 'string' ? raw.api_key : raw.key;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function keyKind(raw: RawApiKey): 'secret' | 'publishable' | null {
  const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim().toLowerCase() : '';
  if (type === 'secret' || type === 'service_role' || name === 'service_role' || name === 'secret') return 'secret';
  if (type === 'publishable' || type === 'anon' || name === 'anon' || name === 'publishable') return 'publishable';
  return null;
}

function projectFromRef(ref: string): SupabaseProjectSummary {
  return { ref, name: ref, url: `https://${ref}.supabase.co` };
}

/**
 * Retrieve the project's API keys and normalize both current and legacy key
 * formats.  Values stay in the main process; callers should only expose the
 * readiness booleans to the renderer.
 */
export async function getSupabaseProjectCredentials(
  token: string,
  ref: string,
  options: ManagementApiOptions = {},
): Promise<SupabaseManagementResult<{ credentials: SupabaseProjectCredentials }>> {
  const normalizedRef = projectRef(ref);
  if (!normalizedRef) return { ok: false, error: 'Supabase project reference is invalid.' };

  const response = await requestJson<RawApiKey[]>(
    token,
    `/v1/projects/${encodeURIComponent(normalizedRef)}/api-keys?reveal=true`,
    'retrieving project API keys',
    options,
  );
  if (!response.ok) return response;

  const keys = Array.isArray(response.data) ? response.data : [];
  let secretKey: string | undefined;
  let publishableKey: string | undefined;
  for (const key of keys) {
    const value = keyValue(key);
    const kind = keyKind(key);
    if (!value || !kind) continue;
    if (kind === 'secret' && !secretKey) secretKey = value;
    if (kind === 'publishable' && !publishableKey) publishableKey = value;
  }

  return {
    ok: true,
    credentials: {
      project: projectFromRef(normalizedRef),
      ...(secretKey ? { secretKey } : {}),
      ...(publishableKey ? { publishableKey } : {}),
    },
  };
}

/**
 * Read the project's IPv4-capable Supavisor endpoint. The returned template
 * deliberately contains no password; the encrypted database password is
 * inserted only when a bot/VPS child environment is materialized.
 */
export async function getSupabaseSessionPoolerTemplate(
  token: string,
  ref: string,
  options: ManagementApiOptions = {},
): Promise<SupabaseManagementResult<{ connectionTemplate: string }>> {
  const normalizedRef = projectRef(ref);
  if (!normalizedRef) return { ok: false, error: 'Supabase project reference is invalid.' };

  const response = await requestJson<RawPoolerConfig[]>(
    token,
    `/v1/projects/${encodeURIComponent(normalizedRef)}/config/database/pooler`,
    'retrieving the project database connection endpoint',
    options,
  );
  if (!response.ok) return response;

  const rows = Array.isArray(response.data) ? response.data : [];
  const sessionRows = rows.filter((row) => (
    row.database_type === 'PRIMARY'
    && row.pool_mode === 'session'
    && Number(row.db_port) === 5432
  ));
  const transactionRows = rows.filter((row) => (
    row.database_type === 'PRIMARY'
    && row.pool_mode === 'transaction'
    && Number(row.db_port) === 6543
  ));
  // The Management API commonly returns only the primary transaction config.
  // Supabase documents the same shared Supavisor host on 5432 for session mode
  // and 6543 for transaction mode, so that trusted primary row is sufficient
  // to materialize the migration-safe session endpoint.
  if (sessionRows.length > 1 || (sessionRows.length === 0 && transactionRows.length !== 1)) {
    return { ok: false, error: 'Supabase did not return one unambiguous primary shared-pooler endpoint for this project.' };
  }
  const pooler = sessionRows[0] ?? transactionRows[0];
  const host = typeof pooler.db_host === 'string' ? pooler.db_host.trim().toLowerCase() : '';
  const rawUser = typeof pooler.db_user === 'string' ? pooler.db_user.trim() : '';
  const database = typeof pooler.db_name === 'string' && pooler.db_name.trim()
    ? pooler.db_name.trim()
    : 'postgres';
  if (!/^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(host)) {
    return { ok: false, error: 'Supabase did not return a trusted session-pooler host for this project.' };
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(rawUser) || !/^[a-zA-Z0-9_-]+$/.test(database)) {
    return { ok: false, error: 'Supabase returned invalid session-pooler connection metadata.' };
  }

  const user = rawUser.includes('.') ? rawUser : `${rawUser}.${normalizedRef}`;
  return {
    ok: true,
    connectionTemplate: `postgresql://${encodeURIComponent(user)}@${host}:5432/${encodeURIComponent(database)}`,
  };
}

/**
 * Rotate the selected project's database password after an explicit operator
 * action. Supabase never returns the old password; the caller supplies the
 * newly generated value and receives only success/readiness metadata back.
 */
export async function updateSupabaseDatabasePassword(
  token: string,
  ref: string,
  password: string,
  options: ManagementApiOptions = {},
): Promise<SupabaseManagementResult<{ updated: true }>> {
  const normalizedRef = projectRef(ref);
  if (!normalizedRef) return { ok: false, error: 'Supabase project reference is invalid.' };

  const normalizedPassword = password.trim();
  if (normalizedPassword.length < 16 || normalizedPassword.length > 128 || /[\r\n]/.test(normalizedPassword)) {
    return { ok: false, error: 'Generated Supabase database password did not meet the safety requirements.' };
  }

  const response = await requestJson<{ message?: string }>(
    token,
    `/v1/projects/${encodeURIComponent(normalizedRef)}/database/password`,
    'updating the database password',
    options,
    { method: 'PATCH', body: { password: normalizedPassword } },
  );
  if (!response.ok) return response;
  return { ok: true, updated: true };
}

export const __private__ = { keyKind, projectFromRaw, projectRef };
