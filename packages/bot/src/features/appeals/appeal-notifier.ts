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

import { EmbedBuilder, type Guild } from 'discord.js';
import { createLogger } from '@somnibot/shared';
import type { SomniClient } from '../../client.js';
import { AppealsManager, type AppealRecord } from './appeals-manager.js';
import { applyBrand, resolveBrandKit, type BrandKit } from '../branding/index.js';
import { pardonInfraction } from '../moderation/infraction-service.js';
import { writeAuditLog } from '../../services/audit.js';
import { raiseOwnerAlert } from '../../services/alert-service.js';

const log = createLogger('Appeals');

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
 *
 * Branded with the guild's white-label kit: approved renders with the brand
 * primary, denied with the derived warning intent, plus the powered-by
 * attribution footer when the owner leaves it on.
 */
export function buildDecisionDmEmbed(
  appeal: AppealRecord,
  guildName: string,
  kit: BrandKit,
): EmbedBuilder {
  const approved = appeal.status === 'approved';
  const embed = new EmbedBuilder()
    .setTitle(approved ? '✅ Appeal Approved' : '❌ Appeal Denied')
    .setDescription(
      approved
        ? `Your appeal in **${guildName}** has been **approved**. A moderator will review any actions tied to the original infraction.`
        : `Your appeal in **${guildName}** has been **denied**. The original infraction stands.`,
    )
    .addFields({ name: 'Your appeal reason', value: truncate(appeal.reason, 1000) })
    .setTimestamp(appeal.decided_at ? new Date(appeal.decided_at) : new Date());
  return applyBrand(embed, kit, { intent: approved ? 'primary' : 'warning' });
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
  kit: BrandKit,
): Promise<'delivered' | 'terminal' | 'transient'> {
  try {
    const user = await client.users.fetch(appeal.appellant_discord_id);
    await user.send({ embeds: [buildDecisionDmEmbed(appeal, guildName, kit)] });
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
  client: Pick<SomniClient, 'users' | 'supabase'>,
  manager: AppealsManager,
  guildId: string,
  guildName: string,
  guild?: Guild,
): Promise<number> {
  const pending = await manager.collectUndeliveredDecisions(guildId);
  if (pending.length === 0) return 0;
  // The appellant may be BANNED (guild cache useless for them) — the guild
  // name passed by the sweep is the fallback brand name. Kit resolved once
  // per guild sweep (cached; never throws).
  const kit = await resolveBrandKit(client.supabase, guildId, { fallbackName: guildName });
  let flipped = 0;
  for (const appeal of pending) {
    if (appeal.status === 'approved') {
      await applyApprovedAppeal(client, appeal, guildId, guildName, guild);
    }
    const outcome = await deliverDecisionDm(client, appeal, guildName, kit);
    if (outcome !== 'transient') {
      await manager.markDecisionNotified(appeal.id);
      flipped++;
    }
  }
  return flipped;
}

/**
 * An approved appeal is a moderation reversal, not just a status badge. Pardon
 * the durable infraction and lift the live Discord punishment where possible.
 * The operation is idempotent: the infraction update is harmless on a replay,
 * Discord timeout removal/unban are both safe to repeat, and the audit row is
 * occurrence-keyed. A failed live lift is surfaced to the owner and remains in
 * the decided queue for the next maintenance pass.
 */
async function applyApprovedAppeal(
  client: Pick<SomniClient, 'supabase' | 'users'>,
  appeal: AppealRecord,
  guildId: string,
  guildName: string,
  guild?: Guild,
): Promise<void> {
  try {
    const { data: infraction, error } = await client.supabase
      .from('infractions')
      .select('id, member_id, type')
      .eq('id', appeal.infraction_id)
      .eq('guild_id', guildId)
      .maybeSingle();
    if (error || !infraction) {
      await recordAppealLiftFailure(client.supabase, guildId, appeal, `infraction lookup failed: ${error?.message ?? 'not found'}`);
      return;
    }

    const pardoned = await pardonInfraction(
      client.supabase,
      appeal.infraction_id,
      appeal.reviewer_id ?? 'appeal-reviewer',
      guildId,
    );
    if (!pardoned) {
      await recordAppealLiftFailure(client.supabase, guildId, appeal, 'infraction could not be pardoned');
      return;
    }

    const member = guild
      ? await guild.members.fetch(infraction.member_id).catch(() => null)
      : null;
    let lifted = infraction.type === 'warn' || infraction.type === 'kick';
    if (infraction.type === 'mute' && member?.moderatable) {
      await member.timeout(null, `Appeal approved for infraction ${appeal.infraction_id}`);
      lifted = true;
    } else if (infraction.type === 'ban' && guild) {
      await guild.members.unban(
        infraction.member_id,
        `Appeal approved for infraction ${appeal.infraction_id}`,
      );
      lifted = true;
    }

    // Unlike warnings and kicks, a timeout/ban is a live Discord state that
    // must be removed as part of approval. Keep the decision auditable and
    // alert the owner when the bot cannot reach or control that member.
    if ((infraction.type === 'mute' || infraction.type === 'ban') && !lifted) {
      await recordAppealLiftFailure(
        client.supabase,
        guildId,
        appeal,
        `Discord ${infraction.type} could not be lifted (member unavailable or insufficient permissions)`,
      );
      return;
    }

    await writeAuditLog(client.supabase, {
      guildId,
      actorType: 'system',
      actorId: appeal.reviewer_id ?? 'appeal-reviewer',
      action: 'appeal.punishment_lifted',
      category: 'moderation',
      targetType: 'appeal',
      targetId: appeal.id,
      details: {
        infraction_id: appeal.infraction_id,
        member_id: infraction.member_id,
        infraction_type: infraction.type,
        live_lifted: lifted,
        guild_name: guildName,
      },
      occurrenceKey: `appeal:${appeal.id}:punishment-lifted`,
      success: true,
    });
  } catch (err) {
    await recordAppealLiftFailure(client.supabase, guildId, appeal, String(err));
  }
}

async function recordAppealLiftFailure(
  supabase: SomniClient['supabase'],
  guildId: string,
  appeal: AppealRecord,
  error: string,
): Promise<void> {
  await writeAuditLog(supabase, {
    guildId,
    actorType: 'system',
    actorId: appeal.reviewer_id ?? 'appeal-reviewer',
    action: 'appeal.punishment_lift_failed',
    category: 'moderation',
    targetType: 'appeal',
    targetId: appeal.id,
    details: { infraction_id: appeal.infraction_id, error },
    occurrenceKey: `appeal:${appeal.id}:punishment-lift-failed`,
    success: false,
    errorMessage: error,
  });
  await raiseOwnerAlert(supabase, guildId, {
    alertType: 'appeal_punishment_lift_failed',
    severity: 'warning',
    title: 'Approved appeal needs moderation cleanup',
    message: `Appeal ${appeal.id} was approved, but the original punishment could not be fully lifted. Check the infraction and Discord permissions.`,
    metadata: { appeal_id: appeal.id, infraction_id: appeal.infraction_id, error },
  }).catch(() => {});
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
      await deliverDecisionDmsForGuild(client, manager, ctx.guildId, ctx.guild.name, ctx.guild);
    } catch (err) {
      log.error('Appeals maintenance error', { guildId: ctx.guildId, error: String(err) });
    }
  }
}
