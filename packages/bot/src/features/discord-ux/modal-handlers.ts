/**
 * Modal Handlers — Process modal submissions from context menus + commands.
 *
 * Handles:
 * - warn_modal:{userId} — Issue a warning
 * - ticket_from_msg:{msgId}:{channelId} — Create ticket from message
 * - report_msg:{msgId}:{channelId}:{authorId} — Report a message
 * - giveaway_create — Create a new giveaway
 * - custom_cmd_create — Create a custom command
 */
import {
  type ModalSubmitInteraction,
  type Guild,
  type TextChannel,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from '../../services/event-bus.js';

const HOT_PINK = 0xFF1493;
const RED = 0xFF4444;
const GREEN = 0x44FF44;

export async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
  guild: Guild,
  supabase: SupabaseClient,
  eventBus: PlatformEventBus,
): Promise<void> {
  const [action, ...params] = interaction.customId.split(':');

  switch (action) {
    case 'warn_modal':
      await handleWarnModal(interaction, guild, supabase, eventBus, params[0]!);
      break;
    case 'ticket_from_msg':
      await handleTicketFromMessageModal(interaction, guild, supabase, eventBus, params[0]!, params[1]!);
      break;
    case 'report_msg':
      await handleReportMessageModal(interaction, guild, supabase, params[0]!, params[1]!, params[2]!);
      break;
    case 'giveaway_create':
      await handleGiveawayCreateModal(interaction, guild, supabase, eventBus);
      break;
    default:
      await interaction.reply({ content: 'Unknown modal action.', ephemeral: true });
  }
}

// ── Warn Modal ─────────────────────────────────────────────

async function handleWarnModal(
  interaction: ModalSubmitInteraction,
  guild: Guild,
  supabase: SupabaseClient,
  eventBus: PlatformEventBus,
  targetUserId: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const reason = interaction.fields.getTextInputValue('warn_reason');
  const moderator = interaction.user;

  // Check permissions
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.permissions.has('ModerateMembers')) {
    await interaction.editReply({ content: '❌ You need the Moderate Members permission to warn users.' });
    return;
  }

  // Get target member info
  const target = await guild.members.fetch(targetUserId).catch(() => null);
  const targetName = target?.displayName ?? targetUserId;

  // Count existing infractions
  const { count: existingCount } = await supabase
    .from('infractions')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guild.id)
    .eq('user_discord_id', targetUserId)
    .eq('active', true);

  const totalInfractions = (existingCount ?? 0) + 1;

  // Create infraction record
  const { data: infraction, error } = await supabase
    .from('infractions')
    .insert({
      guild_id: guild.id,
      user_discord_id: targetUserId,
      moderator_discord_id: moderator.id,
      type: 'warn',
      reason,
      active: true,
    })
    .select('id')
    .single();

  if (error) {
    await interaction.editReply({ content: `❌ Failed to create warning: ${error.message}` });
    return;
  }

  // Emit event
  eventBus.emit('infraction.created', guild.id, {
    userId: targetUserId,
    moderatorId: moderator.id,
    type: 'warn',
    reason,
    totalInfractions,
  });

  // Try to DM the user
  try {
    const targetUser = await guild.client.users.fetch(targetUserId);
    await targetUser.send({
      embeds: [
        new EmbedBuilder()
          .setColor(RED)
          .setTitle(`⚠️ Warning in ${guild.name}`)
          .addFields(
            { name: 'Reason', value: reason },
            { name: 'Total Warnings', value: totalInfractions.toString() },
          )
          .setTimestamp(),
      ],
    });
  } catch {
    // DMs may be disabled — non-fatal
  }

  await interaction.editReply({
    content: `✅ **${targetName}** has been warned. (Total: ${totalInfractions} active infractions)\n**Reason:** ${reason}`,
  });
}

// ── Ticket from Message ────────────────────────────────────

