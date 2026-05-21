/**
 * Trivia slash commands — /trivia start [category] [difficulty]
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { TriviaManager } from './trivia-manager.js';
import type { TriviaDifficulty } from '@somnibot/shared';

export function buildTriviaCommands(): Record<string, SlashCommandBuilder> {
  const trivia = new SlashCommandBuilder()
    .setName('trivia')
    .setDescription('Start a trivia round')
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Start a trivia question')
        .addStringOption((opt) =>
          opt.setName('category').setDescription('Question category').setRequired(false)
            .addChoices(
              { name: 'General', value: 'general' },
              { name: 'Science', value: 'science' },
              { name: 'History', value: 'history' },
              { name: 'Geography', value: 'geography' },
              { name: 'Art', value: 'art' },
              { name: 'Math', value: 'math' },
              { name: 'Technology', value: 'technology' },
              { name: 'Literature', value: 'literature' },
            )
        )
        .addStringOption((opt) =>
          opt.setName('difficulty').setDescription('Question difficulty').setRequired(false)
            .addChoices(
              { name: 'Easy', value: 'easy' },
              { name: 'Medium', value: 'medium' },
              { name: 'Hard', value: 'hard' },
            )
        )
    ) as SlashCommandBuilder;

  return { trivia };
}

export async function handleTriviaCommand(
  interaction: ChatInputCommandInteraction,
  manager: TriviaManager,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'start') {
    const category = interaction.options.getString('category') ?? undefined;
    const difficulty = (interaction.options.getString('difficulty') as TriviaDifficulty) ?? undefined;
    await manager.startRound(interaction, category, difficulty);
  }
}
