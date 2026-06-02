/**
 * Adventure button interaction handler.
 * Parses adventure:{sessionId}:{choiceIndex} custom IDs.
 */
import type { ButtonInteraction } from 'discord.js';
import { getAdventureManager } from './adventure-manager.js';

export async function handleAdventureButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const manager = getAdventureManager(interaction.guildId ?? undefined);
  if (!manager) {
    await interaction.reply({ content: '❌ Adventures module is not loaded.', ephemeral: true });
    return;
  }

  const parts = interaction.customId.split(':');
  if (parts.length !== 3 || parts[0] !== 'adventure') return;

  const sessionId = parts[1];
  const choiceIndex = parseInt(parts[2], 10);

  if (isNaN(choiceIndex)) {
    await interaction.reply({ content: '❌ Invalid choice.', ephemeral: true });
    return;
  }

  await manager.handleChoice(interaction, sessionId, choiceIndex);
}
