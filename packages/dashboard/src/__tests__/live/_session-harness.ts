/**
 * _session-harness — REAL-SESSION dashboard-route driving harness (owner
 * decision 2026-07-24: fidelity over convenience, ZERO production auth edits).
 *
 * The dashboard's auth guards (requireGuildOwner / requireAuth / requirePermission)
 * run 100% REAL against LOCAL Supabase. The ONLY thing faked is the Next.js
 * request INFRASTRUCTURE — `next/headers` cookies()/headers(), which throw
 * outside a Next server request context. This harness:
 *   1. creates a REAL Supabase auth user whose user_metadata.provider_id equals
 *      the guild's owner_discord_id (via the GoTrue admin API, service key),
 *   2. signs that user in for a REAL session (access/refresh tokens), and
 *   3. serialises the session into a cookie jar using @supabase/ssr's OWN writer
 *      (setSession → cookies.setAll), so the exact cookie name/format the
 *      production `createServerSupabase()` reads back is produced for real.
 *
 * A test then vi.mock('next/headers') with {@link buildNextHeadersMock} so the
 * REAL route handler runs: real getUser() validates the real session, real
 * ownership check against local Supabase, real createAdminSupabase writes.
 *
 * NOT matched by the `*.test.ts` include — this is a helper, not a test.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { applyLocalSupabaseEnv, DEFAULT_LOCAL_SUPABASE_URL } from '../../../../../scripts/local-supabase-env.mjs';

/**
 * Arm the local-rig env every dashboard live test needs from the current
 * `supabase status` output (or explicitly supplied CI env). Call at module top
 * of a live test file, BEFORE importing any route (routes read env lazily, so
 * this is in time). Returns the resolved SUPABASE_URL for reachability probes.
 */
export function armDashboardLiveEnv(): string {
  try {
    const resolved = applyLocalSupabaseEnv({ env: process.env, requireStatus: true });
    const parsed = new URL(resolved.url || DEFAULT_LOCAL_SUPABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw new Error('dashboard live harness requires a loopback Supabase URL');
    }
    return parsed.origin;
  } catch {
    // A plain local `test:live` run should self-skip when Supabase is absent,
    // but ambient remote/stale credentials must never become live-test proof.
    for (const key of [
      'SUPABASE_ANON_KEY',
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      'SUPABASE_PUBLISHABLE_KEY',
      'SUPABASE_SECRET_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]) delete process.env[key];
    process.env.SUPABASE_URL = DEFAULT_LOCAL_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = DEFAULT_LOCAL_SUPABASE_URL;
    return DEFAULT_LOCAL_SUPABASE_URL;
  }
}

/** Probe whether local Supabase (GoTrue) is reachable, so a live suite self-skips
 *  in the plain unit env (no Supabase) and runs in the Live-Stack job. */
export async function localSupabaseReachable(url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'): Promise<boolean> {
  try {
    const res = await fetch(`${url}/auth/v1/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export interface CookieRecord {
  name: string;
  value: string;
  options?: Record<string, unknown>;
}

/** A minimal, in-memory cookie jar exposing the getAll/set/setAll surface both
 *  @supabase/ssr (writer) and the mocked next/headers cookies() (reader) use. */
export class CookieJar {
  private readonly store = new Map<string, CookieRecord>();

  getAll(): CookieRecord[] {
    return [...this.store.values()];
  }
  get(name: string): CookieRecord | undefined {
    return this.store.get(name);
  }
  set(name: string, value: string, options?: Record<string, unknown>): void {
    this.store.set(name, { name, value, options });
  }
  setAll(cookies: CookieRecord[]): void {
    for (const c of cookies) this.set(c.name, c.value, c.options);
  }
  size(): number {
    return this.store.size;
  }
}

export interface OwnerSession {
  /** The cookie jar holding the REAL @supabase/ssr session cookie(s). */
  readonly jar: CookieJar;
  /** The Supabase auth user id created for this owner. */
  readonly userId: string;
  /** The Discord id this owner authenticates as (== guild owner_discord_id). */
  readonly discordId: string;
  /** The raw session tokens (for assertions/debugging). */
  readonly accessToken: string;
}

function localEnv(): { url: string; anonKey: string; serviceKey: string } {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    '';
  const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !anonKey || !serviceKey) {
    throw new Error('_session-harness: SUPABASE_URL + anon key + service key must be set (local rig env)');
  }
  return { url, anonKey, serviceKey };
}

/**
 * Create a REAL owner auth user + session and serialise it into a cookie jar
 * using @supabase/ssr's own cookie writer, so the production server client reads
 * it back verbatim. Idempotent per (discordId): a stable email is derived from
 * the discord id; if the user already exists the sign-in still succeeds.
 */
export async function createOwnerSession(discordId: string): Promise<OwnerSession> {
  const { url, anonKey, serviceKey } = localEnv();
  const admin: SupabaseClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const email = `e2e-owner-${discordId}@somnibot.local`.toLowerCase();
  const password = `E2e!${discordId}!pw`;

  // Create the auth user (GoTrue admin). provider_id in user_metadata is what
  // requireGuildOwner reads for the Discord identity. Tolerate "already exists".
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { provider_id: discordId, sub: discordId, full_name: `E2E Owner ${discordId}` },
  });
  if (created.error && !/already been registered|already exists/i.test(created.error.message)) {
    throw new Error(`_session-harness: createUser failed: ${created.error.message}`);
  }

  // Sign in for a REAL session (access + refresh tokens).
  const anon: SupabaseClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signIn = await anon.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) {
    throw new Error(`_session-harness: signIn failed: ${signIn.error?.message ?? 'no session'}`);
  }
  const session = signIn.data.session;

  // Serialise the session into the jar via @supabase/ssr's OWN writer, so the
  // cookie name/format matches exactly what createServerSupabase() reads back.
  const jar = new CookieJar();
  const writer = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (cookies: CookieRecord[]) => jar.setAll(cookies),
    },
  });
  const setRes = await writer.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (setRes.error) {
    throw new Error(`_session-harness: setSession failed: ${setRes.error.message}`);
  }
  if (jar.size() === 0) {
    throw new Error('_session-harness: @supabase/ssr wrote no session cookie into the jar');
  }

  return {
    jar,
    userId: signIn.data.user.id,
    discordId,
    accessToken: session.access_token,
  };
}

/**
 * Build the object to feed `vi.mock('next/headers', ...)`: a `cookies()` backed
 * by the session jar and a `headers()` that carries the active guild selector
 * (requireGuildOwner reads `x-guild-id`). Everything else runs real.
 */
export function buildNextHeadersMock(session: OwnerSession, guildId: string) {
  const cookieStore = {
    getAll: () => session.jar.getAll(),
    get: (name: string) => session.jar.get(name),
    set: (name: string, value: string, options?: Record<string, unknown>) => session.jar.set(name, value, options),
  };
  const headerMap = new Map<string, string>([['x-guild-id', guildId]]);
  const headerStore = {
    get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    has: (name: string) => headerMap.has(name.toLowerCase()),
  };
  return {
    cookies: async () => cookieStore,
    headers: async () => headerStore,
  };
}
