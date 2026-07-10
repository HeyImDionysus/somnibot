/**
 * Setup-Verification Boot (Wave 3 setup gate)
 *
 * When the setup gate reports 'in_progress' (Discord credentials exist but
 * setup is not finalized), the bot must come online *just enough* for the
 * dashboard setup wizard to verify it:
 *
 *   - the wizard's "guild detected" check reads the `guild` table row, and
 *   - the wizard's "bot online" check reads, in order (see
 *     packages/dashboard/src/app/api/setup/route.ts::getOwnerRuntimeReadiness):
 *       1. a fresh `bot_diagnostics` row of `type: 'health'` (Supabase fallback,
 *          survives a Valkey outage), then
 *       2. the bot-level Valkey heartbeat (`somnibot:heartbeat:bot`, whose
 *          payload includes the guild IDs).
 *
 * This module writes exactly those signals and nothing else. It does NOT run
 * the heavy per-guild feature init (GuildRouter, feature managers, timers,
 * command registration) that would spam errors while config is incomplete.
 *
 * Note on the `health` diagnostic: in a normal full boot the periodic
 * DiagnosticsService writes the `type: 'health'` row the setup route checks
 * first. That service is intentionally NOT started in verification mode, so we
 * write a minimal `health` row here ourselves — otherwise, when Valkey is
 * unavailable to the dashboard, the setup route's Supabase readiness fallback
 * would never see a `health` snapshot and setup would stay blocked with
 * "Start SomniBot..." even though the bot is online.
 *
 * Once the owner finalizes setup, the boot sequence re-enters the full boot
 * path (see packages/bot/src/index.ts) and the normal DiagnosticsService takes
 * over the `health` snapshots.
 */
