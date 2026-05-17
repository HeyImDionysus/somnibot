/**
 * Ticket Service — Core CRUD and lifecycle management for tickets.
 *
 * Handles creating ticket channels, managing status transitions,
 * and coordinating with Supabase for persistence.
 *
 * Architecture doc §19.3, §19.4
 */

import {
  ChannelType,
  PermissionFlagsBits,
  type GuildMember,
  type TextChannel,
  type Guild,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type MessageActionRowComponentBuilder,
  EmbedBuilder,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbTicketPanel, DbTicket, TicketTypeConfig } from '@somnibot/shared';
import type { PlatformEventBus } from '../../services/event-bus.js';
import { SOMNI_PALETTE } from '@somnibot/shared';

// ── Ticket Number ────────────────────────────────────────

async function getNextTicketNumber(supabase: SupabaseClient, guildId: string): Promise<number> {
  const { data, error } = await supabase.rpc('nextval_ticket', {});
  if (error || data == null) {
    // Fallback: count existing tickets + 1
    const { count } = await supabase
      .from('tickets')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', guildId);
    return (count ?? 0) + 1;
  }
  return data as number;
}

// ── Create Ticket ────────────────────────────────────────

export async function createTicket(
  guild: Guild,
  member: GuildMember,
  panel: DbTicketPanel,
  ticketType: TicketTypeConfig,
  supabase: SupabaseClient,
  eventBus: PlatformEventBus,
): Promise<{ channel: TextChannel; ticket: DbTicket } | { error: string }> {
  // Check max open tickets per user
  const { count: openCount } = await supabase
    .from('tickets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guild.id)
    .eq('panel_id', panel.id)
    .eq('creator_id', member.id)
    .in('status', ['open', 'claimed']);

  if ((openCount ?? 0) >= panel.max_open_per_user) {
    return { error: `You already have ${openCount} open ticket(s). Maximum is ${panel.max_open_per_user}.` };
  }

  // Get next ticket number
  const ticketNumber = await getNextTicketNumber(supabase, guild.id);
  const channelName = `ticket-${ticketNumber}-${member.user.username}`.substring(0, 100);

  // Determine category
  const categoryId = ticketType.categoryOverride || panel.open_category_id;

  // Determine manager roles
  const managerRoles = ticketType.managerRoleOverride?.length
    ? ticketType.managerRoleOverride
    : panel.manager_roles;

  // Build permission overwrites
  const permissionOverwrites = [
    // Deny @everyone
    {
      id: guild.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    // Allow ticket creator
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    // Allow bot
    ...(guild.members.me
      ? [
          {
            id: guild.members.me.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageMessages,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
        ]
      : []),
    // Allow manager roles
    ...managerRoles.map((roleId) => ({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    })),
  ];

  // Create channel
  let channel: TextChannel;
  try {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites,
    });
  } catch (err) {
    console.error('[Tickets] Failed to create ticket channel:', err);
    return { error: 'Failed to create ticket channel. Check bot permissions.' };
  }

  // Build intro message
  const introText =
    ticketType.introMessageOverride ||
    panel.introduction_message ||
    `Welcome <@${member.id}>! A staff member will be with you shortly.`;

  const introEmbed = new EmbedBuilder()
    .setColor(SOMNI_PALETTE.CYAN)
    .setTitle(`🎫 Ticket #${ticketNumber} — ${ticketType.label}`)
    .setDescription(
      `${introText}\n\n💡 **Tip:** Include your order number (e.g., INS-00042) for faster assistance.`,
    )
    .setTimestamp()
    .setFooter({ text: `Ticket created by ${member.user.tag}` });

  const actionRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket:close:${ticketNumber}`)
      .setLabel('Close Ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ticket:claim:${ticketNumber}`)
      .setLabel('Claim')
      .setEmoji('🙋')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ticket:transcript:${ticketNumber}`)
      .setLabel('Transcript')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
  );

  await channel.send({ embeds: [introEmbed], components: [actionRow] });

  // Save ticket record
  const { data: ticket, error: dbError } = await supabase
    .from('tickets')
    .insert({
      guild_id: guild.id,
      panel_id: panel.id,
      channel_id: channel.id,
      ticket_number: ticketNumber,
      creator_id: member.id,
      type: ticketType.id,
      status: 'open',
      message_count: 0,
    })
    .select()
    .single();

  if (dbError || !ticket) {
    console.error('[Tickets] Failed to save ticket:', dbError?.message);
    // Clean up the channel
    await channel.delete().catch(() => {});
    return { error: 'Failed to save ticket to database.' };
  }

  // Fire event
  eventBus.emit('ticket.opened', guild.id, {
    ticketId: ticket.id,
    ticketNumber,
    channelId: channel.id,
    userDiscordId: member.id,
    panelId: panel.id,
  });

  console.log(`[Tickets] Created ticket #${ticketNumber} for ${member.user.tag} in ${channel.name}`);
  return { channel, ticket: ticket as DbTicket };
}

