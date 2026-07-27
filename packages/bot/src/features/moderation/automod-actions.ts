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
import { createLogger } from '@somnibot/shared';

const log = createLogger('AutoModActions');

/**
 * Record an APPLIED auto-mod action on the append-only trail (rail A — the
 * batched event rail; AuditService maps `automod.enforced` to the
 * `automod.<action>` row). Auto-mod evaluates every message, so this is the
 * hottest audit writer in the bot: batching it keeps a per-message DB insert
 * out of the message pipeline, and the message id doubles as the occurrence
 * key so a redelivered messageCreate cannot write the row twice.
 */
function emitEnforced(
  client: SomniClient,
  message: Message,
  memberId: string,
  rule: DbAutomodRule,
  violationReason: string,
  action: 'delete' | 'warn' | 'mute' | 'kick' | 'ban',
  extra: { infractionId?: string; activeWarnings?: number; durationMinutes?: number } = {},
): void {
  client.eventBus.emit('automod.enforced', message.guild!.id, {
    messageId: message.id,
    channelId: message.channel.id,
    memberId,
    rule: rule.name,
    ruleType: rule.type,
    violation: violationReason,
    action,
    ...extra,
  });
}

/**
 * Execute the action configured for an auto-mod rule violation.
 *
 * Returns whether the violation was actually ENFORCED (delete / warn / mute /
 * kick / ban applied). Observe-mode matches log the would-be action and
 * return false, so the caller's message pipeline (XP, quests, achievements,
 * economy) keeps running — observing must never silently eat activity.
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
): Promise<boolean> {
  const member = message.member;
  if (!member) return false;

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
    client.eventBus.emit('automod.observed', message.guild!.id, {
      messageId: message.id,
      channelId: message.channel.id,
      memberId: member.id,
      rule: rule.name,
      ruleType: rule.type,
      violation: violationReason,
      wouldAction: rule.action,
    });
    return false; // nothing enforced — the message pipeline must continue
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
      // Delete only — no infraction. The message was already deleted by the
      // shared pre-switch block above (runs for every non-'warn' action), so no
      // second delete() call is issued here.
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

      emitEnforced(client, message, member.id, rule, violationReason, 'delete');
      break;
    }

    case 'warn': {
      // Create warning infraction. message.id is the correlation key (M3): the
      // automod engine executes at most one rule per message, and a gateway
      // RESUME can re-deliver the same messageCreate — the replay dedups here.
      const created = await createInfraction(client.supabase, {
        guildId: message.guild!.id,
        memberId: member.id,
        moderatorId: 'system',
        type: 'warn',
        reason: fullReason,
        automodRuleId: rule.id,
        expiresAt: calculateExpiryDate(modConfig.infractionExpiryDays),
        correlationId: message.id,
      });

      if (!created) {
        log.error('Failed to persist auto-mod warning; suppressing follow-on event and escalation');
        // Nothing was enforced ('warn' skips the delete and the infraction
        // never landed) — let the message pipeline continue.
        return false;
      }

      // Replayed message delivery — the original run already emitted the
      // event, ran escalation, and mod-logged. Skip the whole block.
      if (created.replayed) {
        log.info(`Replayed auto-mod warn for message ${message.id} — side effects skipped`);
        break;
      }
      const infraction = created.infraction;

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

      // Check escalation chain — keyed on the source warn infraction so a
      // replayed source cannot re-escalate ('escalation:<sourceInfractionId>').
      await executeEscalation(client, member, fullReason, modConfig, infraction.id);

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

      emitEnforced(client, message, member.id, rule, violationReason, 'warn', {
        infractionId: infraction?.id,
        activeWarnings,
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

      const created = await createInfraction(client.supabase, {
        guildId: message.guild!.id,
        memberId: member.id,
        moderatorId: 'system',
        type: 'mute',
        reason: fullReason,
        automodRuleId: rule.id,
        durationMinutes,
        expiresAt: calculateExpiryDate(modConfig.infractionExpiryDays),
        correlationId: message.id,
      });

      // Replayed message delivery — skip duplicate event/mod-log/audit (M3).
      if (created?.replayed) {
        log.info(`Replayed auto-mod mute for message ${message.id} — side effects skipped`);
        break;
      }

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

      emitEnforced(client, message, member.id, rule, violationReason, 'mute', { durationMinutes });
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

      const created = await createInfraction(client.supabase, {
        guildId: message.guild!.id,
        memberId: member.id,
        moderatorId: 'system',
        type: 'kick',
        reason: fullReason,
        automodRuleId: rule.id,
        expiresAt: calculateExpiryDate(modConfig.infractionExpiryDays),
        correlationId: message.id,
      });

      // Replayed message delivery — skip duplicate event/mod-log/audit (M3).
      if (created?.replayed) {
        log.info(`Replayed auto-mod kick for message ${message.id} — side effects skipped`);
        break;
      }

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

      emitEnforced(client, message, member.id, rule, violationReason, 'kick');
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

      const created = await createInfraction(client.supabase, {
        guildId: message.guild!.id,
        memberId: member.id,
        moderatorId: 'system',
        type: 'ban',
        reason: fullReason,
        automodRuleId: rule.id,
        expiresAt: calculateExpiryDate(modConfig.infractionExpiryDays),
        correlationId: message.id,
      });

      // Replayed message delivery — skip duplicate event/mod-log/audit (M3).
      if (created?.replayed) {
        log.info(`Replayed auto-mod ban for message ${message.id} — side effects skipped`);
        break;
      }

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

      emitEnforced(client, message, member.id, rule, violationReason, 'ban');
      break;
    }
  }

  return true; // enforcement applied
}
