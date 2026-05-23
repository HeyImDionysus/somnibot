/**
 * Temp channel slash commands.
 *
 * /voice lock   — Lock your temp channel
 * /voice unlock — Unlock your temp channel
 * /voice limit  — Set user limit
 * /voice name   — Rename your temp channel
 * /voice permit — Allow a user into your channel
 * /voice deny   — Remove a user's access
 * /voice ban    — Ban a user from your channel (kick + deny)
 * /voice claim  — Claim ownership of an ownerless channel
 */
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  type ChatInputCommandInteraction,
  type VoiceChannel,
} from 'discord.js';
import type { TempChannelManager } from './temp-channel-manager.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('TempChannelCmds');

export function buildTempChannelCommands() {
  const voiceCmd = new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Control your temporary voice channel')
    .addSubcommand((sub) =>
      sub.setName('lock').setDescription('Lock your voice channel'))
    .addSubcommand((sub) =>
      sub.setName('unlock').setDescription('Unlock your voice channel'))
    .addSubcommand((sub) =>
      sub
        .setName('limit')
        .setDescription('Set user limit')
        .addIntegerOption((opt) =>
          opt.setName('count').setDescription('Max users (0 for unlimited)').setRequired(true).setMinValue(0).setMaxValue(99)))
    .addSubcommand((sub) =>
      sub
        .setName('name')
        .setDescription('Rename your voice channel')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('New channel name').setRequired(true).setMaxLength(100)))
    .addSubcommand((sub) =>
      sub
        .setName('permit')
        .setDescription('Allow a user into your channel')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('User to permit').setRequired(true)))
    .addSubcommand((sub) =>
      sub
        .setName('deny')
        .setDescription("Remove a user's access to your channel")
        .addUserOption((opt) =>
          opt.setName('user').setDescription('User to deny').setRequired(true)))
    .addSubcommand((sub) =>
      sub
        .setName('ban')
        .setDescription('Ban a user from your voice channel')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('User to ban').setRequired(true)))
    .addSubcommand((sub) =>
      sub.setName('claim').setDescription('Claim ownership of this voice channel'));

  return voiceCmd;
}

export async function handleTempChannelCommand(
  interaction: ChatInputCommandInteraction,
  manager: TempChannelManager,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const member = interaction.member;
  if (!member || !interaction.guild) {
    await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
    return;
  }

  // User must be in a voice channel
  const voiceState = interaction.guild.members.cache.get(interaction.user.id)?.voice;
  const vcId = voiceState?.channelId;

  if (!vcId || !manager.isTempChannel(vcId)) {
    await interaction.reply({ content: '❌ You must be in a temporary voice channel to use this command.', ephemeral: true });
    return;
  }

  const ownerId = manager.getChannelOwner(vcId);
  const hub = manager.getHubForChannel(vcId);
  const isOwner = ownerId === interaction.user.id;
  const isMod = hub?.moderator_roles?.some((roleId) =>
    interaction.guild!.members.cache.get(interaction.user.id)?.roles.cache.has(roleId),
  ) ?? false;

  // Only owner or mods can control (except claim)
  if (sub !== 'claim' && !isOwner && !isMod) {
    await interaction.reply({ content: '❌ Only the channel owner or moderators can use this command.', ephemeral: true });
    return;
  }

  const vc = interaction.guild.channels.cache.get(vcId) as VoiceChannel;
  if (!vc) {
    await interaction.reply({ content: '❌ Voice channel not found.', ephemeral: true });
    return;
  }

  try {
    switch (sub) {
      case 'lock': {
        await vc.permissionOverwrites.edit(interaction.guild.id, {
          Connect: false,
        });
        await interaction.reply({ content: '🔒 Voice channel locked.', ephemeral: true });
        break;
      }

      case 'unlock': {
        await vc.permissionOverwrites.edit(interaction.guild.id, {
          Connect: null,
        });
        await interaction.reply({ content: '🔓 Voice channel unlocked.', ephemeral: true });
        break;
      }

      case 'limit': {
        const count = interaction.options.getInteger('count', true);
        await vc.setUserLimit(count);
        await interaction.reply({
          content: count === 0 ? '♾️ User limit removed.' : `👥 User limit set to ${count}.`,
          ephemeral: true,
        });
        break;
      }

      case 'name': {
        const name = interaction.options.getString('name', true);
        await vc.setName(name);
        await interaction.reply({ content: `✏️ Channel renamed to "${name}".`, ephemeral: true });
        break;
      }

      case 'permit': {
        const user = interaction.options.getUser('user', true);
        await vc.permissionOverwrites.create(user.id, {
          Connect: true,
          ViewChannel: true,
        });
        await interaction.reply({ content: `✅ <@${user.id}> can now join your channel.`, ephemeral: true });
        break;
      }

      case 'deny': {
        const user = interaction.options.getUser('user', true);
        await vc.permissionOverwrites.create(user.id, {
          Connect: false,
        });
        await interaction.reply({ content: `🚫 <@${user.id}> can no longer join your channel.`, ephemeral: true });
        break;
      }

      case 'ban': {
        const user = interaction.options.getUser('user', true);
        // Kick if currently in the channel
        const targetMember = vc.members.get(user.id);
        if (targetMember) {
          await targetMember.voice.disconnect('Banned from temp channel');
        }
        // Deny access
        await vc.permissionOverwrites.create(user.id, {
          Connect: false,
          ViewChannel: false,
        });
        await interaction.reply({ content: `⛔ <@${user.id}> has been banned from your channel.`, ephemeral: true });
        break;
      }

      case 'claim': {
        if (!ownerId) {
          await interaction.reply({ content: '❌ This channel has no owner record.', ephemeral: true });
          return;
        }
        // Check if owner is still in the channel
        const ownerInChannel = vc.members.has(ownerId);
        if (ownerInChannel) {
          await interaction.reply({ content: '❌ The current owner is still in the channel.', ephemeral: true });
          return;
        }
        // Transfer ownership
        await manager.transferOwnership(vcId, interaction.user.id);
        await interaction.reply({ content: '👑 You are now the owner of this voice channel.', ephemeral: true });
        break;
      }
    }
  } catch (err) {
    log.error('Command error:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ An error occurred while processing the command.', ephemeral: true });
    }
  }
}
