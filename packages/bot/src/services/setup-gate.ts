/**
 * Startup Setup Gate
 *
 * Wave 3 finish-line: the bot used to connect to Discord and run its full
 * per-guild feature init regardless of whether owner setup had finished. For a
 * non-technical owner mid-setup that produced a stream of confusing errors
 * (missing credentials, no guild config, feature managers throwing) instead of
 * one clear "finish setup first" signal.
 *
 * This module classifies the instance's setup state from `instance_settings`
 * so the boot sequence can decide how far to proceed:
 *
 *   - 'complete'     → setup_completed_at is set — OR the deployment is
 *                      configured purely via environment variables (see below).
 *                      Boot normally (full feature init).
 *   - 'in_progress'  → A setup flow has stored Discord credentials in
 *                      instance_settings (the wizard's verify-discord step or
 *                      the desktop launcher's credential sync) but setup is not
 *                      finalized. The setup wizard NEEDS the bot reachable to
 *                      verify "bot online" + "guild detected" before it can
 *                      finalize. Boot a minimal verification mode: log in, write
 *                      the guild record, emit heartbeats — but SKIP the heavy
 *                      per-guild feature init that spams errors.
 *   - 'not_started'  → No Discord bot token anywhere (env or instance_settings).
 *                      The bot cannot even log in. Do not attempt a Discord
 *                      login (which would error); idle in an "awaiting setup"
 *                      health state so the launcher/process-manager can surface
 *                      a clean waiting status instead of a crash loop.
 *
 * The 'in_progress' vs 'not_started' distinction is deliberate: it separates
 * "setup in progress, bot needed for verification" from "setup never started".
 *
 * Env-configured deployments (codex round-3 finding #1): a deployment that is
 * configured entirely through environment variables (VPS / docker-compose .env
 * — the pre-existing supported path) never runs the dashboard wizard, so no
 * `setup_completed_at` row will EVER exist for it. It must NOT be gated into
 * verification mode: a token in the environment with NO wizard-stored
 * credential row in instance_settings classifies as 'complete'. The raw
 * `discord_bot_token` row is a reliable wizard marker because only the
 * owner-driven setup surfaces write it — the bot's own env→DB sync never
 * persists raw secrets (config-loader SECRET_KEYS writes a
 * `discord_bot_token_configured` flag instead).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** How far the boot sequence should proceed. */
export type SetupGateState = 'complete' | 'in_progress' | 'not_started';

export interface SetupGateEvaluation {
  state: SetupGateState;
  /** True when the bot should log in to Discord (complete OR in_progress). */
  shouldLogin: boolean;
  /**
   * True when the bot should run the full per-guild feature init.
   * Only 'complete' runs the heavy path; 'in_progress' runs a minimal
   * verification boot so the wizard can confirm the bot is online.
   */
  shouldRunFullInit: boolean;
  /** A single, clear, actionable line to log (in_progress / not_started). */
  message: string | null;
  /** The dashboard URL surfaced in the message so the owner can finish setup. */
  dashboardUrl: string;
  /**
   * True only when `state: 'complete'` was determined from an actual
   * `setup_completed_at` row read — NOT from the read-failure fallback (a
   * transient error with a token present degrades to 'complete' so an
   * already-finalized production bot still boots normally on a blip), and NOT
   * from the env-configured classification (token in env, no wizard rows —
   * there is no completion row to confirm).
   *
   * Startup treats all of these the same (either way, run the full boot). The
   * setup-completion watcher, however, must NOT fire a verification→full-boot
   * transition on anything but an unambiguously completed row, so it keys off
   * this flag. Always false for non-complete states.
   */
  completionConfirmed: boolean;
}

const INSTANCE_SETTINGS_TABLE = 'instance_settings';
const SETUP_COMPLETED_KEY = 'setup_completed_at';
const DISCORD_BOT_TOKEN_KEY = 'discord_bot_token';

/**
 * Build a lightweight Supabase client for the gate check, using the same
 * bootstrap credentials the config-loader uses (SUPABASE_URL +
 * SUPABASE_SECRET_KEY / legacy SUPABASE_SERVICE_ROLE_KEY). Returns null when
 * those credentials are not present — in which case the caller cannot classify
 * setup state and should fall through to its normal env validation.
 *
 * The gate runs BEFORE loadConfig()/SomniClient in the boot sequence (the
 * 'not_started' case has no Discord token, and loadConfig() would exit on it),
 * so it cannot reuse client.supabase and needs its own bootstrap client.
 */
