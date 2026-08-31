import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { SOMNI_PALETTE } from '@somnibot/shared';
import type { SomniClient } from '../../client.js';

const LAUNCHER_GUIDANCE =
  'SomniBot installation credentials, deployment, service lifecycle, updates, and recovery are managed only in the SomniBot Launcher. Open the Launcher on the machine that owns this installation. Use the dashboard for server configuration and operations; use Discord for community behavior, staff actions, and immediate feedback.';

export function buildSetupCommand() {
  return new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Show where to manage installation and server setup')
    .setDMPermission(false);
}

function buildLauncherGuidanceEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(SOMNI_PALETTE.HOT_PINK)
    .setTitle('Setup ownership')
    .setDescription(LAUNCHER_GUIDANCE);
}

async function requireOwner(
  interaction:
    | ButtonInteraction
    | ChatInputCommandInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction,
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true,
    });
    return false;
  }
  if (interaction.user.id !== guild.ownerId) {
    await interaction.reply({
      content: 'Only the server owner can use setup.',
      ephemeral: true,
    });
    return false;
  }
  return true;
}

export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction,
  _client?: SomniClient,
): Promise<void> {
  if (!(await requireOwner(interaction))) return;
  await interaction.reply({
    embeds: [buildLauncherGuidanceEmbed()],
    components: [],
    ephemeral: true,
  });
}

async function rejectLegacyInstallationInteraction(
  interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
): Promise<void> {
  if (!(await requireOwner(interaction))) return;
  await interaction.reply({
    embeds: [buildLauncherGuidanceEmbed()],
    components: [],
    ephemeral: true,
  });
}

export async function handleSetupButton(
  interaction: ButtonInteraction,
  _client?: SomniClient,
): Promise<void> {
  await rejectLegacyInstallationInteraction(interaction);
}

export async function handleSetupModal(
  interaction: ModalSubmitInteraction,
  _client?: SomniClient,
): Promise<void> {
  await rejectLegacyInstallationInteraction(interaction);
}

export async function handleReconfigureSelect(
  interaction: StringSelectMenuInteraction,
  _client?: SomniClient,
): Promise<void> {
  await rejectLegacyInstallationInteraction(interaction);
}
