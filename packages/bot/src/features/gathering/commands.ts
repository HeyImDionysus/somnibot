/**
 * Gathering slash commands — /hunt, /dig, /mine.
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { GatheringManager } from './gathering-manager.js';
import type { LootSourceType } from '@somnibot/shared';

export function buildGatheringCommands(): Record<string, SlashCommandBuilder> {
  return {
    hunt: new SlashCommandBuilder()
      .setName('hunt')
      .setDescription('Go hunting for animals and materials (requires Hunting Rifle for rare drops)') as SlashCommandBuilder,

    dig: new SlashCommandBuilder()
      .setName('dig')
      .setDescription('Dig for fossils, minerals, and buried treasure (requires Shovel for rare drops)') as SlashCommandBuilder,

    mine: new SlashCommandBuilder()
      .setName('mine')
      .setDescription('Mine for ores, gems, and crystals (requires Pickaxe for rare drops)') as SlashCommandBuilder,
  };
}

export async function handleGatheringCommand(
  interaction: ChatInputCommandInteraction,
  manager: GatheringManager,
): Promise<void> {
  const sourceMap: Record<string, LootSourceType> = {
    hunt: 'hunt',
    dig: 'dig',
    mine: 'mine',
  };

  const sourceType = sourceMap[interaction.commandName];
  if (!sourceType) return;

  await interaction.deferReply();

  const { embed } = await manager.gather(interaction.user.id, sourceType, interaction.id);
  await interaction.editReply({ embeds: [embed] });
}
