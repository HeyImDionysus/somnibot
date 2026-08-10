/**
 * Resolve credentials emitted by the local Supabase CLI without echoing them.
 *
 * `supabase status --output env` is the source of truth after every local
 * start.  The helper intentionally captures stdout in memory and exposes the
 * values only through the returned object, process.env, or GITHUB_ENV.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CWD = path.join(ROOT, 'packages');
const SUPABASE_CLI_ENTRYPOINT = path.join(ROOT, 'node_modules', 'supabase', 'dist', 'supabase.js');

/** Parse the shell-style output produced by `supabase status --output env`. */
export function parseSupabaseStatusEnv(output) {
  const values = {};
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Read the current local Supabase status.  Errors intentionally do not include
 * captured stdout/stderr, since either stream may contain credentials.
 */
export function readLocalSupabaseStatus({ cwd = DEFAULT_CWD, exec = execFileSync } = {}) {
  try {
    const output = exec(process.execPath, [SUPABASE_CLI_ENTRYPOINT, 'status', '--output', 'env'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const values = parseSupabaseStatusEnv(output);
    const anonKey = nonEmpty(values.ANON_KEY) || nonEmpty(values.PUBLISHABLE_KEY);
    const publishableKey = nonEmpty(values.PUBLISHABLE_KEY) || anonKey;
    const serviceKey = nonEmpty(values.SERVICE_ROLE_KEY) || nonEmpty(values.SECRET_KEY);
    return {
      url: nonEmpty(values.API_URL) || nonEmpty(values.SUPABASE_URL) || DEFAULT_LOCAL_SUPABASE_URL,
      anonKey,
      publishableKey,
      serviceKey,
      source: 'supabase status',
    };
  } catch {
    return {
      url: DEFAULT_LOCAL_SUPABASE_URL,
      source: 'unavailable',
    };
  }
}

/**
 * Resolve status values, allowing explicitly supplied environment values only
 * when status is unavailable (useful for a caller that already bootstrapped).
 * CI uses `requireStatus` so stale values cannot silently become proof.
 */
export function resolveLocalSupabaseEnv({ env = process.env, cwd = DEFAULT_CWD, requireStatus = false } = {}) {
  const status = readLocalSupabaseStatus({ cwd });
  const fromEnv = {
    url: nonEmpty(env.SUPABASE_URL) || nonEmpty(env.NEXT_PUBLIC_SUPABASE_URL),
    anonKey: nonEmpty(env.SUPABASE_ANON_KEY),
    publishableKey: nonEmpty(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) || nonEmpty(env.SUPABASE_PUBLISHABLE_KEY),
    serviceKey: nonEmpty(env.SUPABASE_SECRET_KEY) || nonEmpty(env.SUPABASE_SERVICE_ROLE_KEY),
  };
  const result = {
    url: status.source === 'supabase status' ? status.url : (fromEnv.url || status.url),
    anonKey: status.anonKey || (requireStatus ? undefined : fromEnv.anonKey),
    publishableKey: status.publishableKey || (requireStatus ? undefined : fromEnv.publishableKey || fromEnv.anonKey),
    serviceKey: status.serviceKey || (requireStatus ? undefined : fromEnv.serviceKey),
    source: status.source,
  };
  if (!result.anonKey && result.publishableKey) result.anonKey = result.publishableKey;
  if (!result.publishableKey && result.anonKey) result.publishableKey = result.anonKey;
  if (requireStatus && (!result.url || !result.anonKey || !result.publishableKey || !result.serviceKey)) {
    throw new Error('Local Supabase status did not provide API_URL, anon/publishable key, and service key');
  }
  return result;
}

/** Apply resolved values to a mutable environment object without logging them. */
export function applyLocalSupabaseEnv({ env = process.env, cwd = DEFAULT_CWD, requireStatus = false } = {}) {
  const resolved = resolveLocalSupabaseEnv({ env, cwd, requireStatus });
  if (resolved.url) {
    env.SUPABASE_URL = resolved.url;
    env.NEXT_PUBLIC_SUPABASE_URL = resolved.url;
  }
  if (resolved.anonKey) env.SUPABASE_ANON_KEY = resolved.anonKey;
  if (resolved.publishableKey) {
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = resolved.publishableKey;
    env.SUPABASE_PUBLISHABLE_KEY = resolved.publishableKey;
  }
  if (resolved.serviceKey) {
    env.SUPABASE_SECRET_KEY = resolved.serviceKey;
    env.SUPABASE_SERVICE_ROLE_KEY = resolved.serviceKey;
  }
  return resolved;
}

/** Write resolved values to GitHub's per-step environment file. */
export function writeGitHubEnv({ env = process.env, cwd = DEFAULT_CWD } = {}) {
  const resolved = applyLocalSupabaseEnv({ env: {}, cwd, requireStatus: true });
  const destination = nonEmpty(env.GITHUB_ENV);
  if (!destination) throw new Error('GITHUB_ENV is not set');
  const lines = [
    `SUPABASE_URL=${resolved.url}`,
    `NEXT_PUBLIC_SUPABASE_URL=${resolved.url}`,
    `SUPABASE_ANON_KEY=${resolved.anonKey}`,
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${resolved.publishableKey}`,
    `SUPABASE_PUBLISHABLE_KEY=${resolved.publishableKey}`,
    `SUPABASE_SECRET_KEY=${resolved.serviceKey}`,
    `SUPABASE_SERVICE_ROLE_KEY=${resolved.serviceKey}`,
  ];
  appendFileSync(destination, `${lines.join('\n')}\n`, { encoding: 'utf8' });
  return resolved;
}

if (process.argv.includes('--github-env')) {
  try {
    writeGitHubEnv();
    console.log('Local Supabase credentials exported from supabase status (values withheld).');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Local Supabase bootstrap failed');
    process.exitCode = 1;
  }
}
