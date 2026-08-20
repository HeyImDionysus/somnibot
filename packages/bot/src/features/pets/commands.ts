import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { PetsManager } from './pets-manager.js';

export function buildPetCommands(): Record<string, SlashCommandBuilder> {
  const pet = new SlashCommandBuilder()
    .setName('pet')
    .setDescription('Virtual pet commands')
    .addSubcommand((s) => s.setName('view').setDescription('View your pet or someone else\'s')
      .addUserOption((o) => o.setName('user').setDescription('User to view').setRequired(false)))
    .addSubcommand((s) => s.setName('buy').setDescription('Buy a new pet')
      .addStringOption((o) => o.setName('type').setDescription('Pet type').setRequired(true)
        .setAutocomplete(true)))
    .addSubcommand((s) => s.setName('feed').setDescription('Feed your pet (costs coins)'))
    .addSubcommand((s) => s.setName('play').setDescription('Play with your pet'))
    .addSubcommand((s) => s.setName('train').setDescription('Train your pet for XP (costs coins + energy)'))
    .addSubcommand((s) => s.setName('rename').setDescription('Rename your pet')
      .addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true)))
    .addSubcommand((s) => s.setName('battle').setDescription('Battle another player\'s pet')
      .addUserOption((o) => o.setName('user').setDescription('Opponent').setRequired(true)))
    .addSubcommand((s) => s.setName('prestige').setDescription('Prestige your max-level pet')) as SlashCommandBuilder;

  return { pet };
}

export async function handlePetCommand(
  interaction: ChatInputCommandInteraction,
  manager: PetsManager,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'view': await manager.viewPet(interaction); break;
    case 'buy': await manager.buyPet(interaction); break;
    case 'feed': await manager.feedPet(interaction); break;
    case 'play': await manager.playWithPet(interaction); break;
    case 'train': await manager.trainPet(interaction); break;
    case 'rename': await manager.renamePet(interaction); break;
    case 'battle': await manager.battlePet(interaction); break;
    case 'prestige': await manager.prestigePet(interaction); break;
  }
}
