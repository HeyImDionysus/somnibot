/**
 * ForumTickets — Support creating tickets as forum channel posts.
 *
 * Instead of (or in addition to) private channels, tickets can be created
 * as threads in a designated forum channel. This gives Discord-native
 * tagging, search, and archival.
 *
 * GAP 5: Discord Native Potential — Forum channel tickets
 */

import {
  Guild,
  ForumChannel,
  ChannelType,
  ThreadAutoArchiveDuration,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildForumTag,
} from 'discord.js';
import { SupabaseClient } from '@supabase/supabase-js';

export interface ForumTicketConfig {
  forum_channel_id: string;
  /** Map ticket types to forum tag IDs */
  type_tag_map: Record<string, string>;
  /** Tag ID for open tickets */
  open_tag_id?: string;
  /** Tag ID for closed tickets */
  closed_tag_id?: string;
  auto_archive_hours: number;
}

export class ForumTicketService {
  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
  ) {}

  /**
   * Create a ticket as a forum thread post.
   */
  async createForumTicket(options: {
    userId: string;
    ticketType: string;
    subject: string;
    description: string;
    panelId: string;
  }): Promise<{ threadId: string; ticketId: string } | null> {
    // Load forum config
    const { data: config } = await this.supabase
      .from('ticket_panels')
      .select('forum_config')
      .eq('id', options.panelId)
      .maybeSingle();

    const forumConfig = config?.forum_config as ForumTicketConfig | null;
    if (!forumConfig?.forum_channel_id) return null;

    const forumChannel = this.guild.channels.cache.get(forumConfig.forum_channel_id);
    if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
      console.error(`[ForumTickets] Channel ${forumConfig.forum_channel_id} is not a forum channel`);
      return null;
    }

    const forum = forumChannel as ForumChannel;

    // Build tags for the post
    const appliedTags: string[] = [];
    if (forumConfig.type_tag_map[options.ticketType]) {
      appliedTags.push(forumConfig.type_tag_map[options.ticketType]);
    }
    if (forumConfig.open_tag_id) {
      appliedTags.push(forumConfig.open_tag_id);
    }

    // Create the forum thread
    const embed = new EmbedBuilder()
      .setTitle(`🎫 ${options.subject}`)
      .setDescription(options.description || 'No description provided.')
      .addFields(
        { name: 'Type', value: options.ticketType, inline: true },
        { name: 'Created by', value: `<@${options.userId}>`, inline: true },
        { name: 'Status', value: '🟢 Open', inline: true },
      )
      .setColor(0x5865f2)
      .setTimestamp();

    const closeButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_close')
        .setLabel('Close Ticket')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒'),
      new ButtonBuilder()
        .setCustomId('ticket_claim')
        .setLabel('Claim')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('✋'),
    );

    const archiveHours = forumConfig.auto_archive_hours || 72;
    const archiveDuration = archiveHours <= 1
      ? ThreadAutoArchiveDuration.OneHour
      : archiveHours <= 24
        ? ThreadAutoArchiveDuration.OneDay
        : archiveHours <= 72
          ? ThreadAutoArchiveDuration.ThreeDays
          : ThreadAutoArchiveDuration.OneWeek;

    try {
      const thread = await forum.threads.create({
        name: `[${options.ticketType}] ${options.subject}`.slice(0, 100),
        autoArchiveDuration: archiveDuration,
        message: {
          content: `<@${options.userId}> opened a ticket.`,
          embeds: [embed],
          components: [closeButton],
        },
        appliedTags: appliedTags.slice(0, 5), // Discord limit
      });

      // Store in DB
      const { data: ticket, error } = await this.supabase
        .from('tickets')
        .insert({
          guild_id: this.guild.id,
          channel_id: thread.id,
          creator_id: options.userId,
          panel_id: options.panelId,
          ticket_type: options.ticketType,
          subject: options.subject,
          description: options.description,
          status: 'open',
          is_forum_ticket: true,
          forum_thread_id: thread.id,
        })
        .select('id')
        .single();

      if (error) {
        console.error('[ForumTickets] DB insert failed:', error.message);
        return null;
      }

      return { threadId: thread.id, ticketId: ticket.id };
    } catch (err) {
      console.error('[ForumTickets] Failed to create forum ticket:', err);
      return null;
    }
  }

  /**
   * Close a forum ticket — apply closed tag, lock thread, archive.
   */
  async closeForumTicket(ticketId: string): Promise<boolean> {
    const { data: ticket } = await this.supabase
      .from('tickets')
      .select('forum_thread_id, panel_id')
      .eq('id', ticketId)
      .eq('is_forum_ticket', true)
      .maybeSingle();

    if (!ticket?.forum_thread_id) return false;

    // Load forum config for tags
    const { data: panel } = await this.supabase
      .from('ticket_panels')
      .select('forum_config')
      .eq('id', ticket.panel_id)
      .maybeSingle();

    const forumConfig = panel?.forum_config as ForumTicketConfig | null;

    try {
      const thread = await this.guild.channels.fetch(ticket.forum_thread_id).catch(() => null);
      if (!thread || !thread.isThread()) return false;

      // Update tags — remove open, add closed
      if (forumConfig) {
        const currentTags = (thread as unknown as { appliedTags: string[] }).appliedTags ?? [];
        let newTags = currentTags.filter((t: string) => t !== forumConfig.open_tag_id);
        if (forumConfig.closed_tag_id) {
          newTags.push(forumConfig.closed_tag_id);
        }
        newTags = [...new Set(newTags)].slice(0, 5);
        await thread.edit({ appliedTags: newTags }).catch(() => {});
      }

      // Send close message
      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setDescription('🔒 This ticket has been closed.')
            .setColor(0xed4245)
            .setTimestamp(),
        ],
      }).catch(() => {});

      // Lock and archive
      await thread.setLocked(true, 'Ticket closed').catch(() => {});
      await thread.setArchived(true, 'Ticket closed').catch(() => {});

      return true;
    } catch (err) {
      console.error(`[ForumTickets] Failed to close forum ticket ${ticketId}:`, err);
      return false;
    }
  }
}
