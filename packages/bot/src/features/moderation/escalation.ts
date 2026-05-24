/**
 * Escalation Chain — Auto-escalate punishment based on infraction count.
 *
 * Checks active warning count against configurable thresholds.
 * Default: 1-2 warn, 3 mute(1h), 4 mute(24h), 5 kick, 6+ ban.
 *
 * Architecture doc §18.4
 */

import type { GuildMember } from 'discord.js';
import type { SomniClient } from '../../client.js';
import type { EscalationStep, InfractionType } from '@somnibot/shared';
import { DEFAULT_ESCALATION_CHAIN , createLogger } from '@somnibot/shared';
import {
  createInfraction,
  getActiveWarningCount,
  getActiveInfractionCount,
  calculateExpiryDate,
} from './infraction-service.js';
import { postModLogEntry } from './mod-log.js';
import { writeAuditLog } from '../../services/audit.js';

const log = createLogger('Escalation');

/**
 * Determine the escalation action for a given active warning count.
 */
export function getEscalationAction(
  chain: EscalationStep[],
  activeWarnings: number,
): EscalationStep | null {
  if (!chain || chain.length === 0) return null;

  // Sort by threshold descending, find the highest matching step
  const sorted = [...chain].sort((a, b) => b.threshold - a.threshold);
  for (const step of sorted) {
    if (activeWarnings >= step.threshold) {
      return step;
    }
  }

  return null;
}

/**
 * Execute the escalation chain after a new warning is issued.
 *
 * Flow:
 * 1. Count active warnings
 * 2. Find matching escalation step
 * 3. If action is more severe than 'warn', execute it
 * 4. Create the escalation infraction
 * 5. Post to mod log
 * 6. DM member if configured
 */
export async function executeEscalation(
  client: SomniClient,
  member: GuildMember,
  reason: string,
  config: {
    escalationChain: EscalationStep[];
    infractionExpiryDays: number;
    modLogChannelId: string | null;
  },
): Promise<{ action: InfractionType; durationMinutes?: number } | null> {
  // Count ALL active infractions, not just warns — a mute/kick should also
  // push the user closer to escalation thresholds (matches MEE6/Dyno behavior).
  const activeWarnings = await getActiveInfractionCount(
    client.supabase,
    member.guild.id,
    member.id,
  );

  const chain = config.escalationChain.length > 0
    ? config.escalationChain
    : DEFAULT_ESCALATION_CHAIN;

  const step = getEscalationAction(chain, activeWarnings);
  if (!step || step.action === 'warn') {
    // No escalation needed — already warned
    return null;
  }

  const escalationReason = `Escalation: ${activeWarnings} active warning(s). Original: ${reason}`;

  try {
    switch (step.action) {
      case 'mute': {
        const durationMs = (step.durationMinutes ?? 60) * 60 * 1000;
        await member.timeout(durationMs, escalationReason);

        // DM member
        if (step.dmMember) {
          await dmMember(member, 'muted', escalationReason, step.durationMinutes);
        }

        // Create infraction record
        await createInfraction(client.supabase, {
          guildId: member.guild.id,
          memberId: member.id,
          moderatorId: 'system',
          type: 'mute',
          reason: escalationReason,
          durationMinutes: step.durationMinutes,
          expiresAt: calculateExpiryDate(config.infractionExpiryDays),
        });

        // Emit event
        client.eventBus.emit('member.muted', member.guild.id, {
          discordId: member.id,
          moderatorId: 'system',
          reason: escalationReason,
          durationMinutes: step.durationMinutes ?? 60,
        });

        // Post to mod log
        await postModLogEntry(client, {
          action: 'mute',
          member,
          moderator: 'System (Escalation)',
          reason: escalationReason,
          duration: step.durationMinutes,
          activeWarnings,
          nextEscalation: getNextEscalation(chain, activeWarnings),
          channelId: config.modLogChannelId,
        });

        log.info(`Escalation: muted ${member.user.tag} for ${step.durationMinutes}m`);
        return { action: 'mute', durationMinutes: step.durationMinutes };
      }

      case 'kick': {
        // DM before kick (can't DM after)
        if (step.dmMember) {
          await dmMember(member, 'kicked', escalationReason);
        }

        await member.kick(escalationReason);

        await createInfraction(client.supabase, {
          guildId: member.guild.id,
          memberId: member.id,
          moderatorId: 'system',
          type: 'kick',
          reason: escalationReason,
          expiresAt: calculateExpiryDate(config.infractionExpiryDays),
        });

        client.eventBus.emit('member.kicked', member.guild.id, {
          discordId: member.id,
          moderatorId: 'system',
          reason: escalationReason,
        });

        await postModLogEntry(client, {
          action: 'kick',
          member,
          moderator: 'System (Escalation)',
          reason: escalationReason,
          activeWarnings,
          channelId: config.modLogChannelId,
        });

        log.info(`Escalation: kicked ${member.user.tag}`);
        return { action: 'kick' };
      }

      case 'ban': {
        // DM before ban (can't DM after)
        if (step.dmMember) {
          await dmMember(member, 'banned', escalationReason);
        }

        await member.ban({ reason: escalationReason, deleteMessageSeconds: 0 });

        // Suspend entitlements (commerce interaction §18.6)
        await suspendEntitlements(client, member.guild.id, member.id);

        await createInfraction(client.supabase, {
          guildId: member.guild.id,
          memberId: member.id,
          moderatorId: 'system',
          type: 'ban',
          reason: escalationReason,
          expiresAt: calculateExpiryDate(config.infractionExpiryDays),
        });

        client.eventBus.emit('member.banned', member.guild.id, {
          discordId: member.id,
          moderatorId: 'system',
          reason: escalationReason,
        });

        await postModLogEntry(client, {
          action: 'ban',
          member,
          moderator: 'System (Escalation)',
          reason: escalationReason,
          activeWarnings,
          channelId: config.modLogChannelId,
        });

        log.info(`Escalation: banned ${member.user.tag}`);
        return { action: 'ban' };
      }
    }
  } catch (err) {
    log.error(`Escalation failed for ${member.user.tag}:`, err);

    await writeAuditLog(client.supabase, {
      guildId: member.guild.id,
      actorType: 'bot',
      actorId: client.user?.id ?? 'unknown',
      action: `escalation.${step.action}.failed`,
      targetType: 'member',
      targetId: member.id,
      details: { error: String(err), activeWarnings },
      success: false,
      errorMessage: String(err),
    });
  }

  return null;
}

