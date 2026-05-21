/**
 * Heist slash commands — /heist start, /heist join, /heist status
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { HeistManager } from './heist-manager.js';

export function buildHeistCommands(): Record<string, SlashCommandBuilder> {
  const heist = new SlashCommandBuilder()
    .setName('heist')
    .setDescription('Plan and execute heists with your crew')
    .addSubcommand((sub) =>
      sub.setName('start').setDescription('Start a new heist and recruit crew members')
    )
    .addSubcommand((sub) =>
      sub.setName('join').setDescription('Join an active heist')
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('View the current or last heist')
    ) as SlashCommandBuilder;

  return { heist };
}

export async function handleHeistCommand(
  interaction: ChatInputCommandInteraction,
  manager: HeistManager,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'start') await manager.startHeist(interaction);
  else if (sub === 'join') await manager.joinHeist(interaction);
  else if (sub === 'status') await manager.viewHeist(interaction);
}
