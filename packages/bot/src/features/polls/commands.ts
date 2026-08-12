/**
 * Poll and Prediction slash commands.
 * /poll create, /poll close
 * /predict create, /predict bet, /predict resolve
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { PollsManager } from './polls-manager.js';

export function buildPollCommands(): Record<string, SlashCommandBuilder> {
  const poll = new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create and manage polls')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a new poll')
        .addStringOption((opt) =>
          opt.setName('title').setDescription('Poll question').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('options').setDescription('Comma-separated options (2-10)').setRequired(true)
        )
        .addBooleanOption((opt) =>
          opt.setName('multiple').setDescription('Allow multiple votes?').setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('close')
        .setDescription('Close a poll')
        .addStringOption((opt) =>
          opt.setName('poll_id').setDescription('Poll ID to close').setRequired(true)
        )
    ) as SlashCommandBuilder;

  const predict = new SlashCommandBuilder()
    .setName('predict')
    .setDescription('Create and manage prediction markets')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a new prediction')
        .addStringOption((opt) =>
          opt.setName('title').setDescription('Prediction question').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('options').setDescription('Comma-separated outcomes (2-10)').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('bet')
        .setDescription('Bet on a prediction outcome')
        .addStringOption((opt) =>
          opt.setName('prediction_id').setDescription('Prediction ID').setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt.setName('option').setDescription('Option number (1-based)').setRequired(true).setMinValue(1)
        )
        .addIntegerOption((opt) =>
          opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('resolve')
        .setDescription('Resolve a prediction with the winning outcome')
        .addStringOption((opt) =>
          opt.setName('prediction_id').setDescription('Prediction ID').setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt.setName('winner').setDescription('Winning option number (1-based)').setRequired(true).setMinValue(1)
        )
    ) as SlashCommandBuilder;

  return { poll, predict };
}

export async function handlePollCommand(
  interaction: ChatInputCommandInteraction,
  manager: PollsManager,
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const title = interaction.options.getString('title')!;
    const optionsStr = interaction.options.getString('options')!;
    const multiple = interaction.options.getBoolean('multiple') ?? undefined;
    const options = optionsStr.split(',').map((o) => o.trim()).filter(Boolean);
    await manager.createPoll(interaction, title, options, multiple);
  } else if (sub === 'close') {
    const pollId = interaction.options.getString('poll_id')!;
    await manager.closePoll(interaction, pollId);
  }
}

export async function handlePredictCommand(
  interaction: ChatInputCommandInteraction,
  manager: PollsManager,
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const title = interaction.options.getString('title')!;
    const optionsStr = interaction.options.getString('options')!;
    const options = optionsStr.split(',').map((o) => o.trim()).filter(Boolean);
    await manager.createPrediction(interaction, title, options);
  } else if (sub === 'bet') {
    const predictionId = interaction.options.getString('prediction_id')!;
    const optionIndex = interaction.options.getInteger('option')! - 1;
    const amount = interaction.options.getInteger('amount')!;
    await manager.placeBet(interaction, predictionId, optionIndex, amount);
  } else if (sub === 'resolve') {
    const predictionId = interaction.options.getString('prediction_id')!;
    const winnerIndex = interaction.options.getInteger('winner')! - 1;
    await manager.resolvePrediction(interaction, predictionId, winnerIndex);
  }
}