// ── Claim Ticket ─────────────────────────────────────────

export async function claimTicket(
  supabase: SupabaseClient,
  eventBus: PlatformEventBus,
  guildId: string,
  ticketNumber: number,
  claimedById: string,
): Promise<{ success: boolean; error?: string }> {
  const { data: ticket, error: fetchErr } = await supabase
    .from('tickets')
    .select('*')
    .eq('guild_id', guildId)
    .eq('ticket_number', ticketNumber)
    .single();

  if (fetchErr || !ticket) {
    return { success: false, error: 'Ticket not found.' };
  }
  if (ticket.status !== 'open') {
    return { success: false, error: `Ticket is already ${ticket.status}.` };
  }

  const { error: updateErr } = await supabase
    .from('tickets')
    .update({ status: 'claimed', claimed_by: claimedById })
    .eq('id', ticket.id);

  if (updateErr) {
    return { success: false, error: 'Failed to claim ticket.' };
  }

  eventBus.emit('ticket.claimed', guildId, {
    ticketId: ticket.id,
    ticketNumber,
    channelId: ticket.channel_id,
    userDiscordId: ticket.creator_id,
    panelId: ticket.panel_id,
  });

  console.log(`[Tickets] Ticket #${ticketNumber} claimed by ${claimedById}`);
  return { success: true };
}

// ── Close Ticket ─────────────────────────────────────────