/**
 * Get next escalation description for mod log.
 */
function getNextEscalation(
  chain: EscalationStep[],
  currentWarnings: number,
): string | null {
  const sorted = [...chain].sort((a, b) => a.threshold - b.threshold);
  const next = sorted.find((s) => s.threshold > currentWarnings);
  if (!next) return null;

  const label = next.action === 'mute'
    ? `Mute (${next.durationMinutes ?? 60}m)`
    : next.action.charAt(0).toUpperCase() + next.action.slice(1);

  return `${label} at ${next.threshold} warnings`;
}

/**
 * DM a member about a moderation action.
 * Fails silently — members can have DMs disabled.
 */
async function dmMember(
  member: GuildMember,
  action: string,
  reason: string,
  durationMinutes?: number,
): Promise<void> {
  try {
    const guildName = member.guild.name;
    let message = `You have been **${action}** in **${guildName}**.\n\n**Reason:** ${reason}`;
    if (action === 'muted' && durationMinutes) {
      const hours = Math.floor(durationMinutes / 60);
      const mins = durationMinutes % 60;
      const durationStr = hours > 0
        ? `${hours}h${mins > 0 ? ` ${mins}m` : ''}`
        : `${mins}m`;
      message += `\n**Duration:** ${durationStr}`;
    }
    await member.send(message);
  } catch {
    // DMs disabled — fail silently
  }
}

/**
 * Suspend entitlements when a member is banned.
 * Sets entitlement status to 'suspended' without revoking.
 * Architecture doc §18.6
 */
async function suspendEntitlements(
  client: SomniClient,
  guildId: string,
  memberId: string,
): Promise<void> {
  try {
    // Entitlements are linked via customer_id (UUID), not directly by Discord ID.
    // Look up the customer first, then suspend their entitlements.
    const { data: customer } = await client.supabase
      .from('customers')
      .select('id')
      .eq('guild_id', guildId)
      .eq('discord_id', memberId)
      .maybeSingle();

    if (!customer) return; // No customer record — nothing to suspend

    const { data, error } = await client.supabase
      .from('entitlements')
      .update({ status: 'suspended', updated_at: new Date().toISOString() })
      .eq('guild_id', guildId)
      .eq('customer_id', customer.id)
      .eq('status', 'active')
      .select('id')
      .limit(1000);

    if (error) {
      // Table might not exist yet (pre-commerce phase)
      if (error.code !== '42P01') {
        log.error('Failed to suspend entitlements:', error.message);
      }
      return;
    }

    if (data && data.length > 0) {
      log.info(`Suspended ${data.length} entitlement(s) for banned member ${memberId}`);
    }
  } catch {
    // Commerce tables may not exist yet
  }
}
