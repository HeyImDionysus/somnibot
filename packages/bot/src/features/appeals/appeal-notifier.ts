/**
 * Appeal Notifier — delivers the "your appeal was decided" DM and runs the
 * periodic appeals maintenance sweep (expiry + one-shot DM delivery).
 *
 * Decisions are recorded on the dashboard (a separate process with no Discord
 * gateway), so the DM cannot be sent inline at decision time. Instead the bot
 * sweeps decided-but-unnotified appeals and DMs each appellant exactly once,
 * guarded by the `decision_notified` latch. A member with closed DMs (or who
 * has left) is a terminal delivery — we still flip the latch so we do not retry
 * forever; a transient error leaves the latch unset so the next sweep retries.
 */

import { EmbedBuilder } from 'discord.js';
import { SOMNI_PALETTE, createLogger } from '@somnibot/shared';
import type { SomniClient } from '../../client.js';
import { AppealsManager, type AppealRecord } from './appeals-manager.js';

const log = createLogger('Appeals');

/** Approved appeals show a success-green; denied/other show the warning accent. */
const APPROVED_COLOR = 0x57f287;

/**
 * Discord API error codes for which a DM can NEVER be delivered to this user, so
 * retrying is pointless — flip the latch. (Cannot send to this user / unknown
 * user / opened a DM but blocked.)
 */
const TERMINAL_DM_CODES = new Set<number>([50007, 10013, 10007]);

function errorCode(err: unknown): number | null {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'number' ? code : null;
}

/**
 * Build the decision DM embed. Pure — unit tested directly.
 */
export function buildDecisionDmEmbed(appeal: AppealRecord, guildName: string): EmbedBuilder {
  const approved = appeal.status === 'approved';
  const embed = new EmbedBuilder()
    .setColor(approved ? APPROVED_COLOR : SOMNI_PALETTE.ORANGE)
    .setTitle(approved ? '✅ Appeal Approved' : '❌ Appeal Denied')
    .setDescription(
      approved
        ? `Your appeal in **${guildName}** has been **approved**. A moderator will review any actions tied to the original infraction.`
        : `Your appeal in **${guildName}** has been **denied**. The original infraction stands.`,
    )
    .addFields({ name: 'Your appeal reason', value: truncate(appeal.reason, 1000) })
    .setTimestamp(appeal.decided_at ? new Date(appeal.decided_at) : new Date());
  return embed;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Attempt to DM the appellant the outcome of a single decided appeal.
 *
 * Returns:
 *  - 'delivered'  — the DM went through.
 *  - 'terminal'   — the user can never be DM'd (closed DMs / left / blocked).
 *  - 'transient'  — a retryable failure; the latch should NOT be flipped.
 *
 * Both 'delivered' and 'terminal' should flip `decision_notified`.
 */
export async function deliverDecisionDm(
  client: Pick<SomniClient, 'users'>,
  appeal: AppealRecord,
  guildName: string,
): Promise<'delivered' | 'terminal' | 'transient'> {
  try {
    const user = await client.users.fetch(appeal.appellant_discord_id);
    await user.send({ embeds: [buildDecisionDmEmbed(appeal, guildName)] });
    return 'delivered';
  } catch (err) {
    const code = errorCode(err);
    if (code !== null && TERMINAL_DM_CODES.has(code)) {
      log.info('Appeal decision DM undeliverable (terminal) — latch flipped', {
        appealId: appeal.id,
        code,
      });
      return 'terminal';
    }
    log.warn('Appeal decision DM failed (will retry)', {
      appealId: appeal.id,
      error: String(err),
    });
    return 'transient';
  }
}

/**
 * Deliver all pending decision DMs for one guild and flip the latch for each
 * delivered/terminal outcome. Returns the number of latches flipped.
 */
export async function deliverDecisionDmsForGuild(
  client: Pick<SomniClient, 'users'>,
  manager: AppealsManager,
  guildId: string,
  guildName: string,
): Promise<number> {
  const pending = await manager.collectUndeliveredDecisions(guildId);
  let flipped = 0;
  for (const appeal of pending) {
    const outcome = await deliverDecisionDm(client, appeal, guildName);
    if (outcome !== 'transient') {
      await manager.markDecisionNotified(appeal.id);
      flipped++;
    }
  }
  return flipped;
}

/**
 * Periodic maintenance across every live guild: expire stale pending appeals and
 * deliver any outstanding decision DMs. Wired into the bot's cron in handler.ts.
 */
export async function runAppealsMaintenance(client: SomniClient): Promise<void> {
  const manager = new AppealsManager(client.supabase);
  for (const ctx of client.router.all()) {
    try {
      await manager.sweepExpired(ctx.guildId);
      await deliverDecisionDmsForGuild(client, manager, ctx.guildId, ctx.guild.name);
    } catch (err) {
      log.error('Appeals maintenance error', { guildId: ctx.guildId, error: String(err) });
    }
  }
}
