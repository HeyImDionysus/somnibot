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
  const { data } = await supabase
    .from('custom_commands')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('enabled', true)
    .limit(1000);

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
        await interaction.reply({ content: `❌ You do not have permission to use /${cmd.name} on ${guild.name}.`, ephemeral: true });
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
        await interaction.reply({ content: `❌ You do not have permission to use /${cmd.name} on ${guild.name}.`, ephemeral: true });
        return true;
      }
    }
  }

  // Check channel restrictions
  if (cmd.allowed_channels.length > 0 && !cmd.allowed_channels.includes(interaction.channelId)) {
    await auditDenied(supabase, cmd, interaction, guild.id, 'channel_not_allowed');
    await interaction.reply({ content: `❌ /${cmd.name} can't be used in this channel.`, ephemeral: true });
    return true;
  }

  if (cmd.denied_channels.length > 0 && cmd.denied_channels.includes(interaction.channelId)) {
    await auditDenied(supabase, cmd, interaction, guild.id, 'channel_denied');
    await interaction.reply({ content: `❌ /${cmd.name} can't be used in this channel.`, ephemeral: true });
    return true;
  }

  // Check cooldown — atomic claim so the "enforced atomically" contract holds.
  // A single SET NX either claims the cooldown window (returns 'OK') or reports
  // it already held (returns null). Two truly-simultaneous invocations can no
  // longer both observe "no key" before either writes it, so exactly one wins
  // the race and executes; the loser gets the cooldown notice.
  if (cmd.cooldown_seconds > 0) {
    const cooldownKey = `${COOLDOWN_PREFIX}:${guild.id}:${cmd.name}:${interaction.user.id}`;
    const claimed = await valkey.set(cooldownKey, '1', 'EX', cmd.cooldown_seconds, 'NX');
    if (!claimed) {
      const ttl = await valkey.ttl(cooldownKey);
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
    }
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
