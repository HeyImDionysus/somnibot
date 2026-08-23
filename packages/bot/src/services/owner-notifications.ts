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
import { SOMNI_PALETTE , createLogger } from '@somnibot/shared';
import type {
  PlatformEvent,
  PlatformEventMap,
  PlatformEventType,
} from '@somnibot/shared';

const log = createLogger('OwnerNotify');

interface NotificationConfig {
  ownerDiscordId: string;
  adminChannelId: string | null;
  // commerce-fraud controls (staff-alert-channel / owner-dm-on-critical).
  fraudStaffChannelId: string | null;
  fraudOwnerDmOnCritical: boolean;
}

export class OwnerNotificationService {
  private config: NotificationConfig | null = null;
  private cooldowns = new Map<string, number>(); // eventType → lastSentTimestamp
  private cooldownMs = 60_000; // 1 minute between same event type
  // V10 Audit M-5: Store listener references so stop() can remove them.
  private listenerDisposers: Array<() => void> = [];

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
      .select('mod_log_channel_id, fraud_staff_alert_channel_id, fraud_owner_dm_on_critical')
      .eq('guild_id', this.guildId)
      .maybeSingle();

    const rawStaffChannel = guildConfig?.fraud_staff_alert_channel_id ?? null;

    this.config = {
      ownerDiscordId: guild?.owner_discord_id ?? '',
      adminChannelId: guildConfig?.mod_log_channel_id ?? null,
      // Treat empty string (catalog default for staff-alert-channel) as unset.
      fraudStaffChannelId: rawStaffChannel && rawStaffChannel.length > 0 ? rawStaffChannel : null,
      fraudOwnerDmOnCritical: guildConfig?.fraud_owner_dm_on_critical ?? true,
    };

    // Subscribe to critical events — store references for stop() cleanup.

    // fraud.detected — emitted by fraud-detection service when signals are created.
    // Contract (commerce-fraud): mirror every fraud alert to the configured staff
    // channel, and DM the owner ONLY for critical signals when owner-dm-on-critical
    // is on — never leak buyer payment details.
    this.listen('fraud.detected', (event) => {
      const data = event.data;
      const severity = String(data.severity ?? '');
      void this.notifyFraud(severity, data);
    });

    // incident.created — emitted when a critical incident is auto-created
    this.listen('incident.created', (event) => {
      const data = event.data;
      const severity = String(data.severity ?? '');
      if (severity === 'critical' || severity === 'high') {
        this.notify('incident.created', {
          title: '🔴 Critical Incident',
          description: String(data.title ?? 'An incident has been created'),
          color: 0xFF0000,
          fields: [
            { name: 'Severity', value: severity.toUpperCase(), inline: true },
            { name: 'Category', value: String(data.category ?? 'unknown'), inline: true },
          ],
        });
      }
    });

    // moderation.action — emitted by moderation/commands.ts on warn, mute, kick, ban
    this.listen('moderation.action', (event) => {
      const data = event.data;
      if (data.action === 'ban') {
        this.notify('moderation.ban', {
          title: '🔨 Member Banned',
          description: `A member has been banned from the server.`,
          color: 0xFF4444,
          fields: [
            { name: 'Member', value: `<@${String(data.discordId)}>`, inline: true },
            { name: 'By', value: data.moderatorId === 'system' ? 'Auto-Mod' : `<@${String(data.moderatorId)}>`, inline: true },
            { name: 'Reason', value: String(data.reason ?? 'No reason'), inline: false },
          ],
        });
      }
    });

    // payment.failed — emitted by commerce-fulfillment on subscription_payment_failed
    this.listen('payment.failed', (event) => {
      const data = event.data;
      this.notify('payment.failed', {
        title: '💳 Payment Failed',
        description: `A payment could not be processed.`,
        color: 0xFFAA00,
        fields: [
          { name: 'Customer', value: data.discordId ? `<@${String(data.discordId)}>` : 'Unknown', inline: true },
          { name: 'Amount', value: data.amount ? `$${(Number(data.amount) / 100).toFixed(2)}` : 'Unknown', inline: true },
          { name: 'Error', value: String(data.error ?? 'Unknown error'), inline: false },
        ],
      });
    });

