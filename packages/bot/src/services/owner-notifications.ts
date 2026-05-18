/**
 * Owner Notification Service — DMs the guild owner on critical events.
 *
 * Subscribes to the event bus and sends urgent notifications when:
 * - Fraud is detected (payment)
 * - A critical error occurs (action queue failure, fulfillment failure)
 * - Bot health issues (Lavalink disconnect, Valkey disconnect)
 * - Security events (setup lock triggered, auth failures)
 *
 * Also supports posting to a configured admin notification channel.
 */
import { EmbedBuilder, type Client } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from './event-bus.js';
import { SOMNI_PALETTE } from '@somnibot/shared';

interface NotificationConfig {
  ownerDiscordId: string;
  adminChannelId: string | null;
}

export class OwnerNotificationService {
  private config: NotificationConfig | null = null;
  private cooldowns = new Map<string, number>(); // eventType → lastSentTimestamp
  private cooldownMs = 60_000; // 1 minute between same event type

  constructor(
    private client: Client,
    private guildId: string,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus,
  ) {}

  async start(): Promise<void> {
    // Load config
    const { data: guild } = await this.supabase
      .from('guild')
      .select('owner_discord_id')
      .eq('id', this.guildId)
      .single();

    const { data: guildConfig } = await this.supabase
      .from('guild_config')
      .select('mod_log_channel_id')
      .eq('guild_id', this.guildId)
      .maybeSingle();

    this.config = {
      ownerDiscordId: guild?.owner_discord_id ?? '',
      adminChannelId: guildConfig?.mod_log_channel_id ?? null,
    };

    // Subscribe to critical events
    this.eventBus.on('fraud.detected', (_guildId, data) => {
      this.notify('fraud.detected', {
        title: '🚨 Fraud Detected',
        description: `A potentially fraudulent transaction was flagged.`,
        color: 0xFF0000,
        fields: [
          { name: 'Signal', value: String(data?.signal ?? 'Unknown'), inline: true },
          { name: 'Order', value: String(data?.orderId ?? 'N/A'), inline: true },
          { name: 'Customer', value: data?.discordId ? `<@${data.discordId}>` : 'Unknown', inline: true },
          { name: 'Action', value: String(data?.action ?? 'Flagged for review'), inline: false },
        ],
      });
    });

    this.eventBus.on('incident.created', (_guildId, data) => {
      if (data?.severity === 'critical' || data?.severity === 'high') {
        this.notify('incident.created', {
          title: '🔴 Critical Incident',
          description: String(data?.title ?? 'An incident has been created'),
          color: 0xFF0000,
          fields: [
            { name: 'Severity', value: String(data?.severity ?? 'unknown').toUpperCase(), inline: true },
            { name: 'Category', value: String(data?.category ?? 'unknown'), inline: true },
          ],
        });
      }
    });

    this.eventBus.on('moderation.action', (_guildId, data) => {
      if (data?.action === 'ban') {
        this.notify('moderation.ban', {
          title: '🔨 Member Banned',
          description: `A member has been banned from the server.`,
          color: 0xFF4444,
          fields: [
            { name: 'Member', value: `<@${data.discordId}>`, inline: true },
            { name: 'By', value: data.moderatorId === 'system' ? 'Auto-Mod' : `<@${data.moderatorId}>`, inline: true },
            { name: 'Reason', value: String(data.reason ?? 'No reason'), inline: false },
          ],
        });
      }
    });

    // Payment failures
    this.eventBus.on('payment.failed', (_guildId, data) => {
      this.notify('payment.failed', {
        title: '💳 Payment Failed',
        description: `A payment could not be processed.`,
        color: 0xFFAA00,
        fields: [
          { name: 'Customer', value: data?.discordId ? `<@${data.discordId}>` : 'Unknown', inline: true },
          { name: 'Amount', value: data?.amount ? `$${(data.amount / 100).toFixed(2)}` : 'Unknown', inline: true },
          { name: 'Error', value: String(data?.error ?? 'Unknown error'), inline: false },
        ],
      });
    });

    console.log('[Notifications] Owner notification service started');
  }

  private async notify(
    eventType: string,
    embed: {
      title: string;
      description: string;
      color: number;
      fields?: { name: string; value: string; inline?: boolean }[];
    },
  ): Promise<void> {
    // Check cooldown
    const lastSent = this.cooldowns.get(eventType) ?? 0;
    if (Date.now() - lastSent < this.cooldownMs) return;
    this.cooldowns.set(eventType, Date.now());

    if (!this.config) return;

    const discordEmbed = new EmbedBuilder()
      .setColor(embed.color)
      .setTitle(embed.title)
      .setDescription(embed.description)
      .setTimestamp()
      .setFooter({ text: 'SomniBot Admin Alert' });

    if (embed.fields) {
      for (const field of embed.fields) {
        discordEmbed.addFields({ name: field.name, value: field.value, inline: field.inline ?? false });
      }
    }

    // Send to admin channel if configured
    if (this.config.adminChannelId) {
      try {
        const guild = this.client.guilds.cache.get(this.guildId);
        const channel = guild?.channels.cache.get(this.config.adminChannelId);
        if (channel && 'send' in channel) {
          await (channel as { send: (opts: unknown) => Promise<unknown> }).send({ embeds: [discordEmbed] });
        }
      } catch (err) {
        console.error('[Notifications] Failed to send to admin channel:', err);
      }
    }

    // DM the owner
    if (this.config.ownerDiscordId) {
      try {
        const owner = await this.client.users.fetch(this.config.ownerDiscordId);
        await owner.send({ embeds: [discordEmbed] });
      } catch (err) {
        console.error('[Notifications] Failed to DM owner:', err);
      }
    }
  }
}