async function handleTicketFromMessageModal(
  interaction: ModalSubmitInteraction,
  guild: Guild,
  supabase: SupabaseClient,
  eventBus: PlatformEventBus,
  messageId: string,
  channelId: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const subject = interaction.fields.getTextInputValue('ticket_subject');
  const details = interaction.fields.getTextInputValue('ticket_details') || null;

  // Get the referenced message
  const channel = guild.channels.cache.get(channelId);
  let messageContent = '';
  let messageUrl = '';
  if (channel && channel.type === ChannelType.GuildText) {
    try {
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      messageContent = msg.content?.slice(0, 1000) || '[No content]';
      messageUrl = msg.url;
    } catch {
      messageContent = '[Could not fetch message]';
    }
  }

  // Get the default ticket panel (or first one)
  const { data: panel } = await supabase
    .from('ticket_panels')
    .select('id, category_id, staff_role_ids')
    .eq('guild_id', guild.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (!panel) {
    await interaction.editReply({
      content: '❌ No ticket panel configured. An admin needs to set up the ticket system first.',
    });
    return;
  }

  // Generate ticket number
  const { count } = await supabase
    .from('tickets')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guild.id);

  const ticketNumber = (count ?? 0) + 1;

  // Create the ticket channel
  const ticketChannel = await guild.channels.create({
    name: `ticket-${ticketNumber.toString().padStart(4, '0')}`,
    type: ChannelType.GuildText,
    parent: panel.category_id || undefined,
    topic: `Ticket #${ticketNumber} — ${subject}`,
    reason: 'Support ticket created from message context menu',
  });

  // Set permissions (user + staff can see, everyone else can't)
  await ticketChannel.permissionOverwrites.create(guild.id, { ViewChannel: false });
  await ticketChannel.permissionOverwrites.create(interaction.user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
  });

  // Add staff roles
  const staffRoleIds = panel.staff_role_ids ?? [];
  for (const roleId of staffRoleIds) {
    try {
      await ticketChannel.permissionOverwrites.create(roleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
    } catch {
      // Role may not exist
    }
  }

  // Create ticket record
  const { data: ticket, error } = await supabase
    .from('tickets')
    .insert({
      guild_id: guild.id,
      ticket_number: ticketNumber,
      channel_id: ticketChannel.id,
      user_discord_id: interaction.user.id,
      panel_id: panel.id,
      subject,
      status: 'open',
    })
    .select('id')
    .single();

  if (error) {
    await ticketChannel.delete().catch(() => {});
    await interaction.editReply({ content: `❌ Failed to create ticket: ${error.message}` });
    return;
  }

  // Post opening message in the ticket channel
  const embed = new EmbedBuilder()
    .setColor(HOT_PINK)
    .setTitle(`🎫 Ticket #${ticketNumber} — ${subject}`)
    .setDescription(
      `Created by ${interaction.user} from a message in <#${channelId}>` +
      (details ? `\n\n**Details:** ${details}` : ''),
    )
    .addFields(
      {
        name: '📝 Referenced Message',
        value: messageUrl
          ? `[Jump to message](${messageUrl})\n>>> ${messageContent.slice(0, 500)}`
          : `>>> ${messageContent.slice(0, 500)}`,
      },
    )
    .setTimestamp();

  await ticketChannel.send({ embeds: [embed] });

  // Emit event
  eventBus.emit('ticket.opened', guild.id, {
    ticketId: ticket!.id,
    ticketNumber,
    channelId: ticketChannel.id,
    userDiscordId: interaction.user.id,
    panelId: panel.id,
  });

  await interaction.editReply({
    content: `✅ Ticket created: ${ticketChannel}`,
  });
}

// ── Report Message ─────────────────────────────────────────

async function handleReportMessageModal(
  interaction: ModalSubmitInteraction,
  guild: Guild,
  supabase: SupabaseClient,
  messageId: string,
  channelId: string,
  authorId: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const reason = interaction.fields.getTextInputValue('report_reason');
  const category = interaction.fields.getTextInputValue('report_category') || 'other';

  // Get message content
  let messageContent = '[Could not fetch]';
  let messageUrl = '';
  try {
    const channel = guild.channels.cache.get(channelId);
    if (channel && channel.type === ChannelType.GuildText) {
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      messageContent = msg.content?.slice(0, 1000) || '[No content]';
      messageUrl = msg.url;
    }
  } catch {
    // Non-fatal
  }

  // Store report
  await supabase.from('message_reports').insert({
    guild_id: guild.id,
    message_id: messageId,
    channel_id: channelId,
    reported_user_id: authorId,
    reporter_user_id: interaction.user.id,
    reason,
    category,
    message_content: messageContent,
    status: 'pending',
  });

  // Send to mod log channel
  const { data: config } = await supabase
    .from('guild_config')
    .select('mod_log_channel_id')
    .eq('guild_id', guild.id)
    .maybeSingle();

  if (config?.mod_log_channel_id) {
    const logChannel = guild.channels.cache.get(config.mod_log_channel_id);
    if (logChannel && logChannel.type === ChannelType.GuildText) {
      const embed = new EmbedBuilder()
        .setColor(RED)
        .setTitle('🚨 Message Report')
        .addFields(
          { name: 'Reporter', value: `${interaction.user} (${interaction.user.id})`, inline: true },
          { name: 'Reported User', value: `<@${authorId}> (${authorId})`, inline: true },
          { name: 'Category', value: category, inline: true },
          { name: 'Reason', value: reason },
          {
            name: 'Message',
            value: messageUrl
              ? `[Jump to message](${messageUrl})\n>>> ${messageContent.slice(0, 500)}`
              : `>>> ${messageContent.slice(0, 500)}`,
          },
        )
        .setTimestamp();

      await (logChannel as TextChannel).send({ embeds: [embed] });
    }
  }

  await interaction.editReply({
    content: '✅ Report submitted. A moderator will review it shortly.',
  });
}

// ── Giveaway Create Modal ──────────────────────────────────

async function handleGiveawayCreateModal(
  interaction: ModalSubmitInteraction,
  guild: Guild,
  supabase: SupabaseClient,
  eventBus: PlatformEventBus,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  // This is handled by the giveaway manager — just parse fields
  await interaction.editReply({
    content: '✅ Giveaway creation is handled via `/giveaway create` for now.',
  });
}
