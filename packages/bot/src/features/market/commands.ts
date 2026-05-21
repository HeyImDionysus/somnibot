/**
 * Market slash commands — /market list|browse|buy|my-listings|cancel.
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { MarketManager } from './market-manager.js';

export function buildMarketCommands(): Record<string, SlashCommandBuilder> {
  return {
    market: new SlashCommandBuilder()
      .setName('market')
      .setDescription('Player-to-player item marketplace')
      .addSubcommand((s) =>
        s
          .setName('list')
          .setDescription('List an item for sale')
          .addStringOption((o) => o.setName('item').setDescription('Item name to sell').setRequired(true))
          .addIntegerOption((o) => o.setName('quantity').setDescription('How many to sell').setRequired(true).setMinValue(1))
          .addIntegerOption((o) => o.setName('price').setDescription('Price per unit').setRequired(true).setMinValue(1)),
      )
      .addSubcommand((s) =>
        s
          .setName('browse')
          .setDescription('Browse market listings')
          .addStringOption((o) => o.setName('search').setDescription('Search for an item').setRequired(false)),
      )
      .addSubcommand((s) =>
        s
          .setName('buy')
          .setDescription('Buy from a listing')
          .addStringOption((o) => o.setName('listing').setDescription('Listing ID (first 8 chars)').setRequired(true))
          .addIntegerOption((o) => o.setName('quantity').setDescription('How many to buy').setRequired(false).setMinValue(1)),
      )
      .addSubcommand((s) =>
        s.setName('my-listings').setDescription('View your active listings'),
      )
      .addSubcommand((s) =>
        s
          .setName('cancel')
          .setDescription('Cancel a listing and get items back')
          .addStringOption((o) => o.setName('listing').setDescription('Listing ID (first 8 chars)').setRequired(true)),
      ) as SlashCommandBuilder,
  };
}

export async function handleMarketCommand(
  interaction: ChatInputCommandInteraction,
  manager: MarketManager,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply();

  switch (sub) {
    case 'list': {
      const itemName = interaction.options.getString('item', true);
      const quantity = interaction.options.getInteger('quantity', true);
      const price = interaction.options.getInteger('price', true);
      const embed = await manager.listItem(interaction.user.id, itemName, quantity, price);
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    case 'browse': {
      const search = interaction.options.getString('search') ?? undefined;
      const embed = await manager.browse(search);
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    case 'buy': {
      const listingId = interaction.options.getString('listing', true);
      const quantity = interaction.options.getInteger('quantity') ?? 1;
      const embed = await manager.buy(interaction.user.id, listingId, quantity);
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    case 'my-listings': {
      const embed = await manager.myListings(interaction.user.id);
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    case 'cancel': {
      const listingId = interaction.options.getString('listing', true);
      const embed = await manager.cancelListing(interaction.user.id, listingId);
      await interaction.editReply({ embeds: [embed] });
      break;
    }
    default:
      await interaction.editReply({ content: '❌ Unknown subcommand.' });
  }
}
