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

/** In-memory registry of loaded custom commands */
const commandRegistry = new Map<string, DbCustomCommand>();

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
    .eq('enabled', true);

  commandRegistry.clear();

  if (!data || data.length === 0) {
    log.info('No custom commands found');
    return [];
  }

  // Populate in-memory registry for the interaction handler
  for (const cmd of data as DbCustomCommand[]) {
    commandRegistry.set(cmd.name, cmd);
  }

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
  const cmd = commandRegistry.get(interaction.commandName);
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
        await interaction.reply({ content: '❌ You don\'t have permission to use this command.', ephemeral: true });
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
        await interaction.reply({ content: '❌ You don\'t have permission to use this command.', ephemeral: true });
        return true;
      }
    }
  }

  // Check channel restrictions
  if (cmd.allowed_channels.length > 0 && !cmd.allowed_channels.includes(interaction.channelId)) {
    await interaction.reply({ content: '❌ This command can\'t be used in this channel.', ephemeral: true });
    return true;
  }

  if (cmd.denied_channels.length > 0 && cmd.denied_channels.includes(interaction.channelId)) {
    await interaction.reply({ content: '❌ This command can\'t be used in this channel.', ephemeral: true });
    return true;
  }

  // Check cooldown
  if (cmd.cooldown_seconds > 0) {
    const cooldownKey = `${COOLDOWN_PREFIX}:${guild.id}:${cmd.name}:${interaction.user.id}`;
    const onCooldown = await valkey.get(cooldownKey);
    if (onCooldown) {
      const ttl = await valkey.ttl(cooldownKey);
      await interaction.reply({
        content: `⏳ Command on cooldown. Try again in ${ttl}s.`,
        ephemeral: true,
      });
      return true;
    }
    await valkey.set(cooldownKey, '1', 'EX', cmd.cooldown_seconds);
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
          if (!replied) {
            await interaction.reply({ content, ephemeral: cmd.ephemeral });
            replied = true;
          } else {
            const targetChannel = action.channelId
              ? guild.channels.cache.get(action.channelId)
              : interaction.channel;
            if (targetChannel && 'send' in targetChannel) {
              await targetChannel.send(content);
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
              await interaction.user.send(content);
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

  return true;
}

/**
 * Check if a command name is registered as a custom command.
 */
export function isCustomCommand(name: string): boolean {
  return commandRegistry.has(name);
}

/**
 * Clear the command registry (for reloading).
 */
export function clearCommandRegistry(): void {
  commandRegistry.clear();
}
