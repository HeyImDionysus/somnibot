/**
 * TempChannelManager — manages hub config + active temp channels in Supabase.
 */
import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type VoiceChannel,
  type CategoryChannel,
  type GuildMember,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('TempChannels');


export interface HubConfig {
  id: string;
  guild_id: string;
  hub_channel_id: string;
  category_id: string;
  naming_format: string;
  default_user_limit: number;
  default_bitrate: number;
  keep_alive_minutes: number;
  allow_text_channel: boolean;
  moderator_roles: string[];
  active: boolean;
}

export interface ActiveTempChannel {
  channel_id: string;
  text_channel_id: string | null;
  guild_id: string;
  hub_id: string;
  owner_id: string;
}

export class TempChannelManager {
  private hubs: Map<string, HubConfig> = new Map(); // hub_channel_id → config
  private activeChannels: Map<string, ActiveTempChannel> = new Map(); // channel_id → active
  private keepAliveTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
  ) {}

  async start(): Promise<void> {
    // Load hub configs
    const { data: hubs } = await this.supabase
      .from('temp_channel_hubs')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .limit(1000);

    if (hubs) {
      for (const hub of hubs) {
        this.hubs.set(hub.hub_channel_id, hub as HubConfig);
      }
    }

    // Load active temp channels (in case of restart)
    const { data: active } = await this.supabase
      .from('active_temp_channels')
      .select('*')
      .eq('guild_id', this.guild.id)
      .limit(1000);

    if (active) {
      for (const ch of active) {
        this.activeChannels.set(ch.channel_id, ch as ActiveTempChannel);
      }
    }

    // Clean up any orphaned channels
    await this.cleanupOrphans();

    log.info(`Loaded ${this.hubs.size} hubs, ${this.activeChannels.size} active channels`);
  }

  isHubChannel(channelId: string): boolean {
    return this.hubs.has(channelId);
  }

  isTempChannel(channelId: string): boolean {
    return this.activeChannels.has(channelId);
  }

  getChannelOwner(channelId: string): string | null {
    return this.activeChannels.get(channelId)?.owner_id ?? null;
  }

  getHubForChannel(channelId: string): HubConfig | null {
    const active = this.activeChannels.get(channelId);
    if (!active) return null;
    for (const hub of this.hubs.values()) {
      if (hub.id === active.hub_id) return hub;
    }
    return null;
  }

  /**
   * Handle a user joining a hub voice channel.
   */
  async handleJoinHub(member: GuildMember, hubChannelId: string): Promise<void> {
    const hub = this.hubs.get(hubChannelId);
    if (!hub) return;

    // Format channel name
    const channelName = hub.naming_format
      .replace('{username}', member.displayName)
      .replace('{user}', member.displayName)
      .replace('{tag}', member.user.username)
      .replace('{count}', String(this.activeChannels.size + 1));

    try {
      const category = this.guild.channels.cache.get(hub.category_id) as CategoryChannel | undefined;

      // Create the voice channel
      const vc = await this.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        parent: category ?? undefined,
        userLimit: hub.default_user_limit || undefined,
        bitrate: hub.default_bitrate,
        permissionOverwrites: [
          {
            id: member.id,
            allow: [
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.MoveMembers,
              PermissionFlagsBits.MuteMembers,
              PermissionFlagsBits.DeafenMembers,
            ],
          },
        ],
      });

      let textChannelId: string | null = null;

      // Optionally create a paired text channel
      if (hub.allow_text_channel) {
        try {
          const tc = await this.guild.channels.create({
            name: `${channelName}-chat`,
            type: ChannelType.GuildText,
            parent: category ?? undefined,
            permissionOverwrites: [
              {
                id: this.guild.id, // @everyone
                deny: [PermissionFlagsBits.ViewChannel],
              },
              {
                id: member.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ManageMessages,
                ],
              },
            ],
          });
          textChannelId = tc.id;
        } catch (err) {
          log.error('Failed to create text channel:', { error: String(err) });
        }
      }

      // Record in DB
      const record: ActiveTempChannel = {
        channel_id: vc.id,
        text_channel_id: textChannelId,
        guild_id: this.guild.id,
        hub_id: hub.id,
        owner_id: member.id,
      };

      await this.supabase.from('active_temp_channels').insert(record);
      this.activeChannels.set(vc.id, record);

      // Move the member to the new channel
      await member.voice.setChannel(vc);

      log.info(`Created "${vc.name}" for ${member.user.username}`);
    } catch (err) {
      log.error('Failed to create temp channel:', { error: String(err) });
    }
  }

  /**
   * Handle a user leaving a temp voice channel — delete if empty (after keep-alive).
   */
  async handleLeaveTemp(channelId: string): Promise<void> {
    const active = this.activeChannels.get(channelId);
    if (!active) return;

    const vc = this.guild.channels.cache.get(channelId) as VoiceChannel | undefined;
    if (!vc) {
      // Channel already gone — clean up record
      await this.removeChannel(channelId);
      return;
    }

    if (vc.members.filter((m) => !m.user.bot).size > 0) {
      // Still people in the channel, cancel any pending delete
      const timer = this.keepAliveTimers.get(channelId);
      if (timer) {
        clearTimeout(timer);
        this.keepAliveTimers.delete(channelId);
      }
      return;
    }

    // Channel empty — start keep-alive countdown
    const hub = this.getHubForChannel(channelId);
    const keepAliveMs = ((hub?.keep_alive_minutes ?? 1) * 60_000);

    // Cancel any existing timer
    const existing = this.keepAliveTimers.get(channelId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      try {
        // Double-check still empty
        const freshVc = this.guild.channels.cache.get(channelId) as VoiceChannel | undefined;
        if (freshVc && freshVc.members.filter((m) => !m.user.bot).size === 0) {
          await this.deleteChannel(channelId);
        }
      } catch (err) {
        log.error('Keep-alive cleanup error:', { error: String(err) });
      }
      this.keepAliveTimers.delete(channelId);
    }, keepAliveMs);

    this.keepAliveTimers.set(channelId, timer);
  }

  /**
   * Delete a temp channel and its paired text channel.
   */
  async deleteChannel(channelId: string): Promise<void> {
    const active = this.activeChannels.get(channelId);
    if (!active) return;

    try {
      const vc = this.guild.channels.cache.get(channelId);
      if (vc) await vc.delete('Temp channel empty');
    } catch {
      // Channel may already be deleted
    }

    if (active.text_channel_id) {
      try {
        const tc = this.guild.channels.cache.get(active.text_channel_id);
        if (tc) await tc.delete('Temp text channel cleanup');
      } catch {
        // Ignore
      }
    }

    await this.removeChannel(channelId);
    log.info(`Deleted temp channel ${channelId}`);
  }

  /**
   * Transfer ownership of a temp channel.
   */
  async transferOwnership(channelId: string, newOwnerId: string): Promise<void> {
    const active = this.activeChannels.get(channelId);
    if (!active) return;

    const oldOwnerId = active.owner_id;
    active.owner_id = newOwnerId;

    // Update permissions
    const vc = this.guild.channels.cache.get(channelId) as VoiceChannel | undefined;
    if (vc) {
      try {
        // Remove old owner overwrite
        await vc.permissionOverwrites.delete(oldOwnerId).catch((e: unknown) => { /* channel/user may not exist */; });
        // Add new owner overwrite
        await vc.permissionOverwrites.create(newOwnerId, {
          ManageChannels: true,
          MoveMembers: true,
          MuteMembers: true,
          DeafenMembers: true,
        });
      } catch (err) {
        log.error('Failed to update permissions:', { error: String(err) });
      }
    }

    await this.supabase
      .from('active_temp_channels')
      .update({ owner_id: newOwnerId })
      .eq('channel_id', channelId);
  }

  /**
   * Reload hub config from DB (e.g., after dashboard update).
   */
  async reloadHubs(): Promise<void> {
    this.hubs.clear();
    const { data: hubs } = await this.supabase
      .from('temp_channel_hubs')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .limit(1000);

    if (hubs) {
      for (const hub of hubs) {
        this.hubs.set(hub.hub_channel_id, hub as HubConfig);
      }
    }
  }

  private async removeChannel(channelId: string): Promise<void> {
    this.activeChannels.delete(channelId);
    const timer = this.keepAliveTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this.keepAliveTimers.delete(channelId);
    }
    await this.supabase
      .from('active_temp_channels')
      .delete()
      .eq('channel_id', channelId);
  }

  private async cleanupOrphans(): Promise<void> {
    // Remove DB records for channels that no longer exist in Discord
    for (const [channelId] of this.activeChannels) {
      const vc = this.guild.channels.cache.get(channelId);
      if (!vc) {
        await this.removeChannel(channelId);
      }
    }
  }

  stop(): void {
    for (const timer of this.keepAliveTimers.values()) {
      clearTimeout(timer);
    }
    this.keepAliveTimers.clear();
  }
}
