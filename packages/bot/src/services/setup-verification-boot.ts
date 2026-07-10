/**
 * Setup-Verification Boot (Wave 3 setup gate)
 *
 * When the setup gate reports 'in_progress' (Discord credentials exist but
 * setup is not finalized), the bot must come online *just enough* for the
 * dashboard setup wizard to verify it:
 *
 *   - the wizard's "guild detected" check reads the `guild` table row, and
 *   - the wizard's "bot online" check reads the bot-level heartbeat
 *     (`somnibot:heartbeat:bot`, whose payload includes the guild IDs) — see
 *     packages/dashboard/src/app/api/setup/route.ts::getOwnerRuntimeReadiness.
 *
 * This module writes exactly those two signals and nothing else. It does NOT
 * run the heavy per-guild feature init (GuildRouter, feature managers, timers,
 * command registration) that would spam errors while config is incomplete.
 *
 * Once the owner finalizes setup and the bot restarts, the gate reports
 * 'complete' and the normal full boot runs.
 */
import type { Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';
import type { SomniClient } from '../client.js';
import { HeartbeatService } from './heartbeat.js';

const log = createLogger('SetupVerify');

/**
 * Upsert the `guild` table row the setup wizard reads for "guild detected".
 * Mirrors the write in guild-init.ts but without any feature-init side effects.
 */
export async function writeGuildRecord(guild: Guild, supabase: SupabaseClient): Promise<void> {
  const botMember = guild.members.me;
  if (!botMember) return;

  const { error } = await supabase
    .from('guild')
    .upsert(
      {
        id: guild.id,
        name: guild.name,
        owner_discord_id: guild.ownerId,
        bot_role_position: botMember.roles.highest.position,
        total_roles: guild.roles.cache.size,
      },
      { onConflict: 'id' },
    );

  if (error) log.error('Failed to write guild record', { guildId: guild.id, error: error.message });
  else log.info('Guild record written for setup verification', { guildId: guild.id });
}

/**
 * Bring the bot online in verification-only mode. Writes the guild record(s)
 * and starts the bot-level heartbeat so the setup wizard can confirm the bot
 * is reachable. Returns the started HeartbeatService so the boot sequence can
 * stop it during graceful shutdown, or null if there is no guild to verify.
 */
export async function runSetupVerificationBoot(
  client: SomniClient,
): Promise<HeartbeatService | null> {
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

  // Start the bot-level heartbeat — this is the signal the wizard's
  // "bot online" readiness check consumes.
  const heartbeat = new HeartbeatService(client.valkey, client.supabase, primaryGuildId, client);
  heartbeat.start();
  log.info('Setup-verification heartbeat started — wizard can now confirm the bot is online');
  return heartbeat;
}
