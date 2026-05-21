/**
 * Fishing slash commands — /fish cast|sell|collection|leaderboard.
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { FishingManager } from './fishing-manager.js';

export function buildFishingCommands(): Record<string, SlashCommandBuilder> {
  return {
    fish: new SlashCommandBuilder()
      .setName('fish')
      .setDescription('Go fishing! Catch fish, earn coins.')
      .addSubcommand((s) =>
        s.setName('cast').setDescription('Cast your line and try to catch something'),
      )
      .addSubcommand((s) =>
        s.setName('sell').setDescription('View your fishing earnings summary'),
      )
      .addSubcommand((s) =>
        s.setName('collection').setDescription('View your fish collection'),
      )
      .addSubcommand((s) =>
        s.setName('leaderboard').setDescription('See the heaviest catches'),
      ) as SlashCommandBuilder,
  };
}

export async function handleFishingCommand(
  interaction: ChatInputCommandInteraction,
  manager: FishingManager,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply();

  switch (sub) {
    case 'cast': {
      const { embed } = await manager.fish(interaction.user.id);
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    case 'sell': {
      const embed = await manager.sellAll(interaction.user.id);
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    case 'collection': {
      const embed = await manager.getCollection(interaction.user.id);
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    case 'leaderboard': {
      const embed = await manager.getLeaderboard();
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    default:
      await interaction.editReply({ content: '❌ Unknown subcommand.' });
  }
}
