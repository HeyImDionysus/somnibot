/**
 * Loopback E2E safety guard.
 *
 * This package drives SomniBot's REAL production interaction dispatcher and
 * makes REAL mutations to a Discord guild and a Supabase database. It must
 * NEVER run against production. Three independent gates protect that:
 *
 *   1. Build-graph exclusion (structural): @somnibot/testkit is only ever a
 *      devDependency of the E2E harness, never a dependency of @somnibot/bot,
 *      so the shipped bot bundle has no import edge to this code at all.
 *   2. This runtime guard (defense-in-depth): even if imported by accident,
 *      every entry point calls assertLoopbackAllowed() which throws unless the
 *      environment is unambiguously a disposable local test rig.
 *   3. A CI dependency-graph assertion (separate check) fails the build if a
 *      production import edge into this package ever appears.
 *
 * The confirmation phrase mirrors the existing deploy-live E2E guard so the
 * operator opts in identically for every real-effect harness.
 */

export const LOOPBACK_E2E_CONFIRMATION =
  'I_UNDERSTAND_THIS_MUTATES_A_DISPOSABLE_DISCORD_GUILD_AND_LOCAL_SUPABASE';

/** Hostnames accepted as "local Supabase". Anything else is treated as remote. */
const LOCAL_SUPABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class LoopbackGuardError extends Error {
  constructor(message: string) {
    super(`Loopback E2E guard: ${message}`);
    this.name = 'LoopbackGuardError';
  }
}

/**
 * Throws unless `url` points at a local Supabase host. Shared by Gate C (the
 * env check) and the injector's client-target cross-check, so both use the
 * exact same host allowlist.
 */
export function assertSupabaseUrlIsLocal(url: string, context: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new LoopbackGuardError(`${context} must be a valid URL`);
  }
  if (!LOCAL_SUPABASE_HOSTS.has(host)) {
    throw new LoopbackGuardError(
      `${context} host "${host}" is not local; refusing to run against a remote database`,
    );
  }
}

/**
 * Reject a Valkey target unless it is an unauthenticated loopback endpoint.
 * The live harness supplies this URL itself; accepting ambient credentials or a
 * remote host would let a disposable test touch an established installation.
 */
export function assertValkeyUrlIsLocal(url: string, context: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LoopbackGuardError(`${context} must be a valid URL`);
  }
  if (parsed.protocol !== 'redis:' || !LOCAL_SUPABASE_HOSTS.has(parsed.hostname)) {
    throw new LoopbackGuardError(`${context} must be a redis:// loopback URL`);
  }
  if (parsed.username || parsed.password) {
    throw new LoopbackGuardError(`${context} must not contain credentials`);
  }
}

export interface LoopbackEnv {
  NODE_ENV?: string;
  SUPABASE_URL?: string;
  DISCORD_GUILD_ID?: string;
  SOMNIBOT_E2E_DISPOSABLE_GUILD_ID?: string;
  SOMNIBOT_LOOPBACK_E2E_CONFIRMATION?: string;
  // The production commerce path selects the PayPal endpoint from
  // PAYPAL_API_BASE (default sandbox) + PAYPAL_CLIENT_ID/SECRET — NOT from
  // PAYPAL_ENV. Gate E guards the variables the dispatcher actually reads.
  PAYPAL_API_BASE?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_ENV?: string;
}

/** PayPal API hosts treated as non-live (safe for loopback). */
const SANDBOX_PAYPAL_HOSTS = new Set([
  'api-m.sandbox.paypal.com',
  'api.sandbox.paypal.com',
  'localhost',
  '127.0.0.1',
]);

/**
 * Throws LoopbackGuardError unless the environment is unambiguously a
 * disposable local E2E rig. Called at adapter construction AND before every
 * injected interaction so a mid-run environment change cannot slip through.
 *
 * Pass an explicit env for testability; defaults to process.env.
 */
export function assertLoopbackAllowed(env: LoopbackEnv = process.env): void {
  // Gate A — never production.
  if ((env.NODE_ENV ?? '') === 'production') {
    throw new LoopbackGuardError('NODE_ENV must not be "production"');
  }

  // Gate B — explicit, exact operator confirmation (opt-in, not a default).
  if (env.SOMNIBOT_LOOPBACK_E2E_CONFIRMATION !== LOOPBACK_E2E_CONFIRMATION) {
    throw new LoopbackGuardError(
      `SOMNIBOT_LOOPBACK_E2E_CONFIRMATION must equal ${LOOPBACK_E2E_CONFIRMATION}`,
    );
  }

  // Gate C — Supabase must be local (never a hosted/production project).
  if (!env.SUPABASE_URL) {
    throw new LoopbackGuardError('SUPABASE_URL is required');
  }
  assertSupabaseUrlIsLocal(env.SUPABASE_URL, 'SUPABASE_URL');

  // Gate D — the target guild must be the declared disposable guild, and both
  // must be present. This prevents driving real effects into a live guild.
  const guildId = env.DISCORD_GUILD_ID;
  const disposableGuildId = env.SOMNIBOT_E2E_DISPOSABLE_GUILD_ID;
  if (!guildId || !disposableGuildId) {
    throw new LoopbackGuardError(
      'DISCORD_GUILD_ID and SOMNIBOT_E2E_DISPOSABLE_GUILD_ID are both required',
    );
  }
  if (guildId !== disposableGuildId) {
    throw new LoopbackGuardError(
      'DISCORD_GUILD_ID must equal SOMNIBOT_E2E_DISPOSABLE_GUILD_ID (disposable guild only)',
    );
  }

  // Gate E — commerce must never touch real PayPal (two-economies wall).
  // Guard the variable the dispatcher ACTUALLY uses: PAYPAL_API_BASE selects
  // the endpoint (interaction-handler.ts) and defaults to sandbox when unset.
  // If it is set, its host must be a sandbox/local host; and live credentials
  // must never accompany a non-sandbox base.
  const apiBase = env.PAYPAL_API_BASE;
  if (apiBase !== undefined) {
    let paypalHost: string;
    try {
      paypalHost = new URL(apiBase).hostname;
    } catch {
      throw new LoopbackGuardError('PAYPAL_API_BASE must be a valid URL');
    }
    if (!SANDBOX_PAYPAL_HOSTS.has(paypalHost)) {
      throw new LoopbackGuardError(
        `PAYPAL_API_BASE host "${paypalHost}" is not a sandbox/local host; refusing to run against live PayPal`,
      );
    }
  }
  // Belt and braces: real PayPal credentials must not be present unless the
  // base is explicitly a sandbox host (the check above already rejects a live
  // base, so this catches "live creds + default/unset base" misconfiguration).
  if ((env.PAYPAL_CLIENT_ID || env.PAYPAL_CLIENT_SECRET) && apiBase === undefined) {
    throw new LoopbackGuardError(
      'PAYPAL_CLIENT_ID/SECRET are set without an explicit sandbox PAYPAL_API_BASE; set PAYPAL_API_BASE to a sandbox host or clear the credentials',
    );
  }
  // PAYPAL_ENV is an additional advisory signal, not the enforcement point.
  if (env.PAYPAL_ENV !== undefined && env.PAYPAL_ENV !== 'sandbox') {
    throw new LoopbackGuardError(
      `PAYPAL_ENV, if set, must be "sandbox" for loopback E2E, got "${env.PAYPAL_ENV}"`,
    );
  }
}

/** Non-throwing form for callers that want to branch. */
export function isLoopbackAllowed(env: LoopbackEnv = process.env): boolean {
  try {
    assertLoopbackAllowed(env);
    return true;
  } catch {
    return false;
  }
}