export function createBootstrapSupabase(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseClient | null {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Resolve the dashboard URL to point the owner at, mirroring the convention
 * used elsewhere in the bot (interaction-handler, first-boot DM): explicit
 * DASHBOARD_URL wins, otherwise the launcher's local dashboard.
 */
export function resolveDashboardUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.DASHBOARD_URL?.trim() ||
    env.NEXT_PUBLIC_DASHBOARD_URL?.trim() ||
    env.NEXT_PUBLIC_APP_URL?.trim() ||
    'http://localhost:3456'
  );
}

/**
 * Postgres "relation does not exist" — the instance_settings table has not
 * been created yet on a genuinely fresh instance. This is an EXPECTED first-boot
 * condition (the row is legitimately absent), not a transient read failure, so
 * it is reported as `readFailed: false`.
 */
const RELATION_MISSING_CODE = '42P01';

interface InstanceSettingRead {
  /** The trimmed non-blank value, or null when the row is missing/blank. */
  value: string | null;
  /**
   * True when the read did NOT complete successfully (transient PostgREST/RLS
   * error, network failure, thrown exception) — as opposed to the setting
   * simply being absent. Callers must NOT treat a failed read as "absent":
   * doing so would let a transient error on a finalized bot's
   * `setup_completed_at` lookup boot it in verification-only mode.
   *
   * The benign "table does not exist yet" case (42P01) is reported as a clean
   * absence (`value: null, readFailed: false`) so first boot still classifies
   * as not_started/in_progress rather than an unknown-state fail path.
   */
  readFailed: boolean;
}

/**
 * Read a single instance_settings value, distinguishing "row is missing/blank"
 * from "the read failed". Returns `{ value: null, readFailed: false }` when the
 * row is absent, blank, or the table does not exist yet (first boot, 42P01);
 * returns `{ value: null, readFailed: true }` when the query errors or throws.
 */
async function readInstanceSetting(
  supabase: SupabaseClient,
  key: string,
): Promise<InstanceSettingRead> {
  try {
    const { data, error } = (await supabase
      .from(INSTANCE_SETTINGS_TABLE)
      .select('value')
      .eq('key', key)
      .maybeSingle()) as { data: { value: string | null } | null; error: { code?: string } | null };

    if (error) {
      // A missing table on a fresh instance is an expected absence, not a
      // transient failure — classify it as a clean "row absent".
      if (error.code === RELATION_MISSING_CODE) {
        return { value: null, readFailed: false };
      }
      return { value: null, readFailed: true };
    }
    const value = data?.value;
    const trimmed =
      typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    return { value: trimmed, readFailed: false };
  } catch {
    return { value: null, readFailed: true };
  }
}

/**
 * Whether a usable Discord bot token exists — either already loaded into the
 * environment (launcher-forked bot, or config-loader's DB→env fallback) or
 * still sitting in instance_settings from the setup wizard's verify-discord
 * step. Presence of the token is what separates "in progress" from
 * "never started": without it the bot has nothing to log in with.
 */
function hasDiscordTokenInEnv(env: NodeJS.ProcessEnv): boolean {
  return typeof env.DISCORD_TOKEN === 'string' && env.DISCORD_TOKEN.trim().length > 0;
}

/**
 * Build the 'complete' evaluation (normal full boot).
 *
 * `confirmed` is true when a real `setup_completed_at` row was read, false when
 * this is the transient-read-failure fallback (token present → boot normally
 * anyway). The setup-completion watcher only transitions on a confirmed
 * completion; see SetupGateEvaluation.completionConfirmed.
 */
function completeEvaluation(dashboardUrl: string, confirmed: boolean): SetupGateEvaluation {
  return {
    state: 'complete',
    shouldLogin: true,
    shouldRunFullInit: true,
    message: null,
    dashboardUrl,
    completionConfirmed: confirmed,
  };
}

/** Build the 'in_progress' evaluation (minimal verification boot). */
function inProgressEvaluation(dashboardUrl: string): SetupGateEvaluation {
  return {
    state: 'in_progress',
    // The wizard's "bot online" + "guild detected" readiness checks require
    // the bot to actually be logged in and heartbeating, so we DO log in —
    // but we skip the heavy feature init that would spam errors mid-setup.
    shouldLogin: true,
    shouldRunFullInit: false,
    message:
      `Setup not complete — the bot is running in setup-verification mode so the wizard can confirm it is online. ` +
      `Finish setup at ${dashboardUrl} to enable all features.`,
    dashboardUrl,
    completionConfirmed: false,
  };
}

