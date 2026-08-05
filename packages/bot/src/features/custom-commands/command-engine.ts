/**
 * Custom Commands Engine — dynamic slash command registration and execution.
 *
 * Architecture doc §21
 */
import {
  REST,
  ChatInputCommandInteraction,
  EmbedBuilder,
  type Guild,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import type { DbCustomCommand } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';
import { eventBus } from '../../services/event-bus.js';
import { writeAuditLog } from '../../services/audit.js';
import { raiseOwnerAlert } from '../../services/alert-service.js';
import { defaultBrandKit, resolveBrandKit } from '../branding/brand-kit.js';
import { brandedEmbed } from '../branding/branded-embed.js';
import { voice } from '../branding/voice.js';

const log = createLogger('CommandEngine');

const COOLDOWN_PREFIX = 'cmd:cooldown';

interface CustomCommandAction {
  type: 'send_message' | 'send_embed' | 'give_role' | 'remove_role' | 'send_dm';
  message?: string;
  channelId?: string;
  embedConfig?: {
    title?: string;
    description?: string;
    color?: number;
    fields?: { name: string; value: string; inline: boolean }[];
    image_url?: string;
    thumbnail_url?: string;
    footer_text?: string;
  };
  roleId?: string;
}

/**
 * Guild-scoped registry of loaded custom commands.
 * Outer key: guildId, inner key: command name.
 *
 * V10 Audit C-2: Previously a flat Map<name, cmd>. loadCustomCommands()
 * called .clear() before repopulating — when guild B initialized it wiped
 * guild A's entire command registry, silently breaking all custom commands
 * for every guild except the most-recently-initialized one.
 */
const commandRegistry = new Map<string, Map<string, DbCustomCommand>>();

/**
 * Load all custom commands from Supabase into the in-memory registry
 * and return their JSON bodies for inclusion in the bulk PUT.
 *
 * FIX #15: Previously registered custom commands via individual POST,
 * but registerGuildCommands() then did a bulk PUT with only built-in
 * commands — overwriting custom commands on every restart. Now we
 * return the command JSON so it's merged into allCommands before the
 * single bulk PUT.
 */
export async function loadCustomCommands(
  supabase: SupabaseClient,
  guild: Guild,
  _rest: REST,
): Promise<{ name: string; description: string; type: number }[]> {
  let maxCommands = 1000;
  try {
    const { data: config } = await supabase
      .from('guild_config')
      .select('custom_commands_max_per_guild')
      .eq('guild_id', guild.id)
      .maybeSingle();
    const configured = Number(config?.custom_commands_max_per_guild);
    if (Number.isInteger(configured)) maxCommands = Math.max(1, Math.min(10000, configured));
  } catch (err) {
    log.warn('[CommandEngine] Using default custom command limit:', err);
  }
  const { data } = await supabase
    .from('custom_commands')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('enabled', true)
    .limit(maxCommands);

  // Build a fresh per-guild sub-map (replaces only this guild's commands)
  const guildMap = new Map<string, DbCustomCommand>();

  if (!data || data.length === 0) {
    commandRegistry.set(guild.id, guildMap);
    log.info('No custom commands found');
    return [];
  }

  // Populate per-guild registry for the interaction handler
  for (const cmd of data as DbCustomCommand[]) {
    guildMap.set(cmd.name, cmd);
  }
  commandRegistry.set(guild.id, guildMap);

  // Return command JSON bodies for the bulk PUT (merged into allCommands)
  const commandBodies = (data as DbCustomCommand[]).map((cmd) => ({
    name: cmd.name,
    description: cmd.description || 'Custom command',
    type: 1 as const, // CHAT_INPUT
  }));

  log.info(`Loaded ${data.length} custom commands into registry`);
  return commandBodies;
}

/**
 * Replace variables in a string.
 */
function replaceVariables(
  text: string,
  interaction: ChatInputCommandInteraction,
): string {
  return text
    .replace(/\{user\}/g, `<@${interaction.user.id}>`)
    .replace(/\{user\.name\}/g, interaction.user.username)
    .replace(/\{channel\}/g, `<#${interaction.channelId}>`)
    .replace(/\{server\}/g, interaction.guild?.name ?? 'Server')
    .replace(/\{memberCount\}/g, String(interaction.guild?.memberCount ?? 0));
}

/**
 * Try to handle an interaction as a custom command. Returns true if handled.
 */
export async function handleCustomCommand(
  interaction: ChatInputCommandInteraction,
  supabase: SupabaseClient,
  valkey: Valkey,
  guild: Guild,
): Promise<boolean> {
  const cmd = commandRegistry.get(guild.id)?.get(interaction.commandName);
  if (!cmd) return false;
  const brandKit = await resolveBrandKit(supabase, guild.id, { fallbackName: guild.name })
    .catch(() => defaultBrandKit(guild.name));

  // Check permissions: allowed roles
  if (cmd.allowed_roles.length > 0) {
    const member = interaction.member;
    if (member && 'roles' in member) {
      const memberRoles = member.roles instanceof Array
        ? member.roles
        : [...member.roles.cache.keys()];
      const hasAllowedRole = cmd.allowed_roles.some((r: string) => memberRoles.includes(r));
      if (!hasAllowedRole) {
        await auditDenied(supabase, cmd, interaction, guild.id, 'missing_allowed_role');
        await interaction.reply({
          content: voice(brandKit.voicePreset, 'denied', { action: `use /${cmd.name} on ${guild.name}` }),
          ephemeral: true,
        });
        return true;
      }
    }
  }

  // Check denied roles
  if (cmd.denied_roles.length > 0) {
    const member = interaction.member;
    if (member && 'roles' in member) {
      const memberRoles = member.roles instanceof Array
        ? member.roles
        : [...member.roles.cache.keys()];
      const hasDeniedRole = cmd.denied_roles.some((r: string) => memberRoles.includes(r));
      if (hasDeniedRole) {
        await auditDenied(supabase, cmd, interaction, guild.id, 'denied_role');
        await interaction.reply({
          content: voice(brandKit.voicePreset, 'denied', { action: `use /${cmd.name} on ${guild.name}` }),
          ephemeral: true,
        });
        return true;
      }
    }
  }

  // Check channel restrictions
  if (cmd.allowed_channels.length > 0 && !cmd.allowed_channels.includes(interaction.channelId)) {
    await auditDenied(supabase, cmd, interaction, guild.id, 'channel_not_allowed');
    await interaction.reply({
      content: voice(brandKit.voicePreset, 'denied', { action: `use /${cmd.name} in this channel` }),
      ephemeral: true,
    });
    return true;
  }

  if (cmd.denied_channels.length > 0 && cmd.denied_channels.includes(interaction.channelId)) {
    await auditDenied(supabase, cmd, interaction, guild.id, 'channel_denied');
    await interaction.reply({
      content: voice(brandKit.voicePreset, 'denied', { action: `use /${cmd.name} in this channel` }),
      ephemeral: true,
    });
    return true;
  }

  // Check cooldown — atomic claim so the "enforced atomically" contract holds.
  // A single SET NX either claims the cooldown window (returns 'OK') or reports
  // it already held (returns null). Two truly-simultaneous invocations can no
  // longer both observe "no key" before either writes it, so exactly one wins
  // the race and executes; the loser gets the cooldown notice.
  if (cmd.cooldown_seconds > 0) {
    const cooldownKey = `${COOLDOWN_PREFIX}:${guild.id}:${cmd.name}:${interaction.user.id}`;
    let claimed: string | null;
    try {
      // Fail closed when the cooldown store is unavailable. Bypassing a
      // configured cooldown during an outage would turn a safety control into
      // an amplification path for command spam.
      claimed = await valkey.set(cooldownKey, '1', 'EX', cmd.cooldown_seconds, 'NX');
    } catch (err) {
      log.warn('Custom command cooldown store unavailable; declining safely', {
        guildId: guild.id,
        commandId: cmd.id,
        error: String(err),
      });
      const content = voice(brandKit.voicePreset, 'unavailable', {
        brand: brandKit.brandName,
        feature: `/${cmd.name}`,
      });
      await interaction.reply({
        content,
        ephemeral: true,
        allowedMentions: { parse: [] },
      }).catch(() => {});
      eventBus.emit('custom_command.degraded', guild.id, {
        commandId: cmd.id,
        commandName: cmd.name,
        userId: interaction.user.id,
        channelId: interaction.channelId,
        actionCount: 1,
        failedActions: 1,
        failedTypes: ['cooldown_store'],
      });
      await writeAuditLog(supabase, {
        guildId: guild.id,
        actorType: 'discord',
        actorId: interaction.user.id,
        action: 'custom_command.cooldown_unavailable',
        category: 'custom_commands',
        targetType: 'custom_command',
        targetId: cmd.id,
        details: { command: cmd.name, reason: 'valkey_unavailable' },
        occurrenceKey: `custom-command:${interaction.id}:cooldown-store`,
        success: false,
        errorMessage: String(err),
      });
      await raiseCustomCommandFailingAlert(supabase, guild.id, cmd, ['cooldown_store'])
        .catch((alertError: unknown) => log.warn('custom command outage alert failed', {
          error: String(alertError),
        }));
      return true;
    }
    if (!claimed) {
      let ttl = cmd.cooldown_seconds;
      try {
        ttl = await valkey.ttl(cooldownKey);
      } catch (err) {
        // The claim already failed closed; use the configured window rather
        // than turning a harmless TTL read outage into an unhandled error.
        log.warn('Custom command cooldown TTL unavailable', {
          guildId: guild.id,
          commandId: cmd.id,
          error: String(err),
        });
      }
      await interaction.reply({
        content: `⏳ Easy there — /${cmd.name} is on cooldown. Try again in ${ttl}s.`,
        ephemeral: true,
      });
      return true;
    }
  }

  // Execute actions
  const actions = cmd.actions as unknown as CustomCommandAction[];
  if (!actions || actions.length === 0) {
    await interaction.reply({ content: 'This command has no actions configured.', ephemeral: cmd.ephemeral });
    return true;
  }

  let replied = false;
  // Per-action failures used to be swallowed here: if the very action that was
  // supposed to reply threw, the run still fell through to "✅ Command
  // executed." and emitted custom_command.invoked. The member was told their
  // command worked when nothing had happened. Track failures instead.
  const failedActions: string[] = [];

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'send_message': {
          const content = replaceVariables(action.message ?? '', interaction);
          // V5 Audit [V5-1]: Restrict allowedMentions to prevent mass-pings via admin templates.
          const mentionOpts = { allowedMentions: { parse: [] as const } };
          if (!replied) {
            await interaction.reply({ content, ephemeral: cmd.ephemeral, ...mentionOpts });
            replied = true;
          } else {
            const targetChannel = action.channelId
              ? guild.channels.cache.get(action.channelId)
              : interaction.channel;
            if (targetChannel && 'send' in targetChannel) {
              await targetChannel.send({ content, ...mentionOpts });
            }
          }
          break;
        }

        case 'send_embed': {
          const ec = action.embedConfig;
          if (!ec) break;
          const embed = new EmbedBuilder();
          if (ec.title) embed.setTitle(replaceVariables(ec.title, interaction));
          if (ec.description) embed.setDescription(replaceVariables(ec.description, interaction));
          if (ec.color != null) embed.setColor(ec.color);
          if (ec.image_url) embed.setImage(ec.image_url);
          if (ec.thumbnail_url) embed.setThumbnail(ec.thumbnail_url);
          if (ec.footer_text) embed.setFooter({ text: replaceVariables(ec.footer_text, interaction) });
          if (ec.fields) {
            for (const f of ec.fields) {
              embed.addFields({
                name: replaceVariables(f.name, interaction),
                value: replaceVariables(f.value, interaction),
                inline: f.inline,
              });
            }
          }
          if (!replied) {
            await interaction.reply({ embeds: [embed], ephemeral: cmd.ephemeral });
            replied = true;
          } else {
            await interaction.followUp({ embeds: [embed] });
          }
          break;
        }

        case 'give_role': {
          if (action.roleId) {
            const member = await guild.members.fetch(interaction.user.id).catch(() => null);
            if (member) {
              await member.roles.add(action.roleId, `Custom command: ${cmd.name}`);
            }
          }
          break;
        }

        case 'remove_role': {
          if (action.roleId) {
            const member = await guild.members.fetch(interaction.user.id).catch(() => null);
            if (member) {
              await member.roles.remove(action.roleId, `Custom command: ${cmd.name}`);
            }
          }
          break;
        }

        case 'send_dm': {
          if (action.message) {
            const content = replaceVariables(action.message, interaction);
            try {
              // V5 Audit [V5-1]: Restrict mentions in DMs.
              await interaction.user.send({ content, allowedMentions: { parse: [] } });
            } catch {
              // DMs may be disabled
            }
          }
          break;
        }
      }
    } catch (err) {
      log.error(`Action ${action.type} failed:`, err);
      failedActions.push(action.type);
    }
  }

  const kit = brandKit;

  if (failedActions.length > 0) {
    // Say what actually happened. If nothing replied, this IS the reply; if
    // something already did, add an ephemeral note rather than overwriting it.
    const notice = brandedEmbed(kit, {
      intent: 'danger',
      description: failedActions.length === actions.length
        ? `❌ /${cmd.name} could not run. Nothing was applied — please try again, or ask an admin to check the command.`
        : `⚠️ /${cmd.name} only partly ran — ${failedActions.length} of ${actions.length} steps failed. An admin has been notified.`,
    });

    if (!replied) {
      await interaction.reply({ embeds: [notice], ephemeral: true }).catch(() => {});
    } else {
      await interaction.followUp({ embeds: [notice], ephemeral: true }).catch(() => {});
    }

    // A degraded run is NOT an invocation success — emit its own event so the
    // audit trail and the Commands page can show which step is failing.
    eventBus.emit('custom_command.degraded', guild.id, {
      commandId: cmd.id,
      commandName: cmd.name,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      actionCount: actions.length,
      failedActions: failedActions.length,
      failedTypes: [...new Set(failedActions)],
    });

    await raiseCustomCommandFailingAlert(supabase, guild.id, cmd, failedActions)
      .catch((e: unknown) => log.warn('custom command alert failed:', (e as Error)?.message ?? e));

    return true;
  }

  // If no action replied, send a default
  if (!replied) {
    await interaction.reply({ content: '✅ Command executed.', ephemeral: true });
  }

  // Audit the successful invocation (append-only trail via AuditService).
  eventBus.emit('custom_command.invoked', guild.id, {
    commandId: cmd.id,
    commandName: cmd.name,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    actionCount: actions.length,
  });

  return true;
}

