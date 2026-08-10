/** Resolve credentials for the disposable local Supabase test rig.
 *
 * This module deliberately has no fallback/demo credentials.  A local stack
 * owns its keys; the CLI is the source of truth when an isolated shard does
 * not provide explicit E2E overrides.  Ambient SUPABASE_* variables are never
 * consulted (or passed to the CLI), because they may belong to a customer or
 * production installation.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertSupabaseUrlIsLocal } from './guard.js';

export interface LocalSupabaseCredentials {
  url: string;
  serviceRoleKey: string;
  anonKey: string;
  source: 'override' | 'cli';
}

export interface LocalSupabaseEnv {
  SOMNIBOT_E2E_SUPABASE_URL?: string;
  SOMNIBOT_E2E_SUPABASE_SERVICE_ROLE_KEY?: string;
  SOMNIBOT_E2E_SUPABASE_ANON_KEY?: string;
  [key: string]: string | undefined;
}

export interface SupabaseStatusResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
}

export type SupabaseStatusRunner = (options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => SupabaseStatusResult;

const DEFAULT_LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, '..');
const SUPABASE_CLI_ENTRY = path.join(REPOSITORY_ROOT, 'node_modules', 'supabase', 'dist', 'supabase.js');

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function defaultStatusRunner({ command, args, cwd, env }: Parameters<SupabaseStatusRunner>[0]): SupabaseStatusResult {
  try {
    const result = spawnSync(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
  } catch {
    // Do not expose spawn errors: some platforms include command lines or
    // inherited environment values in their text.
    return { status: null };
  }
}

function cliEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The status command is local and does not need Supabase auth.  Removing all
  // SUPABASE_* names also prevents the CLI from accidentally selecting a remote
  // project or printing/using a customer token.
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !/^SUPABASE_/i.test(name)),
  );
}

function statusField(status: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = status[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function parseCliStatus(stdout: string): LocalSupabaseCredentials | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const url = statusField(record, 'API_URL', 'api_url', 'SUPABASE_URL', 'supabase_url');
  const serviceRoleKey = statusField(
    record,
    'SERVICE_ROLE_KEY',
    'service_role_key',
    'SUPABASE_SERVICE_ROLE_KEY',
    'supabase_service_role_key',
  );
  const anonKey = statusField(record, 'ANON_KEY', 'anon_key', 'SUPABASE_ANON_KEY', 'supabase_anon_key');
  if (!nonEmpty(url) || !nonEmpty(serviceRoleKey) || !nonEmpty(anonKey)) return null;
  return { url, serviceRoleKey, anonKey, source: 'cli' };
}

/**
 * Resolve a local Supabase URL and both gateway keys without exposing values.
 * Explicit E2E values win only when all three are present and the URL is
 * loopback.  Otherwise `supabase status -o json` is read from `packages/` so
 * its `supabase/config.toml` resolves to this repository's local project.
 */
export function resolveLocalSupabaseCredentials(options: {
  env?: LocalSupabaseEnv;
  runStatus?: SupabaseStatusRunner;
  cwd?: string;
} = {}): LocalSupabaseCredentials {
  const env = options.env ?? process.env;
  const overrideUrl = env.SOMNIBOT_E2E_SUPABASE_URL?.trim();
  const overridePresent = [
    env.SOMNIBOT_E2E_SUPABASE_URL,
    env.SOMNIBOT_E2E_SUPABASE_SERVICE_ROLE_KEY,
    env.SOMNIBOT_E2E_SUPABASE_ANON_KEY,
  ].some((value) => value !== undefined);
  if (overrideUrl) {
    // A remote explicit URL is a hard safety error, not a signal to fall back
    // to another project.  This keeps the target loopback-only fail-closed.
    assertSupabaseUrlIsLocal(overrideUrl, 'SOMNIBOT_E2E_SUPABASE_URL');
  }
  const overrideService = env.SOMNIBOT_E2E_SUPABASE_SERVICE_ROLE_KEY?.trim();
  const overrideAnon = env.SOMNIBOT_E2E_SUPABASE_ANON_KEY?.trim();
  if (overridePresent && (!nonEmpty(overrideUrl) || !nonEmpty(overrideService) || !nonEmpty(overrideAnon))) {
    throw new Error('Local Supabase credentials unavailable: E2E overrides must provide URL, service key, and anon key');
  }
  if (nonEmpty(overrideService) && nonEmpty(overrideAnon)) {
    const url = overrideUrl || DEFAULT_LOCAL_SUPABASE_URL;
    assertSupabaseUrlIsLocal(url, 'SOMNIBOT_E2E_SUPABASE_URL');
    return { url, serviceRoleKey: overrideService, anonKey: overrideAnon, source: 'override' };
  }

  const result = (options.runStatus ?? defaultStatusRunner)({
    command: process.execPath,
    args: [SUPABASE_CLI_ENTRY, 'status', '-o', 'json'],
    cwd: options.cwd ?? PACKAGE_ROOT,
    env: cliEnvironment(env),
  });
  if (result.status !== 0 || !nonEmpty(result.stdout)) {
    throw new Error('Local Supabase credentials unavailable: supabase status -o json failed');
  }
  const credentials = parseCliStatus(result.stdout);
  if (!credentials) {
    throw new Error('Local Supabase credentials unavailable: supabase status -o json was incomplete');
  }
  assertSupabaseUrlIsLocal(credentials.url, 'supabase status API_URL');
  return credentials;
}

export { DEFAULT_LOCAL_SUPABASE_URL, PACKAGE_ROOT, SUPABASE_CLI_ENTRY, cliEnvironment, parseCliStatus };