    log.info('Owner notification service started');
  }

  /**
   * V10 Audit M-5: Remove all event listeners registered by this service.
   */
  stop(): void {
    for (const dispose of this.listenerDisposers) dispose();
    this.listenerDisposers = [];
    log.info('Owner notification service stopped');
  }

  /**
   * Register a listener on the event bus and store the reference for cleanup.
   */
  private listen<T extends PlatformEventType>(
    type: T,
    handler: (event: PlatformEvent<T, PlatformEventMap[T]>) => void,
  ): void {
    const scopedHandler = (event: PlatformEvent<T, PlatformEventMap[T]>): void => {
      if (event.guildId !== this.guildId) return;
      handler(event);
    };
    this.eventBus.on(type, scopedHandler);
    this.listenerDisposers.push(() => this.eventBus.off(type, scopedHandler));
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
        log.error('Failed to send to admin channel:', { error: String(err) });
      }
    }

    // DM the owner
    if (this.config.ownerDiscordId) {
      try {
        const owner = await this.client.users.fetch(this.config.ownerDiscordId);
        await owner.send({ embeds: [discordEmbed] });
      } catch (err) {
        log.error('Failed to DM owner:', { error: String(err) });
      }
    }
  }

  /**
   * Fraud-specific notification honoring the commerce-fraud contract:
   *  - mirror EVERY fraud signal to the configured staff channel (if set),
   *    carrying only type/severity/subject — never buyer payment details;
   *  - DM the owner ONLY for critical signals and only when
   *    owner-dm-on-critical is enabled (default true), throttled by cooldown.
   */
  private async notifyFraud(
    severity: string,
    data: PlatformEventMap['fraud.detected'],
  ): Promise<void> {
    if (!this.config) return;

    const discordEmbed = new EmbedBuilder()
      .setColor(severity === 'critical' ? 0xFF0000 : 0xFFAA00)
      .setTitle('🚨 Fraud Signal')
      .setDescription('A potentially fraudulent pattern was flagged for review.')
      .setTimestamp()
      .setFooter({ text: 'SomniBot Fraud Alert' })
      .addFields(
        { name: 'Signal', value: String(data.signal ?? 'Unknown'), inline: true },
        { name: 'Severity', value: (severity || 'unknown').toUpperCase(), inline: true },
        { name: 'Subject', value: data.discordId ? `<@${String(data.discordId)}>` : 'Unknown', inline: true },
      );

    // Staff-channel mirror — every fraud signal, no payment details.
    if (this.config.fraudStaffChannelId) {
      try {
        const guild = this.client.guilds.cache.get(this.guildId);
        const channel = guild?.channels.cache.get(this.config.fraudStaffChannelId);
        if (channel && 'send' in channel) {
          await (channel as { send: (opts: unknown) => Promise<unknown> }).send({ embeds: [discordEmbed] });
        }
      } catch (err) {
        log.error('Failed to mirror fraud alert to staff channel:', { error: String(err) });
      }
    }

    // Owner DM — critical only, gated on the owner-dm-on-critical toggle.
    if (severity !== 'critical' || !this.config.fraudOwnerDmOnCritical) return;

    const lastSent = this.cooldowns.get('fraud.detected') ?? 0;
    if (Date.now() - lastSent < this.cooldownMs) return;
    this.cooldowns.set('fraud.detected', Date.now());

    if (this.config.ownerDiscordId) {
      try {
        const owner = await this.client.users.fetch(this.config.ownerDiscordId);
        await owner.send({ embeds: [discordEmbed] });
      } catch (err) {
        log.error('Failed to DM owner:', { error: String(err) });
      }
    }
  }
}
