/**
 * Mini-game slash commands: /coinflip, /slots, /rps, /dice,
 * /blackjack, /highlow, /scratch, /guess
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { GamesManager } from './games-manager.js';

export function buildGameCommands(): Record<string, SlashCommandBuilder> {
  const coinflip = new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Flip a coin — double or nothing')
    .addIntegerOption((opt) =>
      opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
    ) as SlashCommandBuilder;

  const slots = new SlashCommandBuilder()
    .setName('slots')
    .setDescription('Play the slot machine')
    .addIntegerOption((opt) =>
      opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
    ) as SlashCommandBuilder;

  const rps = new SlashCommandBuilder()
    .setName('rps')
    .setDescription('Rock Paper Scissors')
    .addIntegerOption((opt) =>
      opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
    )
    .addStringOption((opt) =>
      opt.setName('choice').setDescription('Your choice').setRequired(true)
        .addChoices(
          { name: 'Rock', value: 'rock' },
          { name: 'Paper', value: 'paper' },
          { name: 'Scissors', value: 'scissors' },
        )
    ) as SlashCommandBuilder;

  const dice = new SlashCommandBuilder()
    .setName('dice')
    .setDescription('Roll dice — higher total wins')
    .addIntegerOption((opt) =>
      opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
    ) as SlashCommandBuilder;

  const blackjack = new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Play blackjack vs the dealer')
    .addIntegerOption((opt) =>
      opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
    ) as SlashCommandBuilder;

  const highlow = new SlashCommandBuilder()
    .setName('highlow')
    .setDescription('Guess if the next number is higher or lower (free)')
    as SlashCommandBuilder;

  const scratch = new SlashCommandBuilder()
    .setName('scratch')
    .setDescription('Scratch card — match symbols for a payout')
    .addIntegerOption((opt) =>
      opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
    ) as SlashCommandBuilder;

  const guessCmd = new SlashCommandBuilder()
    .setName('guess')
    .setDescription('Guess a number 1-100 — closer = bigger payout')
    .addIntegerOption((opt) =>
      opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
    )
    .addIntegerOption((opt) =>
      opt.setName('number').setDescription('Your guess (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)
    ) as SlashCommandBuilder;

  return { coinflip, slots, rps, dice, blackjack, highlow, scratch, guess: guessCmd };
}

export async function handleGameCommand(
  interaction: ChatInputCommandInteraction,
  manager: GamesManager,
): Promise<void> {
  const name = interaction.commandName;
  const amount = interaction.options.getInteger('amount') ?? 0;

  switch (name) {
    case 'coinflip': return manager.coinflip(interaction, amount);
    case 'slots': return manager.slots(interaction, amount);
    case 'rps': {
      const choice = interaction.options.getString('choice') ?? 'rock';
      return manager.rps(interaction, amount, choice);
    }
    case 'dice': return manager.dice(interaction, amount);
    case 'blackjack': return manager.blackjack(interaction, amount);
    case 'highlow': return manager.highlow(interaction);
    case 'scratch': return manager.scratch(interaction, amount);
    case 'guess': return manager.guess(interaction, amount);
  }
}
