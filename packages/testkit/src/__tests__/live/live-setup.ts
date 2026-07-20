/**
 * live-setup — arms the loopback guard environment for the GATED live lane.
 *
 * Referenced by `vitest.live.config.ts` as a `setupFiles` entry, so it runs
 * BEFORE any live test module (and its bot imports) load.
 *
 * Two classes of variable are treated DIFFERENTLY on purpose:
 *
 *   1. Safety-critical vars are FORCE-OVERRIDDEN to safe local values,
 *      regardless of ambient env. An operator who happens to have a REAL
 *      `DISCORD_TOKEN` exported, or a remote `SUPABASE_URL`, or a live
 *      `DISCORD_GUILD_ID` in their shell MUST NOT be able to point this
 *      real-effect runner at production. These are pinned, not defaulted:
 *        - SUPABASE_URL           → local Supabase,
 *        - DISCORD_GUILD_ID       → the disposable guild id,
 *        - SOMNIBOT_E2E_DISPOSABLE_GUILD_ID → the SAME disposable id (so the
 *          guard's "must equal" gate can never be satisfied by a real guild),
 *        - DISCORD_TOKEN          → a dummy no-login placeholder (neutralised).
 *
 *   2. Non-safety vars are only DEFAULTED when absent, so an operator/CI can
 *      still tune them (e.g. a different LOCAL service-role key).
 *
 * This lane is opt-in by construction: it only runs via the explicit
 * `pnpm --filter @somnibot/testkit test:live` script, never the default fast
 * `vitest run`.
 *
 * NOTE: DISCORD_TOKEN is a DUMMY placeholder that satisfies BotEnvSchema (min
 * length 1) so `loadConfig()` does not exit. The runner never calls
 * `client.login()`, so it is never used to authenticate to Discord. Real
 * Discord-side readback is a later, credentialed phase (see the gated block in
 * the live test); it keys off SOMNIBOT_LOOPBACK_E2E_DISCORD_READBACK + a live
 * gateway, NOT this placeholder.
 */
import { LOOPBACK_E2E_CONFIRMATION } from '../../guard.js';

/** Well-known Supabase CLI local-dev service_role JWT (issuer `supabase-demo`).
 *  Valid ONLY against a local `supabase start` instance — not a secret. */
const LOCAL_DEMO_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

/** Well-known Supabase CLI local-dev anon JWT (issuer `supabase-demo`). Valid
 *  ONLY against a local instance — not a secret. Exported so the RLS anon-denial
 *  sub-probe actually runs (an anon key that reads zero wallet rows is the real
 *  RLS proof); without it the database-RLS anon check would only GATE. */
const LOCAL_DEMO_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

/** Local Supabase REST endpoint — the only host the guard accepts. */
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';

/** Stable disposable guild id for the local rig. TEXT everywhere it lands
 *  (guild.id, economy_wallets.guild_id), so a readable non-snowflake is fine. */
const DISPOSABLE_GUILD_ID = 'e2e-live-disposable-guild';

/** Default a var only when it is absent/empty (operator-tunable). */
function def(key: string, value: string): void {
  if (!process.env[key] || process.env[key] === '') {
    process.env[key] = value;
  }
}

/** Pin a safety-critical var UNCONDITIONALLY — ambient env cannot redirect it. */
function force(key: string, value: string): void {
  process.env[key] = value;
}

// ── SAFETY-CRITICAL: force to safe local values regardless of ambient env ──
// A real token / remote URL / live guild id exported in the operator's shell
// must NOT be able to aim this real-effect runner at production.
force('SUPABASE_URL', LOCAL_SUPABASE_URL);
force('DISCORD_GUILD_ID', DISPOSABLE_GUILD_ID);
force('SOMNIBOT_E2E_DISPOSABLE_GUILD_ID', DISPOSABLE_GUILD_ID);
force('DISCORD_TOKEN', 'e2e-live-no-login-dummy-token');

// ── System ──
def('NODE_ENV', 'test');

// ── Supabase keys (LOCAL demo key by default; operator may swap for another
//    LOCAL key — the URL above is already pinned local) ──
def('SUPABASE_SECRET_KEY', LOCAL_DEMO_SERVICE_ROLE_KEY);
def('SUPABASE_SERVICE_ROLE_KEY', LOCAL_DEMO_SERVICE_ROLE_KEY);
// Anon key for the RLS anon-denial sub-probe (local demo key; operator-tunable).
def('SUPABASE_ANON_KEY', LOCAL_DEMO_ANON_KEY);

// ── Explicit operator confirmation (guard Gate B) ──
def('SOMNIBOT_LOOPBACK_E2E_CONFIRMATION', LOOPBACK_E2E_CONFIRMATION);

// ── Commerce must never touch live PayPal (guard Gate E, advisory) ──
def('PAYPAL_ENV', 'sandbox');

// ── Discord identity that BotEnvSchema requires (never used to log in) ──
def('DISCORD_APPLICATION_ID', '000000000000000000');

// eslint-disable-next-line no-console
console.warn(
  `[live-setup] Loopback E2E guard armed for disposable rig: ` +
    `SUPABASE_URL=${process.env.SUPABASE_URL} DISCORD_GUILD_ID=${process.env.DISCORD_GUILD_ID} ` +
    `(safety-critical vars force-pinned; no Discord login — DB-observable proof only).`,
);