/**
 * Raise (once per command per window) an owner alert naming the failing
 * command and which action types threw, so a broken custom command surfaces
 * on the Alerts page instead of only in bot logs.
 *
 * Deduped per command id: a popular broken command must not flood the table.
 */
async function raiseCustomCommandFailingAlert(
  supabase: SupabaseClient,
  guildId: string,
  cmd: DbCustomCommand,
  failedActions: string[],
): Promise<void> {
  const types = [...new Set(failedActions)].join(', ');
  await raiseOwnerAlert(supabase, guildId, {
    alertType: 'custom_command_failing',
    severity: 'warning',
    title: `Custom command /${cmd.name} is failing`,
    message:
      `${failedActions.length} action(s) failed while running /${cmd.name} (${types}). `
      + 'Members are seeing an error instead of the command output. '
      + 'Check the command on the Commands page.',
    metadata: { command_id: cmd.id, command_name: cmd.name, failed_types: [...new Set(failedActions)] },
  });
}

/**
 * Record an invoke-time denial for a permission/channel gate on both audit
 * lanes: the platform event bus emission feeds AuditService's batched pipeline,
 * and the direct writeAuditLog row lands the contracted actor-attributed
 * audit_logs entry (actor = the denied invoker) immediately — mirroring the
 * #349 moderation denied-attempt pattern. A refusal is a security event and
 * must leave evidence. writeAuditLog is internally best-effort, so a ledger
 * failure never blocks or fails the denial reply.
 */
