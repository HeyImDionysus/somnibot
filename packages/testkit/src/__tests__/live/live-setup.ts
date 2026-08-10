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
import {
  LOOPBACK_E2E_CONFIRMATION,
  assertSupabaseUrlIsLocal,
  assertValkeyUrlIsLocal,
} from '../../guard.js';
import { resolveLocalSupabaseCredentials } from '../../local-supabase.js';

/**
 * Isolated local service endpoints. The explicit E2E variables are the ONLY
 * supported override: ambient production/developer variables are ignored.
 */
const localSupabase = resolveLocalSupabaseCredentials();
const LOCAL_SUPABASE_URL = localSupabase.url;
const LOCAL_VALKEY_URL = process.env.SOMNIBOT_E2E_VALKEY_URL ?? 'redis://127.0.0.1:6379';
assertSupabaseUrlIsLocal(LOCAL_SUPABASE_URL, 'SOMNIBOT_E2E_SUPABASE_URL');
assertValkeyUrlIsLocal(LOCAL_VALKEY_URL, 'SOMNIBOT_E2E_VALKEY_URL');

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

// Remove every ambient Supabase variable before installing the resolved local
// values. This includes unrelated names such as SUPABASE_DB_URL and
// SUPABASE_ACCESS_TOKEN, which must never cross into a disposable child.
for (const key of Object.keys(process.env)) {
  if (/^SUPABASE_/i.test(key)) delete process.env[key];
}

// ── SAFETY-CRITICAL: force to safe local values regardless of ambient env ──
// A real token / remote URL / live guild id exported in the operator's shell
// must NOT be able to aim this real-effect runner at production.
force('SUPABASE_URL', LOCAL_SUPABASE_URL);
force('VALKEY_URL', LOCAL_VALKEY_URL);
force('VALKEY_PASSWORD', '');
force('DISCORD_GUILD_ID', DISPOSABLE_GUILD_ID);
force('SOMNIBOT_E2E_DISPOSABLE_GUILD_ID', DISPOSABLE_GUILD_ID);
force('DISCORD_TOKEN', 'e2e-live-no-login-dummy-token');

// ── System ──
def('NODE_ENV', 'test');

// ── Supabase keys ──
// Resolved from an explicitly isolated E2E shard or this repository's local
// `supabase status -o json`; ambient customer/production names are ignored.
force('SUPABASE_SECRET_KEY', localSupabase.serviceRoleKey);
force('SUPABASE_SERVICE_ROLE_KEY', localSupabase.serviceRoleKey);
force('SUPABASE_ANON_KEY', localSupabase.anonKey);

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
