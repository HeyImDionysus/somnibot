/**
 * Adventure slash commands — /adventure start.
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AdventureManager } from './adventure-manager.js';
import type { DbRow } from '@somnibot/shared';


export function buildAdventureCommands(): Record<string, SlashCommandBuilder> {
  return {
    adventure: new SlashCommandBuilder()
      .setName('adventure')
      .setDescription('Embark on interactive story adventures!')
      .addSubcommand((s) =>
        s
          .setName('start')
          .setDescription('Start a new adventure')
          .addStringOption((o) =>
            o
              .setName('type')
              .setDescription('Adventure type')
              .setRequired(false)
              .addChoices(
                { name: '🏰 Dungeon', value: 'dungeon' },
                { name: '🌲 Forest', value: 'forest' },
                { name: '🌊 Ocean', value: 'ocean' },
                { name: '🚀 Space', value: 'space' },
                { name: '⛰️ Mountain', value: 'mountain' },
              ),
          ),
      ) as SlashCommandBuilder,
  };
}

export async function handleAdventureCommand(
  interaction: ChatInputCommandInteraction,
  manager: AdventureManager,
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'start') {
    await interaction.deferReply();
    const adventureType = interaction.options.getString('type') ?? undefined;
    const { embed, row } = await manager.startAdventure(
      interaction.user.id,
      adventureType,
    );

    const replyPayload: DbRow = { embeds: [embed] };
    if (row) replyPayload.components = [row];
    await interaction.editReply(replyPayload);
  }
}