async function auditDenied(
  supabase: SupabaseClient,
  cmd: DbCustomCommand,
  interaction: ChatInputCommandInteraction,
  guildId: string,
  reason: 'missing_allowed_role' | 'denied_role' | 'channel_not_allowed' | 'channel_denied',
): Promise<void> {
  eventBus.emit('custom_command.denied', guildId, {
    commandId: cmd.id,
    commandName: cmd.name,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    reason,
  });
  await writeAuditLog(supabase, {
    guildId,
    actorType: 'discord',
    actorId: interaction.user.id,
    action: 'custom_commands.invoke_denied',
    category: 'custom_commands',
    targetType: 'custom_command',
    targetId: cmd.id,
    success: false,
    details: { command: cmd.name, channelId: interaction.channelId, reason },
  });
}

/**
 * Check if a command name is registered as a custom command for any guild.
 */
export function isCustomCommand(name: string, guildId?: string): boolean {
  if (guildId) return commandRegistry.get(guildId)?.has(name) ?? false;
  // Fallback: check all guilds (for cases where guildId isn't available)
  for (const guildMap of commandRegistry.values()) {
    if (guildMap.has(name)) return true;
  }
  return false;
}

/**
 * Clear the command registry for a specific guild (for reloading).
 */
export function clearCommandRegistry(guildId?: string): void {
  if (guildId) {
    commandRegistry.delete(guildId);
  } else {
    commandRegistry.clear();
  }
}
