/**
 * mint-local-owner-session — produce a REAL owner session cookie for the LOCAL
 * Supabase rig, so a browser can render the dashboard with production auth
 * running 100% for real.
 *
 * This is the browser-side companion to
 * packages/dashboard/src/__tests__/live/_session-harness.ts, and it obeys the
 * same owner decision (2026-07-24): ZERO production auth edits. Nothing here
 * bypasses a guard. It creates a genuine Supabase auth user against the LOCAL
 * disposable database, signs in for genuine tokens, and serialises them with
 * @supabase/ssr's OWN cookie writer — exactly the cookie `createServerSupabase()`
 * reads back. The dashboard then authenticates it the same way it authenticates
 * a real person.
 *
 * LOCAL RIG ONLY: refuses to run against any non-loopback Supabase URL, because
 * creating auth users is not something to do against a real instance.
 *
 * Usage:  node scripts/mint-local-owner-session.mjs [guildId] [ownerDiscordId]
 * Prints JSON: { guildId, discordId, cookies: [{name, value}, ...] }
 */
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { applyLocalSupabaseEnv } from '../../../scripts/local-supabase-env.mjs';

const resolved = applyLocalSupabaseEnv({ env: process.env, requireStatus: true });
const url = resolved.url;
const anonKey = resolved.anonKey;
const serviceKey = resolved.serviceKey;

// Hard refusal, not a warning: this script creates auth users.
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(new URL(url).origin)) {
  console.error(`REFUSING: ${url} is not a loopback Supabase. This script is local-rig only.`);
  process.exit(1);
}

// Snowflake-shaped ids — the dashboard validates /^\d{17,20}$/ in places.
const guildId = process.argv[2] || '900000000000000001';
const discordId = process.argv[3] || '900000000000000002';

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Seed the guild this owner owns. Creating a `guild` row fires a DB trigger that
// auto-seeds the system dashboard_roles, which is what requirePermission's owner
// short-circuit expects to find.
const seeded = await admin
  .from('guild')
  .upsert({ id: guildId, name: 'Local Render Rig', owner_discord_id: discordId }, { onConflict: 'id' });
if (seeded.error) {
  console.error(`guild upsert failed: ${seeded.error.message}`);
  process.exit(1);
}

// Most pages read guild_config; without a row they render an empty/default state
// rather than the real one, which would make a render check prove nothing.
const cfg = await admin.from('guild_config').upsert({ guild_id: guildId }, { onConflict: 'guild_id' });
if (cfg.error) console.error(`[warn] guild_config upsert: ${cfg.error.message}`);

const email = `e2e-owner-${discordId}@somnibot.local`.toLowerCase();
const password = `E2e!${discordId}!pw`;

const created = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { provider_id: discordId, sub: discordId, full_name: `Render Rig Owner` },
});
if (created.error && !/already been registered|already exists/i.test(created.error.message)) {
  console.error(`createUser failed: ${created.error.message}`);
  process.exit(1);
}

const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
const signIn = await anon.auth.signInWithPassword({ email, password });
if (signIn.error || !signIn.data.session) {
  console.error(`signIn failed: ${signIn.error?.message ?? 'no session'}`);
  process.exit(1);
}

// Serialise via @supabase/ssr's own writer so the cookie format is verbatim what
// production reads — not a hand-rolled approximation that could drift.
const store = new Map();
const writer = createServerClient(url, anonKey, {
  cookies: {
    getAll: () => [...store.values()],
    setAll: (list) => list.forEach((c) => store.set(c.name, c)),
  },
});
const setRes = await writer.auth.setSession({
  access_token: signIn.data.session.access_token,
  refresh_token: signIn.data.session.refresh_token,
});
if (setRes.error) {
  console.error(`setSession failed: ${setRes.error.message}`);
  process.exit(1);
}
if (store.size === 0) {
  console.error('@supabase/ssr wrote no session cookie');
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      guildId,
      discordId,
      cookies: [...store.values()].map(({ name, value }) => ({ name, value })),
    },
    null,
    2,
  ),
);