/** Build the 'not_started' evaluation (idle, no Discord login). */
function notStartedEvaluation(dashboardUrl: string): SetupGateEvaluation {
  return {
    state: 'not_started',
    // No token to log in with — attempting a Discord login would only error.
    shouldLogin: false,
    shouldRunFullInit: false,
    message:
      `Setup not complete — no Discord bot token is configured yet. ` +
      `Finish setup at ${dashboardUrl} before the bot can run.`,
    dashboardUrl,
    completionConfirmed: false,
  };
}

/**
 * Classify the instance's setup state so the boot sequence can gate itself.
 *
 *   1. setup_completed_at set → 'complete' (confirmed).
 *   2. otherwise, is there a wizard-stored `discord_bot_token` row in
 *      instance_settings? → 'in_progress' (an owner-driven setup flow stored
 *      credentials but never finalized — the wizard needs the bot in
 *      verification mode to finish).
 *   3. otherwise, is a token present in the environment? → 'complete'
 *      (env-configured deployment; the wizard was never used, so no completion
 *      row will ever exist — codex round-3 finding #1). Unconfirmed.
 *   4. otherwise → 'not_started'.
 *
 * The function never throws: on any read failure it degrades to the state
 * that never strands a working deployment — with a token in env it boots
 * normally (a finalized/env-configured bot must not be gated on a blip),
 * without one it idles as 'not_started' rather than crash-loop.
 */
export async function evaluateSetupGate(
  supabase: SupabaseClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SetupGateEvaluation> {
  const dashboardUrl = resolveDashboardUrl(env);

  const completed = await readInstanceSetting(supabase, SETUP_COMPLETED_KEY);
  if (completed.value) {
    // Genuine completed row read — an unambiguous completion the watcher can
    // safely transition on.
    return completeEvaluation(dashboardUrl, true);
  }

  // The setup_completed_at lookup did NOT complete (transient PostgREST/RLS
  // error, not a genuinely missing row). Do NOT treat unknown setup state as
  // "incomplete": that would boot an already-finalized production bot in
  // verification-only mode on a blip. If a token is present we can log in, so
  // fall through to normal boot; without a token there is nothing to run, so
  // stay 'not_started' and idle rather than crash-loop.
  if (completed.readFailed) {
    if (hasDiscordTokenInEnv(env)) {
      // Unknown state, but a token is present so we boot normally rather than
      // downgrade a finalized bot on a blip. This completion is NOT confirmed:
      // the setup-completion watcher must not treat it as a genuine finalize.
      return completeEvaluation(dashboardUrl, false);
    }
    return notStartedEvaluation(dashboardUrl);
  }

  // No completion row (clean read). Distinguish a wizard-managed install
  // mid-setup from a deployment configured purely via environment variables
  // (codex round-3 finding #1). The raw `discord_bot_token` row is written
  // ONLY by the owner-driven setup surfaces (dashboard wizard verify-discord,
  // desktop launcher credential sync) — the bot's own env→DB sync never
  // persists raw secrets. So this read must happen even when the token is
  // already in env: a launcher-forked mid-wizard boot has BOTH the env token
  // and the row, while an env-configured VPS/docker deployment has only the
  // env token.
  const tokenInEnv = hasDiscordTokenInEnv(env);
  const dbToken = await readInstanceSetting(supabase, DISCORD_BOT_TOKEN_KEY);

  if (dbToken.value !== null) {
    // Wizard-stored credentials exist but setup was never finalized →
    // verification mode so the wizard can finish.
    return inProgressEvaluation(dashboardUrl);
  }

  if (tokenInEnv) {
    // Env-complete = complete: a token in the environment with no
    // wizard-stored credential row means the deployment is configured via env
    // vars alone (or, when this read failed, we prefer booting normally over
    // gating a possibly-finalized deployment — same philosophy as the
    // completed-row fallback above). Unconfirmed: not derived from a
    // completion row, so the setup-completion watcher must not transition on
    // it.
    return completeEvaluation(dashboardUrl, false);
  }

  return notStartedEvaluation(dashboardUrl);
}