import type { Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';
import type { SomniClient } from '../client.js';
import { HeartbeatService } from './heartbeat.js';

const log = createLogger('SetupVerify');

/** How often to refresh the verification `health` diagnostic row. */
const VERIFY_HEALTH_INTERVAL_MS = 60_000;

/**
 * Upsert the `guild` table row the setup wizard reads for "guild detected".
 * Mirrors the write in guild-init.ts but without any feature-init side effects.
 *
 * The bot member is only needed for optional role-position metadata. If it is
 * not cached yet (common right after a guildCreate before the member chunk
 * arrives), we fetch it; if that still fails we upsert the row with a null
 * `bot_role_position` rather than skipping the whole record — the wizard's
 * "guild detected" check only needs the row to exist.
 */
export async function writeGuildRecord(guild: Guild, supabase: SupabaseClient): Promise<void> {
  // Prefer the cached bot member; fall back to a fetch when it is not cached
  // yet so a just-joined guild is still recorded instead of being skipped.
  let botMember = guild.members.me;
  if (!botMember) {
    botMember = await guild.members.fetchMe().catch(() => null);
  }

  const { error } = await supabase
    .from('guild')
    .upsert(
      {
        id: guild.id,
        name: guild.name,
        owner_discord_id: guild.ownerId,
        // Nullable when the bot member cannot be resolved — the wizard's
        // guild-detected check does not depend on this; a later full boot
        // (with feature init) will populate it accurately.
        bot_role_position: botMember?.roles.highest.position ?? null,
        total_roles: guild.roles.cache.size,
      },
      { onConflict: 'id' },
    );

  if (error) log.error('Failed to write guild record', { guildId: guild.id, error: error.message });
  else log.info('Guild record written for setup verification', { guildId: guild.id });
}

/**
 * Persist an auto-detected guild id into `instance_settings.discord_guild_id`
 * (codex round-3 finding #4).
 *
 * The dashboard setup route resolves the configured guild via
 * getConfiguredDiscordGuildId, which — when neither `DISCORD_GUILD_ID` in the
 * environment nor the wizard-written credential is present — falls back to
 * `instance_settings.discord_guild_id`. It then calls getOwnerRuntimeReadiness
 * with that id BEFORE ever querying the `guild` table, and returns
 * `guildDetected: false` when the id is null. So a pure invite-and-detect setup
 * (owner invites the bot without pre-entering a guild id) would stay blocked
 * even though the bot wrote the `guild` row — the route never looks the row up
 * without a configured id.
 *
 * Writing the detected id here closes that gap. It mirrors the row shape the
 * config-loader uses (key/value/section) so the value is indistinguishable from
 * one the wizard would have written, and the dashboard's readiness check then
 * finds the guild.
 */
async function persistDetectedGuildId(
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('instance_settings')
      .upsert(
        {
          key: 'discord_guild_id',
          value: guildId,
          section: 'discord',
        },
        { onConflict: 'key' },
      );
    if (error) {
      log.warn('Failed to persist detected guild id to instance_settings', {
        guildId,
        error: error.message,
      });
    } else {
      log.info('Persisted detected guild id for setup readiness', { guildId });
    }
  } catch (err) {
    log.warn('Error persisting detected guild id to instance_settings', {
      guildId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Read the FINALIZED `discord_guild_id` straight from `instance_settings`
 * (codex round-4 finding #1).
 *
 * The verification→full-boot transition cannot rely on loadConfigFromDatabase()
 * to surface a guild the owner picked during finalize: that loader only fills
 * env vars that are MISSING (see config-loader.ts `if (!process.env[envVar])`).
 * When the launcher started the bot with `DISCORD_GUILD_ID` already in env and
 * the dashboard finalize submits a DIFFERENT guild, the loader leaves the stale
 * env value in place, so the transition would heartbeat/initialize the wrong
 * primary guild (or fail primary init if the bot is not in the old guild) until
 * a manual restart.
 *
 * Reading the row directly lets the transition honor the finalized value
 * regardless of what is cached in env. Returns the trimmed non-blank guild id,
 * or null when the row is absent/blank or the read fails (the caller then keeps
 * whatever guild it already resolved rather than clobbering it on a blip).
 *
 * Multi-guild note: mirrors getPrimaryDiscordGuildId — the stored value may be a
 * comma-separated list, so we take the first non-blank entry as the primary.
 */
export async function resolveFinalizedGuildId(
  supabase: SupabaseClient,
): Promise<string | null> {
  try {
    const { data, error } = (await supabase
      .from('instance_settings')
      .select('value')
      .eq('key', 'discord_guild_id')
      .maybeSingle()) as { data: { value: string | null } | null; error: unknown };
    if (error) {
      log.warn('Failed reading finalized discord_guild_id (keeping current)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const raw = typeof data?.value === 'string' ? data.value : '';
    const primary = raw
      .split(',')
      .map((part) => part.trim())
      .find(Boolean);
    return primary && primary.length > 0 ? primary : null;
  } catch (err) {
    log.warn('Error reading finalized discord_guild_id (keeping current)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Write a minimal `type: 'health'` diagnostic row so the setup route's
 * Supabase readiness fallback (which checks for a fresh `health` snapshot
 * before trying Valkey) can prove the bot is online without Valkey. The full
 * DiagnosticsService writes a richer row in normal boot; here we only need the
 * (guild_id, type, snapshot_at) tuple the readiness check reads — every other
 * column has a schema default.
 *
 * Exported so the boot sequence can write an IMMEDIATE snapshot for a
 * newly-invited guild on the guildCreate verification path (codex round-3
 * finding #3) instead of waiting up to a full 60s refresher tick — otherwise,
 * with Valkey unavailable, the setup route can report guildDetected:true but
 * botOnline:false right after the invite and reject finalize.
 */
export async function writeVerificationHealthSnapshot(
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('bot_diagnostics')
      .upsert(
        {
          guild_id: guildId,
          type: 'health',
          snapshot_at: new Date().toISOString(),
        },
        { onConflict: 'guild_id,type' },
      );
    if (error) {
      log.warn('Verification health snapshot write failed', { guildId, error: error.message });
    }
  } catch (err) {
    log.warn('Verification health snapshot write error', {
      guildId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Handle returned from a verification boot so the boot sequence can stop every
 * periodic signal it started (heartbeat + the `health`-snapshot refresher)
 * when the bot transitions to full boot or shuts down.
 */
export interface SetupVerificationServices {
  heartbeat: HeartbeatService;
  /** Stop the periodic `health` diagnostic refresher started for verification. */
  stop(): void;
}

/**
 * Write a verification `health` snapshot for every guild the bot is currently
 * in. The setup route's Supabase readiness fallback
 * (getOwnerRuntimeReadiness) looks up `bot_diagnostics` by the *configured*
 * guild id — which is not necessarily `primaryGuildId` when the bot is in
 * several guilds and the owner is setting up a non-primary one. Writing a row
 * per current guild guarantees the configured guild is covered whichever one
 * it is, and reading membership live means a guild the bot has since left is
 * no longer refreshed (its last row goes stale and the readiness check trusts
 * it for at most the 5-minute freshness window).
 */
async function refreshHealthForCurrentGuilds(client: SomniClient): Promise<void> {
  const guildIds = Array.from(client.guilds.cache.keys());
  for (const guildId of guildIds) {
    await writeVerificationHealthSnapshot(client.supabase, guildId);
  }
}

/**
 * Bring the bot online in verification-only mode. Writes the guild record(s),
 * starts the bot-level heartbeat, and writes/refreshes a `health` diagnostic
 * row so the setup wizard can confirm the bot is reachable — via Valkey OR its
 * Supabase fallback. Returns the started services so the boot sequence can stop
 * them on transition/shutdown, or null if there is no guild to verify.
 */
export async function runSetupVerificationBoot(
  client: SomniClient,
): Promise<SetupVerificationServices | null> {
  const guilds = client.guilds.cache;
  if (guilds.size === 0) {
    log.warn('No guild yet — invite the bot so the setup wizard can verify it, then it will appear online');
    // Still start a heartbeat (with an empty guild list) so the launcher sees
    // the process is alive; the wizard's guild check will pass once invited.
  }

  // Resolve a primary guild id for the heartbeat's Supabase fallback row.
  const primaryGuildId = client.guildId || guilds.first()?.id || '';
  if (!client.guildId && primaryGuildId) {
    // PROVISIONAL assignment — deliberately a plain writable set, NOT a frozen
    // defineProperty (codex round-3 finding #2). Verification mode picks the
    // first cached guild only so the heartbeat/health signals have a guild id;
    // the owner may finalize setup with a DIFFERENT guild (the setup route
    // supports an explicitly configured guild id, and verification writes
    // health for every guild precisely because of that). The
    // verification→full-boot transition re-resolves the finalized
    // DISCORD_GUILD_ID after reloading config and overwrites this value;
    // freezing it here would make that overwrite throw (strict-mode ESM) and
    // anchor the bot-level services (heartbeat, presence, deploy fallback,
    // first-boot DM) to the wrong guild until a manual restart.
    client.guildId = primaryGuildId;
    log.info('Auto-detected guild for setup verification (provisional until setup finalizes)', {
      guildId: primaryGuildId,
    });
    // Persist the detected guild so the dashboard setup route can resolve it as
    // the configured guild (it falls back to instance_settings.discord_guild_id
    // when DISCORD_GUILD_ID is unset — which is exactly this auto-detect case —
    // and reports guildDetected:false without it). See persistDetectedGuildId.
    await persistDetectedGuildId(client.supabase, primaryGuildId);
  }

  // Write the guild record for every guild the bot is currently in so the
  // wizard detects whichever guild the owner configured.
  for (const [, guild] of guilds) {
    try {
      await writeGuildRecord(guild, client.supabase);
    } catch (err) {
      log.warn('Guild record write failed during setup verification', {
        guildId: guild.id,
        error: String(err),
      });
    }
  }

  if (!primaryGuildId) return null;

  // Start the bot-level heartbeat — the Valkey key the wizard's "bot online"
  // readiness check consumes first.
  const heartbeat = new HeartbeatService(client.valkey, client.supabase, primaryGuildId, client);
  heartbeat.start();

  // Also write a `health` diagnostic so the wizard's Supabase readiness
  // fallback works when Valkey is unreachable from the dashboard. The readiness
  // check reads the row for the *configured* guild (which may not be the
  // primary one), so we write a row per current guild — see
  // refreshHealthForCurrentGuilds. Refresh on a cadence comfortably inside the
  // readiness check's 5-minute freshness window, re-reading membership each
  // tick so a guild the bot has been removed from stops being refreshed.
  await refreshHealthForCurrentGuilds(client);
  const healthTimer = setInterval(() => {
    void refreshHealthForCurrentGuilds(client);
  }, VERIFY_HEALTH_INTERVAL_MS);
  healthTimer.unref?.();

  log.info('Setup-verification signals started — wizard can now confirm the bot is online (Valkey + Supabase fallback)');

  return {
    heartbeat,
    stop() {
      clearInterval(healthTimer);
      heartbeat.stop();
    },
  };
}
