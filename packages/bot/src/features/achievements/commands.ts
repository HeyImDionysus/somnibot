import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AchievementsManager } from './achievements-manager.js';

export function buildAchievementCommands(): Record<string, SlashCommandBuilder> {
  const badges = new SlashCommandBuilder()
    .setName('badges')
    .setDescription('View all achievements and your progress') as SlashCommandBuilder;

  const prestige = new SlashCommandBuilder()
    .setName('prestige')
    .setDescription('Prestige to reset progress for permanent earning bonuses') as SlashCommandBuilder;

  return { badges, prestige };
}

export async function handleAchievementCommand(
  interaction: ChatInputCommandInteraction,
  manager: AchievementsManager,
): Promise<void> {
  if (interaction.commandName === 'badges') await manager.viewBadges(interaction);
  else if (interaction.commandName === 'prestige') await manager.prestige(interaction);
}
