/**
 * Farming slash commands — /farm (plant, water, harvest, view, fertilize).
 */
import {
  SlashCommandBuilder,
  type InteractionEditReplyOptions,
  type MessagePayload,
} from 'discord.js';
import type { FarmingManager } from './farming-manager.js';

interface FarmingCommandOptions {
  getSubcommand(): string;
  getString(name: 'crop', required: true): string;
  getInteger(name: 'plot', required: true): number;
}

export interface FarmingCommandInteraction {
  readonly commandName: string;
  readonly id: string;
  readonly user: { readonly id: string };
  readonly options: FarmingCommandOptions;
  deferReply(): Promise<unknown>;
  editReply(response: string | MessagePayload | InteractionEditReplyOptions): Promise<unknown>;
}

type FarmingCommandManager = Pick<
  FarmingManager,
  'viewFarm' | 'plant' | 'water' | 'harvest' | 'fertilize'
>;

export function buildFarmingCommands(): Record<string, SlashCommandBuilder> {
  return {
    farm: new SlashCommandBuilder()
      .setName('farm')
      .setDescription('Manage your farm')
      .addSubcommand((sub) =>
        sub.setName('view').setDescription('View your farm grid'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('plant')
          .setDescription('Plant a crop on your farm')
          .addStringOption((opt) =>
            opt.setName('crop').setDescription('Name of the crop to plant').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('water').setDescription('Water all your crops'),
      )
      .addSubcommand((sub) =>
        sub.setName('harvest').setDescription('Harvest all mature crops'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('fertilize')
          .setDescription('Apply fertilizer to a plot')
          .addIntegerOption((opt) =>
            opt.setName('plot').setDescription('Plot number (1-9)').setRequired(true),
          ),
      ) as SlashCommandBuilder,
  };
}

export async function handleFarmingCommand(
  interaction: FarmingCommandInteraction,
  manager: FarmingCommandManager,
): Promise<void> {
  if (interaction.commandName !== 'farm') return;

  await interaction.deferReply();

  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'view': {
      const { embed } = await manager.viewFarm(interaction.user.id);
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    case 'plant': {
      const cropName = interaction.options.getString('crop', true);
      const { embed } = await manager.plant(interaction.user.id, cropName, interaction.id);
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    case 'water': {
      const { embed } = await manager.water(interaction.user.id, interaction.id);
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    case 'harvest': {
      const { embed } = await manager.harvest(interaction.user.id, interaction.id);
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    case 'fertilize': {
      const plotNum = interaction.options.getInteger('plot', true);
      const { embed } = await manager.fertilize(interaction.user.id, plotNum, interaction.id);
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    default:
      await interaction.editReply('Unknown farm command.');
  }
}
