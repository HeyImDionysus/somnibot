/**
 * StatsChannelManager — updates voice channel names with live server stats.
 *
 * Discord rate-limits channel name changes to 2 per 10 minutes per channel,
 * so we batch updates and respect the configured interval (default 10 min).
 */
import {
  ChannelType,
  type Guild,
  type VoiceChannel,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('StatsManager');

export interface StatsChannelConfig {
  id: string;
  guild_id: string;
  channel_id: string | null;
  stat_type: string;
  stat_config: Record<string, unknown>;
  name_format: string;
  active: boolean;
  last_value: string | null;
}

export class StatsChannelManager {
  private channels: StatsChannelConfig[] = [];
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    intervalMinutes: number = 10,
  ) {
    this.intervalMs = intervalMinutes * 60_000;
  }

  async start(): Promise<void> {
    await this.loadChannels();

    if (this.channels.length === 0) {
      log.info('No stats channels configured');
      return;
    }

    // Run initial update
    await this.updateAll();

    // Schedule periodic updates
    this.timer = setInterval(() => {
      this.updateAll().catch((err) => {
        log.error('Update error:', { error: String(err) });
      });
    }, this.intervalMs);

    log.info(`Started ${this.channels.length} stats channels (interval: ${this.intervalMs / 60000}m)`);
  }

  async reload(): Promise<void> {
    await this.loadChannels();
    await this.updateAll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async loadChannels(): Promise<void> {
    const { data } = await this.supabase
      .from('stats_channels')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('active', true);

    this.channels = (data ?? []) as StatsChannelConfig[];
  }

  private async updateAll(): Promise<void> {
    // Fetch all needed stats once
    const stats = await this.gatherStats();

    for (const config of this.channels) {
      try {
        const value = this.resolveStatValue(config, stats);
        const newName = config.name_format.replace('{value}', value).replace('{count}', value);

        // Only update if value changed
        if (config.last_value === value && config.channel_id) {
          continue;
        }

        if (config.channel_id) {
          const channel = this.guild.channels.cache.get(config.channel_id) as VoiceChannel | undefined;
          if (channel) {
            await channel.setName(newName);
          }
        } else {
          // Create the voice channel if it doesn't exist yet
          const configObj = config.stat_config ?? {};
          const categoryId = typeof configObj === 'object' && 'category_id' in configObj
            ? (configObj as Record<string, string>).category_id
            : undefined;

          const channel = await this.guild.channels.create({
            name: newName,
            type: ChannelType.GuildVoice,
            parent: categoryId ?? undefined,
            permissionOverwrites: [
              {
                id: this.guild.id,
                deny: ['Connect'],
                allow: ['ViewChannel'],
              },
            ],
          });

          config.channel_id = channel.id;

          await this.supabase
            .from('stats_channels')
            .update({ channel_id: channel.id })
            .eq('id', config.id);
        }

        // Update last value
        config.last_value = value;
        await this.supabase
          .from('stats_channels')
          .update({ last_value: value, last_updated_at: new Date().toISOString() })
          .eq('id', config.id);
      } catch (err) {
        log.error(`Failed to update ${config.stat_type}:`, err);
      }
    }
  }

  private async gatherStats(): Promise<Record<string, string>> {
    const guild = this.guild;
    await guild.members.fetch().catch((e: unknown) => { log.warn('Failed to fetch members:', (e as Error)?.message ?? e); }); // ensure cache is populated

    const totalMembers = guild.memberCount;
    const onlineMembers = guild.members.cache.filter(
      (m) => m.presence?.status !== 'offline' && m.presence?.status != null,
    ).size;
    const botCount = guild.members.cache.filter((m) => m.user.bot).size;
    const roleCount = guild.roles.cache.size - 1; // Exclude @everyone
    const channelCount = guild.channels.cache.size;
    const premiumMembers = guild.premiumSubscriptionCount ?? 0;

    // Supabase stats
    let activeTickets = 0;
    let totalXp = 0;
    let highestLevel = 0;

    try {
      const { count } = await this.supabase
        .from('tickets')
        .select('id', { count: 'exact', head: true })
        .eq('guild_id', guild.id)
        .in('status', ['open', 'claimed']);
      activeTickets = count ?? 0;
    } catch { /* ignore */ }

    try {
      const { data } = await this.supabase
        .from('member_levels')
        .select('xp, level')
        .eq('guild_id', guild.id)
        .order('level', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        highestLevel = data.level ?? 0;
      }
      // Total XP — rpc may return a single number or object
      try {
        const { data: xpData } = await this.supabase
          .rpc('sum_guild_xp', { g_id: guild.id });
        totalXp = typeof xpData === 'number' ? xpData : 0;
      } catch { /* rpc may not exist */ }
    } catch { /* ignore */ }

    return {
      total_members: String(totalMembers),
      online_members: String(onlineMembers),
      bot_count: String(botCount),
      role_count: String(roleCount),
      channel_count: String(channelCount),
      premium_members: String(premiumMembers),
      active_tickets: String(activeTickets),
      total_xp_earned: String(totalXp),
      highest_level: String(highestLevel),
    };
  }

  private resolveStatValue(
    config: StatsChannelConfig,
    stats: Record<string, string>,
  ): string {
    if (config.stat_type === 'custom_counter') {
      const configObj = config.stat_config as Record<string, unknown> | undefined;
      return String(configObj?.value ?? '0');
    }
    return stats[config.stat_type] ?? '0';
  }
}
