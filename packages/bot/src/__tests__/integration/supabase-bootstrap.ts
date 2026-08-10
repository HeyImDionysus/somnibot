import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Values emitted by `supabase status --output env`. */
export interface SupabaseStatusEnv {
  API_URL: string;
  DB_URL: string;
  ANON_KEY: string;
  SECRET_KEY?: string;
  SERVICE_ROLE_KEY?: string;
  JWT_SECRET: string;
}

const REQUIRED_STATUS_KEYS = [
  'API_URL',
  'DB_URL',
  'ANON_KEY',
  'JWT_SECRET',
] as const;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const AUTHENTICATED_SUBJECT = '00000000-0000-0000-0000-000000000000';
const AUTHENTICATED_TOKEN_TTL_SECONDS = 5 * 60;

/** Parse shell-style KEY=value lines without logging or persisting values. */
export function parseSupabaseStatusEnv(output: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

function requireStatusValues(parsed: Record<string, string>): SupabaseStatusEnv {
  const missing: string[] = REQUIRED_STATUS_KEYS.filter((key) => !parsed[key]);
  if (!parsed.SECRET_KEY && !parsed.SERVICE_ROLE_KEY) missing.push('SECRET_KEY (or SERVICE_ROLE_KEY)');
  if (missing.length > 0) {
    throw new Error(`Supabase CLI status is missing required fields: ${missing.join(', ')}`);
  }
  return parsed as unknown as SupabaseStatusEnv;
}

/** Require an API/DB URL to remain on the local loopback interface. */
export function assertLoopbackUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Supabase CLI status returned an invalid ${name}`);
  }
  if (!['http:', 'https:', 'postgres:', 'postgresql:'].includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`Supabase CLI status returned a non-loopback ${name}`);
  }
  return value;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Mint a short-lived HS256 token for PostgREST's authenticated role. */
export function createAuthenticatedJwt(jwtSecret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!jwtSecret) throw new Error('Supabase CLI status returned an empty JWT_SECRET');
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = base64UrlJson({
    // The local CLI's GoTrue instance uses this issuer (the same value in
    // the generated ANON_KEY/SERVICE_ROLE_KEY payloads).
    iss: 'supabase-demo',
    role: 'authenticated',
    aud: 'authenticated',
    sub: AUTHENTICATED_SUBJECT,
    iat: nowSeconds,
    exp: nowSeconds + AUTHENTICATED_TOKEN_TTL_SECONDS,
  });
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', jwtSecret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

/** Build the process environment consumed by integration helpers and clients. */
export function buildSupabaseTestEnvironment(status: SupabaseStatusEnv, nowSeconds?: number): Record<string, string> {
  const apiUrl = assertLoopbackUrl(status.API_URL, 'API_URL');
  const dbUrl = assertLoopbackUrl(status.DB_URL, 'DB_URL');
  const secretKey = status.SECRET_KEY || status.SERVICE_ROLE_KEY;
  if (!secretKey) throw new Error('Supabase CLI status returned no SECRET_KEY');
  return {
    SUPABASE_URL: apiUrl,
    SUPABASE_API_URL: apiUrl,
    SUPABASE_DB_URL: dbUrl,
    DATABASE_URL: dbUrl,
    SUPABASE_ANON_KEY: status.ANON_KEY,
    SUPABASE_SECRET_KEY: secretKey,
    // Keep the legacy alias available for older helpers while making the
    // canonical launcher key authoritative.
    SUPABASE_SERVICE_ROLE_KEY: secretKey,
    SUPABASE_JWT_SECRET: status.JWT_SECRET,
    SUPABASE_AUTHENTICATED_JWT: createAuthenticatedJwt(status.JWT_SECRET, nowSeconds),
  };
}

export function buildSupabaseCliInvocation(repoRoot: string, supabaseWorkdir: string): { command: string; args: string[] } {
  const cliScript = resolve(repoRoot, 'node_modules', 'supabase', 'dist', 'supabase.js');
  return {
    command: process.execPath,
    args: [cliScript, 'status', '--workdir', supabaseWorkdir, '--output', 'env'],
  };
}

function runStatus(invocation: { command: string; args: string[] }, cwd: string): string {
  return execFileSync(invocation.command, invocation.args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

/**
 * Discover the running local CLI project and install its credentials in
 * process.env before Vitest imports any integration test module.
 */
export function bootstrapLocalSupabase(repoRoot = fileURLToPath(new URL('../../../../..', import.meta.url))): void {
  const supabaseWorkdir = resolve(repoRoot, 'packages');
  const invocation = buildSupabaseCliInvocation(repoRoot, supabaseWorkdir);
  if (!existsSync(invocation.args[0])) {
    throw new Error(`Local Supabase CLI status is unavailable for project ${supabaseWorkdir}; install the repository Supabase CLI before running integration tests`);
  }
  let output: string | undefined;
  try {
    output = runStatus(invocation, repoRoot);
  } catch {
    throw new Error(`Local Supabase CLI status is unavailable for project ${supabaseWorkdir}; start the packages project before running integration tests`);
  }
  const status = requireStatusValues(parseSupabaseStatusEnv(output));
  for (const [key, value] of Object.entries(buildSupabaseTestEnvironment(status))) {
    process.env[key] = value;
  }
}