export async function closeTicket(
  guild: Guild,
  supabase: SupabaseClient,
  eventBus: PlatformEventBus,
  ticketNumber: number,
  closedById: string,
  reason?: string,
): Promise<{ success: boolean; ticket?: DbTicket; error?: string }> {
  const { data: ticket, error: fetchErr } = await supabase
    .from('tickets')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('ticket_number', ticketNumber)
    .single();

  if (fetchErr || !ticket) {
    return { success: false, error: 'Ticket not found.' };
  }
  if (ticket.status === 'closed' || ticket.status === 'deleted') {
    return { success: false, error: `Ticket is already ${ticket.status}.` };
  }

  // Update DB
  const { error: updateErr } = await supabase
    .from('tickets')
    .update({
      status: 'closed',
      closed_by: closedById,
      close_reason: reason || null,
      closed_at: new Date().toISOString(),
    })
    .eq('id', ticket.id);

  if (updateErr) {
    return { success: false, error: 'Failed to close ticket.' };
  }

  // Lock channel permissions — remove send messages from everyone except bot
  const channel = guild.channels.cache.get(ticket.channel_id) as TextChannel | undefined;
  if (channel) {
    try {
      // Lock the channel for the creator
      await channel.permissionOverwrites.edit(ticket.creator_id, {
        SendMessages: false,
      });
      // Post closing message
      const closeEmbed = new EmbedBuilder()
        .setColor(SOMNI_PALETTE.HOT_PINK)
        .setTitle('🔒 Ticket Closed')
        .setDescription(
          `Closed by <@${closedById}>${reason ? `\n**Reason:** ${reason}` : ''}\n\nThis ticket is now locked. A transcript has been saved.`,
        )
        .setTimestamp();

      const reopenRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ticket:reopen:${ticketNumber}`)
          .setLabel('Reopen')
          .setEmoji('🔓')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`ticket:delete:${ticketNumber}`)
          .setLabel('Delete')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger),
      );

      await channel.send({ embeds: [closeEmbed], components: [reopenRow] });

      // Move to closed category if configured
      const { data: panel } = await supabase
        .from('ticket_panels')
        .select('closed_category_id')
        .eq('id', ticket.panel_id)
        .single();

      if (panel?.closed_category_id) {
        await channel.setParent(panel.closed_category_id, { lockPermissions: false }).catch(() => {});
      }
    } catch (err) {
      console.error('[Tickets] Failed to lock channel:', err);
    }
  }

  // Fire event
  eventBus.emit('ticket.closed', guild.id, {
    ticketId: ticket.id,
    ticketNumber,
    channelId: ticket.channel_id,
    userDiscordId: ticket.creator_id,
    panelId: ticket.panel_id,
  });

  console.log(`[Tickets] Ticket #${ticketNumber} closed by ${closedById}`);
  return { success: true, ticket: { ...ticket, status: 'closed', closed_by: closedById } as DbTicket };
}

// ── Reopen Ticket ────────────────────────────────────────

export async function reopenTicket(
  guild: Guild,
  supabase: SupabaseClient,
  eventBus: PlatformEventBus,
  ticketNumber: number,
  reopenedById: string,
): Promise<{ success: boolean; error?: string }> {
  const { data: ticket, error: fetchErr } = await supabase
    .from('tickets')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('ticket_number', ticketNumber)
    .single();

  if (fetchErr || !ticket) {
    return { success: false, error: 'Ticket not found.' };
  }
  if (ticket.status !== 'closed') {
    return { success: false, error: 'Only closed tickets can be reopened.' };
  }

  const { error: updateErr } = await supabase
    .from('tickets')
    .update({
      status: 'open',
      closed_by: null,
      close_reason: null,
      closed_at: null,
    })
    .eq('id', ticket.id);

  if (updateErr) {
    return { success: false, error: 'Failed to reopen ticket.' };
  }

  // Restore channel permissions
  const channel = guild.channels.cache.get(ticket.channel_id) as TextChannel | undefined;
  if (channel) {
    try {
      await channel.permissionOverwrites.edit(ticket.creator_id, {
        SendMessages: true,
      });

      // Move back to open category
      const { data: panel } = await supabase
        .from('ticket_panels')
        .select('open_category_id')
        .eq('id', ticket.panel_id)
        .single();

      if (panel?.open_category_id) {
        await channel.setParent(panel.open_category_id, { lockPermissions: false }).catch(() => {});
      }

      const reopenEmbed = new EmbedBuilder()
        .setColor(SOMNI_PALETTE.CYAN)
        .setTitle('🔓 Ticket Reopened')
        .setDescription(`Reopened by <@${reopenedById}>. You can continue the conversation.`)
        .setTimestamp();

      await channel.send({ embeds: [reopenEmbed] });
    } catch (err) {
      console.error('[Tickets] Failed to unlock channel:', err);
    }
  }

  eventBus.emit('ticket.reopened', guild.id, {
    ticketId: ticket.id,
    ticketNumber,
    channelId: ticket.channel_id,
    userDiscordId: ticket.creator_id,
    panelId: ticket.panel_id,
  });

  console.log(`[Tickets] Ticket #${ticketNumber} reopened by ${reopenedById}`);
  return { success: true };
}

// ── Delete Ticket ────────────────────────────────────────

export async function deleteTicket(
  guild: Guild,
  supabase: SupabaseClient,
  ticketNumber: number,
): Promise<{ success: boolean; error?: string }> {
  const { data: ticket, error: fetchErr } = await supabase
    .from('tickets')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('ticket_number', ticketNumber)
    .single();

  if (fetchErr || !ticket) {
    return { success: false, error: 'Ticket not found.' };
  }

  // Update status to deleted
  await supabase
    .from('tickets')
    .update({ status: 'deleted', deleted_at: new Date().toISOString() })
    .eq('id', ticket.id);

  // Delete the Discord channel
  const channel = guild.channels.cache.get(ticket.channel_id);
  if (channel) {
    try {
      await channel.delete('Ticket deleted');
    } catch (err) {
      console.error('[Tickets] Failed to delete channel:', err);
    }
  }

  console.log(`[Tickets] Ticket #${ticketNumber} deleted`);
  return { success: true };
}

// ── Add User to Ticket ───────────────────────────────────

export async function addUserToTicket(
  guild: Guild,
  supabase: SupabaseClient,
  ticketNumber: number,
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  const { data: ticket, error: fetchErr } = await supabase
    .from('tickets')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('ticket_number', ticketNumber)
    .single();

  if (fetchErr || !ticket) {
    return { success: false, error: 'Ticket not found.' };
  }

  const channel = guild.channels.cache.get(ticket.channel_id) as TextChannel | undefined;
  if (!channel) {
    return { success: false, error: 'Ticket channel not found.' };
  }

  try {
    await channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
    return { success: true };
  } catch {
    return { success: false, error: 'Failed to add user to ticket.' };
  }
}

// ── Remove User from Ticket ─────────────────────────────

export async function removeUserFromTicket(
  guild: Guild,
  supabase: SupabaseClient,
  ticketNumber: number,
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  const { data: ticket, error: fetchErr } = await supabase
    .from('tickets')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('ticket_number', ticketNumber)
    .single();

  if (fetchErr || !ticket) {
    return { success: false, error: 'Ticket not found.' };
  }

  const channel = guild.channels.cache.get(ticket.channel_id) as TextChannel | undefined;
  if (!channel) {
    return { success: false, error: 'Ticket channel not found.' };
  }

  try {
    await channel.permissionOverwrites.delete(userId);
    return { success: true };
  } catch {
    return { success: false, error: 'Failed to remove user from ticket.' };
  }
}
