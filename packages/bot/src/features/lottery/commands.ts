/**
 * Lottery slash commands — /lottery buy [tickets], /lottery view
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { LotteryManager } from './lottery-manager.js';

export function buildLotteryCommands(): Record<string, SlashCommandBuilder> {
  const lottery = new SlashCommandBuilder()
    .setName('lottery')
    .setDescription('Buy lottery tickets or view the current drawing')
    .addSubcommand((sub) =>
      sub
        .setName('buy')
        .setDescription('Buy lottery tickets')
        .addIntegerOption((opt) =>
          opt.setName('tickets').setDescription('Number of tickets to buy').setRequired(false)
            .setMinValue(1).setMaxValue(100)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('view').setDescription('View the current lottery drawing')
    ) as SlashCommandBuilder;

  return { lottery };
}

export async function handleLotteryCommand(
  interaction: ChatInputCommandInteraction,
  manager: LotteryManager,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'buy') {
    const tickets = interaction.options.getInteger('tickets') ?? 1;
    await manager.buyTickets(interaction, tickets);
  } else if (sub === 'view') {
    await manager.viewLottery(interaction);
  }
}
