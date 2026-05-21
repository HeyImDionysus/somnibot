import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { QuestsManager } from './quests-manager.js';

export function buildQuestCommands(): Record<string, SlashCommandBuilder> {
  const quests = new SlashCommandBuilder()
    .setName('quests')
    .setDescription('View and manage your quests')
    .addSubcommand((s) => s.setName('view').setDescription('View your active quests'))
    .addSubcommand((s) => s.setName('claim').setDescription('Claim completed quest rewards')) as SlashCommandBuilder;

  return { quests };
}

export async function handleQuestCommand(
  interaction: ChatInputCommandInteraction,
  manager: QuestsManager,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'view') await manager.viewQuests(interaction);
  else if (sub === 'claim') await manager.claimQuests(interaction);
}
