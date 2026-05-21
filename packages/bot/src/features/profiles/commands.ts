import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { ProfilesManager } from './profiles-manager.js';

export function buildProfileCommands(): Record<string, SlashCommandBuilder> {
  const profile = new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View a user profile')
    .addUserOption((o) => o.setName('user').setDescription('User to view').setRequired(false)) as SlashCommandBuilder;

  const title = new SlashCommandBuilder()
    .setName('title')
    .setDescription('Set your display title')
    .addStringOption((o) => o.setName('title').setDescription('Your title').setRequired(true).setMaxLength(64)) as SlashCommandBuilder;

  const bio = new SlashCommandBuilder()
    .setName('bio')
    .setDescription('Set your profile bio')
    .addStringOption((o) => o.setName('bio').setDescription('Your bio text').setRequired(true).setMaxLength(256)) as SlashCommandBuilder;

  return { profile, title, bio };
}

export async function handleProfileCommand(
  interaction: ChatInputCommandInteraction,
  manager: ProfilesManager,
): Promise<void> {
  if (interaction.commandName === 'profile') await manager.viewProfile(interaction);
  else if (interaction.commandName === 'title') await manager.setTitle(interaction);
  else if (interaction.commandName === 'bio') await manager.setBio(interaction);
}
