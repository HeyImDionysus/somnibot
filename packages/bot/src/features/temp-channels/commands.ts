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
import type { HubConfig } from './temp-channel-manager.js';
import { renderTempChannelTemplate, type TemplateVars } from './templates.js';
import { eventBus } from '../../services/event-bus.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('TempChannelCmds');

/**
 * Base variables available to every control surface template. Resolved from the
 * interaction + guild cache so {owner-name}/{room-name}/{user}/{server} render
 * regardless of which control was run.
 */
function baseTemplateVars(
  interaction: ChatInputCommandInteraction,
  ownerId: string | null,
  vcId: string,
): TemplateVars {
  const guild = interaction.guild!;
  const actor = guild.members.cache.get(interaction.user.id);
  const owner = ownerId ? guild.members.cache.get(ownerId) : null;
  const room = guild.channels.cache.get(vcId) as { name?: string } | undefined;
  const actorName = actor?.displayName ?? interaction.user.username;
  return {
    'owner-name': owner?.displayName ?? actorName,
    'room-name': room?.name ?? '',
    user: actorName,
    username: actorName,
    server: guild.name,
  };
}

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

  // Owner-brandable member surfaces. `applied` wraps the per-action status line;
  // `denied` wraps the per-refusal reason. Both fall back to the built-in
  // default template when the hub has no override.
  const applied = (action: string, extra: TemplateVars = {}): string =>
    renderTempChannelTemplate(hub as HubConfig | null, 'control_applied', {
      ...baseTemplateVars(interaction, ownerId, vcId),
      action,
      ...extra,
    });
  const denied = (reason: string): string =>
    renderTempChannelTemplate(hub as HubConfig | null, 'control_denied', {
      ...baseTemplateVars(interaction, ownerId, vcId),
      reason,
    });
  const emitDenied = (reason: string): void => {
    const interactionId = (interaction as ChatInputCommandInteraction & { id?: string }).id;
    eventBus.emit('temp_channel.control_denied', interaction.guild!.id, {
      channelId: vcId,
      actorId: interaction.user.id,
      op: sub,
      reason,
      // Discord interaction ids are unique per attempt. The deterministic
      // fallback keeps tests and gateway-adjacent callers auditable without
      // inventing a random key in the hot denial path.
      occurrenceId: interactionId ?? `${vcId}:${interaction.user.id}:${sub}:${reason}`,
      correlationId: `temp:${vcId}`,
    });
  };

  // Only owner or mods can control (except claim)
  if (sub !== 'claim' && !isOwner && !isMod) {
    const reason = 'permission-denied';
    emitDenied(reason);
    await interaction.reply({ content: denied('❌ Only the channel owner or moderators can use this command.'), ephemeral: true });
    return;
  }

  const vc = interaction.guild.channels.cache.get(vcId) as VoiceChannel;
  if (!vc) {
    await interaction.reply({ content: '❌ Voice channel not found.', ephemeral: true });
    return;
  }

  // [#60] Append-only audit for the /voice owner-control surface. One event
  // covers all eight controls (lock/unlock/limit/name/permit/deny/ban/claim);
  // AuditService maps it to a temp_channel.settings_changed audit row
  // (category temp_channels). Member-targeted ops carry the affected member
  // in targetUserId so the audit row's target is the member (purge-scrubbed).
  const auditSettingsChange = (
    op: 'lock' | 'unlock' | 'limit' | 'name' | 'permit' | 'deny' | 'ban' | 'claim',
    extra: {
      targetUserId?: string;
      value?: string | number;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    } = {},
  ): void => {
    eventBus.emit('temp_channel.settings_changed', interaction.guild!.id, {
      channelId: vcId,
      actorId: interaction.user.id,
      op,
      ...extra,
    });
  };

  try {
    switch (sub) {
      case 'lock': {
        await vc.permissionOverwrites.edit(interaction.guild.id, {
          Connect: false,
        });
        auditSettingsChange('lock', { after: { locked: true } });
        await interaction.reply({ content: applied('🔒 Voice channel locked.'), ephemeral: true });
        break;
      }

      case 'unlock': {
        await vc.permissionOverwrites.edit(interaction.guild.id, {
          Connect: null,
        });
        auditSettingsChange('unlock', { after: { locked: false } });
        await interaction.reply({ content: applied('🔓 Voice channel unlocked.'), ephemeral: true });
        break;
      }

      case 'limit': {
        const count = interaction.options.getInteger('count', true);
        const previousLimit = vc.userLimit;
        await vc.setUserLimit(count);
        auditSettingsChange('limit', {
          value: count,
          before: { userLimit: previousLimit },
          after: { userLimit: count },
        });
        await interaction.reply({
          content: applied(count === 0 ? '♾️ User limit removed.' : `👥 User limit set to ${count}.`),
          ephemeral: true,
        });
        break;
      }

      case 'name': {
        const name = interaction.options.getString('name', true);
        const previousName = vc.name;
        await vc.setName(name);
        auditSettingsChange('name', {
          value: name,
          before: { name: previousName },
          after: { name },
        });
        await interaction.reply({ content: applied(`✏️ Channel renamed to "${name}".`, { 'room-name': name }), ephemeral: true });
        break;
      }

      case 'permit': {
        const user = interaction.options.getUser('user', true);
        await vc.permissionOverwrites.create(user.id, {
          Connect: true,
          ViewChannel: true,
        });
        auditSettingsChange('permit', { targetUserId: user.id, after: { connect: true } });
        await interaction.reply({ content: applied(`✅ <@${user.id}> can now join your channel.`, { target: `<@${user.id}>` }), ephemeral: true });
        break;
      }

      case 'deny': {
        const user = interaction.options.getUser('user', true);
        await vc.permissionOverwrites.create(user.id, {
          Connect: false,
        });
        auditSettingsChange('deny', { targetUserId: user.id, after: { connect: false } });
        await interaction.reply({ content: applied(`🚫 <@${user.id}> can no longer join your channel.`, { target: `<@${user.id}>` }), ephemeral: true });
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
        auditSettingsChange('ban', { targetUserId: user.id, after: { connect: false, viewChannel: false } });
        await interaction.reply({ content: applied(`⛔ <@${user.id}> has been banned from your channel.`, { target: `<@${user.id}>` }), ephemeral: true });
        break;
      }

      case 'claim': {
        // Owner may have disabled claiming for this hub's rooms.
        if (hub && hub.allow_claim === false) {
          emitDenied('claim-disabled');
          await interaction.reply({ content: denied('❌ Claiming is disabled for these voice channels.'), ephemeral: true });
          return;
        }
        if (!ownerId) {
          emitDenied('owner-record-missing');
          await interaction.reply({ content: denied('❌ This channel has no owner record.'), ephemeral: true });
          return;
        }
        // Check if owner is still in the channel
        const ownerInChannel = vc.members.has(ownerId);
        if (ownerInChannel) {
          emitDenied('owner-present');
          await interaction.reply({ content: denied('❌ The current owner is still in the channel.'), ephemeral: true });
          return;
        }
        // Transfer ownership
        await manager.transferOwnership(vcId, interaction.user.id);
        // The affected member is the PREVIOUS owner whose room was claimed —
        // they are the audit row's target; the claimer is the actor.
        auditSettingsChange('claim', {
          targetUserId: ownerId,
          before: { ownerId },
          after: { ownerId: interaction.user.id },
        });
        await interaction.reply({ content: applied('👑 You are now the owner of this voice channel.'), ephemeral: true });
        break;
      }
    }
  } catch (err) {
    log.error('Command error:', { error: String(err) });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ An error occurred while processing the command.', ephemeral: true });
    }
  }
}
