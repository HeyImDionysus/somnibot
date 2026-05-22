/**
 * /tutorial — Interactive server tutorial command.
 *
 * V53 Phase 3 (Finding 3.2 — M-8)
 */
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import type { SomniClient } from '../../client.js';
import { TutorialEngine } from './tutorial-engine.js';

export function buildTutorialCommand() {
  return new SlashCommandBuilder()
    .setName('tutorial')
    .setDescription('Start or resume the server tutorial');
}

export async function handleTutorialCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const client = interaction.client as SomniClient;
  const engine = new TutorialEngine(client.supabase, interaction.guildId!);
  await engine.startTutorial(interaction);
}
