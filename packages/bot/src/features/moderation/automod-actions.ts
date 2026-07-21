/**
 * Auto-Mod Actions — Execute the configured action for a rule violation.
 *
 * Each auto-mod rule has a configured action: delete, warn, mute, kick, ban.
 * This module handles executing that action + logging + infraction recording.
 *
 * Architecture doc §18.2
 */

import type { Message } from 'discord.js';
import type { SomniClient } from '../../client.js';
import type { DbAutomodRule, EscalationStep } from '@somnibot/shared';
import {
  createInfraction,
  getActiveWarningCount,
  calculateExpiryDate,
} from './infraction-service.js';
import { executeEscalation } from './escalation.js';
import { postModLogEntry } from './mod-log.js';
import { writeAuditLog } from '../../services/audit.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('AutoModActions');

/**
 * Execute the action configured for an auto-mod rule violation.
 */
export async function executeAutoModAction(
  client: SomniClient,
  message: Message,
  rule: DbAutomodRule,
  violationReason: string,
  modConfig: {
    escalationChain: EscalationStep[];
    infractionExpiryDays: number;
    modLogChannelId: string | null;
    automodEnabled: boolean;
    automodMode: 'observe' | 'enforce';
  },
): Promise<void> {
  const member = message.member;
  if (!member) return;

  const fullReason = `[Auto-Mod: ${rule.name}] ${violationReason}`;

  // Observe-only mode (the shipped default): record the would-be violation and
  // touch NOTHING — no delete, timeout, kick, ban, or infraction. Enforcement runs
  // only in 'enforce' mode, after the owner explicitly opts in.
  if (modConfig.automodMode !== 'enforce') {
    try {
      await postModLogEntry(client, {
        action: rule.action,
        member,
        moderator: 'System (Auto-Mod — OBSERVE, no action taken)',
        reason: `[observe] would ${rule.action}: ${fullReason}`,
        channelId: modConfig.modLogChannelId,
        ruleType: rule.type,
      });
    } catch (err) {
      log.error('Failed to post observe mod-log entry:', err);
    }
    try {
      await writeAuditLog(client.supabase, {
        guildId: message.guild!.id,
        actorType: 'bot',
        actorId: 'automod',
        action: `automod.observe.${rule.action}`,
        targetType: 'message',
        targetId: message.id,
        details: {
          rule: rule.name,
          ruleType: rule.type,
          violation: violationReason,
          wouldAction: rule.action,
          channelId: message.channel.id,
        },
      });
    } catch (err) {
      log.error('Failed to write observe audit log:', err);
    }
    return;
  }

  // Always try to delete the offending message (except 'warn'-only with no delete)
  if (rule.action !== 'warn') {
    try {
      if (message.deletable) {
        await message.delete();
      }
    } catch (err) {
      log.error(`Failed to delete message:`, err);
    }
  }

  switch (rule.action) {
    case 'delete': {
      // Delete only — no infraction, but delete the message
      try {
        if (message.deletable) {
          await message.delete();
        }
      } catch {
        // Already deleted or can't delete
      }

      if (rule.log_to_mod_channel) {
        await postModLogEntry(client, {
          action: 'delete',
          member,
          moderator: 'System (Auto-Mod)',
          reason: fullReason,
          channelId: modConfig.modLogChannelId,
          ruleType: rule.type,
        });
      }

      await writeAuditLog(client.supabase, {
        guildId: message.guild!.id,
        actorType: 'bot',
        actorId: 'automod',
        action: 'automod.delete',
        targetType: 'message',
        targetId: message.id,
        details: {
          rule: rule.name,
          ruleType: rule.type,
          violation: violationReason,
          channelId: message.channel.id,
        },
      });
      break;
    }

    case 'warn': {
      // Create warning infraction
      const infraction = await createInfraction(client.supabase, {
        guildId: message.guild!.id,
        memberId: member.id,
        moderatorId: 'system',
        type: 'warn',
        reason: fullReason,
        automodRuleId: rule.id,
        expiresAt: calculateExpiryDate(modConfig.infractionExpiryDays),
      });

      if (!infraction) {
        log.error('Failed to persist auto-mod warning; suppressing follow-on event and escalation');
        break;
      }

      const activeWarnings = await getActiveWarningCount(
        client.supabase,
        message.guild!.id,
        member.id,
      );

      // Emit infraction event
      client.eventBus.emit('infraction.created', message.guild!.id, {
        infractionId: infraction.id,
        userId: member.id,
        moderatorId: 'system',
        type: 'warn',
        reason: fullReason,
        totalInfractions: activeWarnings,
        autoModRuleId: rule.id,
      });

      // Check escalation chain
      await executeEscalation(client, member, fullReason, modConfig);

      if (rule.log_to_mod_channel) {
        const chain = modConfig.escalationChain.length > 0
          ? modConfig.escalationChain
          : undefined;
        const nextStep = chain
          ? chain.sort((a, b) => a.threshold - b.threshold).find((s) => s.threshold > activeWarnings)
          : undefined;
        const nextEsc = nextStep
          ? `${nextStep.action === 'mute' ? `Mute (${nextStep.durationMinutes ?? 60}m)` : nextStep.action.charAt(0).toUpperCase() + nextStep.action.slice(1)} at ${nextStep.threshold} warnings`
          : null;

        await postModLogEntry(client, {
          action: 'warn',
          member,
          moderator: 'System (Auto-Mod)',
          reason: fullReason,
          activeWarnings,
          nextEscalation: nextEsc,
          channelId: modConfig.modLogChannelId,
          ruleType: rule.type,
        });
      }

      await writeAuditLog(client.supabase, {
        guildId: message.guild!.id,
        actorType: 'bot',
        actorId: 'automod',
        action: 'automod.warn',
        targetType: 'member',
        targetId: member.id,
        details: {
          rule: rule.name,
          ruleType: rule.type,
          violation: violationReason,
          infractionId: infraction?.id,
          activeWarnings,
        },
      });
      break;
    }

    case 'mute': {
      const durationMinutes = rule.mute_duration_minutes ?? 5;
      const durationMs = durationMinutes * 60 * 1000;

      try {
        await member.timeout(durationMs, fullReason);
      } catch (err) {
        log.error(`Failed to timeout member:`, err);
      }

      await createInfraction(client.supabase, {
        guildId: message.guild!.id,
        memberId: member.id,
        moderatorId: 'system',
        type: 'mute',
        reason: fullReason,
        automodRuleId: rule.id,
        durationMinutes,
        expiresAt: calculateExpiryDate(modConfig.infractionExpiryDays),
      });

      client.eventBus.emit('member.muted', message.guild!.id, {
        discordId: member.id,
        moderatorId: 'system',
        reason: fullReason,
        durationMinutes,
      });

      if (rule.log_to_mod_channel) {
        await postModLogEntry(client, {
          action: 'mute',
          member,
          moderator: 'System (Auto-Mod)',
          reason: fullReason,
          duration: durationMinutes,
          channelId: modConfig.modLogChannelId,
          ruleType: rule.type,
        });
      }

      await writeAuditLog(client.supabase, {
        guildId: message.guild!.id,
        actorType: 'bot',
        actorId: 'automod',
        action: 'automod.mute',
        targetType: 'member',
        targetId: member.id,
        details: {
          rule: rule.name,
          ruleType: rule.type,
          violation: violationReason,
          durationMinutes,
        },
      });
      break;
    }

    case 'kick': {
      // DM before kick
      try {
        await member.send(
          `You have been **kicked** from **${member.guild.name}** by Auto-Mod.\n**Reason:** ${fullReason}`,
        );
      } catch {
        // DMs disabled
      }

      try {
        await member.kick(fullReason);
      } catch (err) {
        log.error(`Failed to kick member:`, err);
      }

      await createInfraction(client.supabase, {
        guildId: message.guild!.id,
        memberId: member.id,
        moderatorId: 'system',
        type: 'kick',
        reason: fullReason,
        automodRuleId: rule.id,
        expiresAt: calculateExpiryDate(modConfig.infractionExpiryDays),
      });

      client.eventBus.emit('member.kicked', message.guild!.id, {
        discordId: member.id,
        moderatorId: 'system',
        reason: fullReason,
      });

      if (rule.log_to_mod_channel) {
        await postModLogEntry(client, {
          action: 'kick',
          member,
          moderator: 'System (Auto-Mod)',
          reason: fullReason,
          channelId: modConfig.modLogChannelId,
          ruleType: rule.type,
        });
      }

      await writeAuditLog(client.supabase, {
        guildId: message.guild!.id,
        actorType: 'bot',
        actorId: 'automod',
        action: 'automod.kick',
        targetType: 'member',
        targetId: member.id,
        details: { rule: rule.name, ruleType: rule.type, violation: violationReason },
      });
      break;
    }

    case 'ban': {
      // DM before ban
      try {
        await member.send(
          `You have been **banned** from **${member.guild.name}** by Auto-Mod.\n**Reason:** ${fullReason}`,
        );
      } catch {
        // DMs disabled
      }

      try {
        await member.ban({ reason: fullReason, deleteMessageSeconds: 0 });
      } catch (err) {
        log.error(`Failed to ban member:`, err);
      }

      await createInfraction(client.supabase, {
        guildId: message.guild!.id,
        memberId: member.id,
        moderatorId: 'system',
        type: 'ban',
        reason: fullReason,
        automodRuleId: rule.id,
        expiresAt: calculateExpiryDate(modConfig.infractionExpiryDays),
      });

      client.eventBus.emit('member.banned', message.guild!.id, {
        discordId: member.id,
        moderatorId: 'system',
        reason: fullReason,
      });

      if (rule.log_to_mod_channel) {
        await postModLogEntry(client, {
          action: 'ban',
          member,
          moderator: 'System (Auto-Mod)',
          reason: fullReason,
          channelId: modConfig.modLogChannelId,
          ruleType: rule.type,
        });
      }

      await writeAuditLog(client.supabase, {
        guildId: message.guild!.id,
        actorType: 'bot',
        actorId: 'automod',
        action: 'automod.ban',
        targetType: 'member',
        targetId: member.id,
        details: { rule: rule.name, ruleType: rule.type, violation: violationReason },
      });
      break;
    }
  }
}
