/**
 * Crafting slash commands — /craft, /recipes.
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { CraftingManager } from './crafting-manager.js';

export function buildCraftingCommands(): Record<string, SlashCommandBuilder> {
  return {
    craft: new SlashCommandBuilder()
      .setName('craft')
      .setDescription('Craft an item using materials from your inventory')
      .addStringOption((opt) =>
        opt.setName('item').setDescription('Name of the recipe to craft').setRequired(true),
      ) as SlashCommandBuilder,

    recipes: new SlashCommandBuilder()
      .setName('recipes')
      .setDescription('View all available crafting recipes') as SlashCommandBuilder,
  };
}

export async function handleCraftingCommand(
  interaction: ChatInputCommandInteraction,
  manager: CraftingManager,
): Promise<void> {
  await interaction.deferReply();

  if (interaction.commandName === 'recipes') {
    const { embed } = await manager.listRecipes();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'craft') {
    const itemName = interaction.options.getString('item', true);
    const { embed } = await manager.craft(interaction.user.id, itemName, interaction.id);
    await interaction.editReply({ embeds: [embed] });
  }
}
