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
 *   - 'complete'     → setup_completed_at is set. Boot normally (full feature init).
 *   - 'in_progress'  → Discord credentials exist but setup is not finalized. The
 *                      setup wizard is running and NEEDS the bot reachable to
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

/** Build the 'complete' evaluation (normal full boot). */
function completeEvaluation(dashboardUrl: string): SetupGateEvaluation {
  return {
    state: 'complete',
    shouldLogin: true,
    shouldRunFullInit: true,
    message: null,
    dashboardUrl,
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
  };
}

/**
 * Classify the instance's setup state so the boot sequence can gate itself.
 *
 * Read as few settings as needed:
 *   1. setup_completed_at — if set, we're done classifying → 'complete'.
 *   2. otherwise, is a Discord token present (env or DB)? →
 *        'in_progress' if yes, 'not_started' if no.
 *
 * The function never throws: on any read failure it degrades to the most
 * conservative state that keeps the wizard usable — if a token is present in
 * env we assume 'in_progress' (bot needed for verification), otherwise
 * 'not_started'.
 */
export async function evaluateSetupGate(
  supabase: SupabaseClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SetupGateEvaluation> {
  const dashboardUrl = resolveDashboardUrl(env);

  const completed = await readInstanceSetting(supabase, SETUP_COMPLETED_KEY);
  if (completed.value) {
    return completeEvaluation(dashboardUrl);
  }

  // The setup_completed_at lookup did NOT complete (transient PostgREST/RLS
  // error, not a genuinely missing row). Do NOT treat unknown setup state as
  // "incomplete": that would boot an already-finalized production bot in
  // verification-only mode on a blip. If a token is present we can log in, so
  // fall through to normal boot; without a token there is nothing to run, so
  // stay 'not_started' and idle rather than crash-loop.
  if (completed.readFailed) {
    if (hasDiscordTokenInEnv(env)) {
      return completeEvaluation(dashboardUrl);
    }
    return notStartedEvaluation(dashboardUrl);
  }

  const tokenInEnv = hasDiscordTokenInEnv(env);
  const dbToken = tokenInEnv
    ? { value: null as string | null, readFailed: false }
    : await readInstanceSetting(supabase, DISCORD_BOT_TOKEN_KEY);
  const tokenPresent = tokenInEnv || dbToken.value !== null;

  if (tokenPresent) {
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
    };
  }

  return notStartedEvaluation(dashboardUrl);
}
