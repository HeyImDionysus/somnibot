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
 * Write a minimal `type: 'health'` diagnostic row so the setup route's
 * Supabase readiness fallback (which checks for a fresh `health` snapshot
 * before trying Valkey) can prove the bot is online without Valkey. The full
 * DiagnosticsService writes a richer row in normal boot; here we only need the
 * (guild_id, type, snapshot_at) tuple the readiness check reads — every other
 * column has a schema default.
 */
async function writeVerificationHealthSnapshot(
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
    Object.defineProperty(client, 'guildId', { value: primaryGuildId, writable: false });
    log.info('Auto-detected guild for setup verification', { guildId: primaryGuildId });
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
  // fallback works when Valkey is unreachable from the dashboard. Refresh it
  // on the same cadence the readiness check's 5-minute freshness window
  // expects to stay comfortably fresh.
  await writeVerificationHealthSnapshot(client.supabase, primaryGuildId);
  const healthTimer = setInterval(() => {
    void writeVerificationHealthSnapshot(client.supabase, primaryGuildId);
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
