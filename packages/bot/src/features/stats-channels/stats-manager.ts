/**
 * StatsChannelManager — updates voice channel names with live server stats.
 *
 * Discord rate-limits channel name changes to 2 per 10 minutes per channel,
 * so we batch updates and respect the configured interval (default 10 min).
 */
import {
  ChannelType,
  RESTJSONErrorCodes,
  type Guild,
  type VoiceChannel,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { eventBus as defaultEventBus, type PlatformEventBus } from '../../services/event-bus.js';
import { createLogger } from '@somnibot/shared';
import { raiseOwnerAlert, resolveOwnerAlertWithStatus } from '../../services/alert-service.js';

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
  /**
   * Discord channel ids created for this counter whose identity write failed:
   * durable pointers so an abort survivor is recovered (adopted or deleted)
   * instead of orphaned behind a log line.
   */
  pending_cleanup_channel_ids: string[] | null;
}

export class StatsChannelManager {
  private channels: StatsChannelConfig[] = [];
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private degradedChannels = new Set<string>();
  /**
   * configId → channelId for counters whose identity write stayed AMBIGUOUS
   * (every attempt errored and the read-back failed too). While listed, the
   * create branch retries THIS channel's identity instead of minting another
   * counter every interval during a database outage.
   */
  private ambiguousChannels = new Map<string, string>();
  private alertedDegradedChannels = new Set<string>();
  private recoveryChecked = new Set<string>();

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    intervalMinutes: number = 10,
    private eventBus: PlatformEventBus = defaultEventBus,
  ) {
    this.intervalMs = intervalMinutes * 60_000;
  }

  async start(): Promise<void> {
    await this.loadChannels();
    // Runs BEFORE the zero-config early return: a deactivated config can
    // still own an abort survivor, and this boot is its recovery chance.
    await this.reconcilePendingCleanup();

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
      .eq('active', true)
      .limit(1000);

    this.channels = (data ?? []) as StatsChannelConfig[];
  }

  private async updateAll(): Promise<void> {
    // Recover abort survivors FIRST: an adoptable survivor must become the
    // counter before the create branch below can mint a duplicate for the
    // same config.
    await this.reconcilePendingCleanup();

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

        let channelId = config.channel_id;
        let created = false;
        if (channelId) {
          const channel = this.guild.channels.cache.get(channelId) as VoiceChannel | undefined;
          if (!channel) {
            // The counter channel was deleted. Raise an owner alert and do NOT
            // advance last_value — otherwise the deletion is silent and the
            // counter would skip this value once the channel is recreated.
            await this.raiseChannelDeletedAlert(config);
            continue;
          }
          await channel.setName(newName);
        } else {
          const ambiguousId = this.ambiguousChannels.get(config.id);
          if (ambiguousId) {
            // Resolve the ambiguous channel before ever creating another.
            const retry = await this.persistChannelIdentity(config, ambiguousId);
            if (retry.outcome === 'persisted') {
              this.ambiguousChannels.delete(config.id);
            } else if (retry.outcome === 'lost_race') {
              // Another process registered its own counter meanwhile; ours is
              // a duplicate — dispose durably, never blind-delete.
              this.ambiguousChannels.delete(config.id);
              config.channel_id = retry.winnerChannelId;
              const pended = await this.persistPendingCleanup(config, ambiguousId);
              if (!pended) {
                const channel = this.guild.channels.cache.get(ambiguousId);
                if (channel) {
                  await this.deleteChannelWithRetries(
                    channel as VoiceChannel,
                    'Stats channel lost identity race',
                  );
                }
              }
            } else if (retry.outcome === 'error') {
              // The read-back worked and the row does NOT point at our
              // channel: the original write never committed. Hand the channel
              // to the reconciler (adopt-or-delete) and stop tracking it.
              this.ambiguousChannels.delete(config.id);
              const pended = await this.persistPendingCleanup(config, ambiguousId);
              if (!pended) {
                const channel = this.guild.channels.cache.get(ambiguousId);
                if (channel) {
                  await this.deleteChannelWithRetries(
                    channel as VoiceChannel,
                    'Stats channel identity write failed',
                  );
                }
              }
            }
            // Still ambiguous, or just resolved: never create this tick.
            continue;
          }
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

          const identity = await this.persistChannelIdentity(config, channel.id);
          if (identity.outcome === 'lost_race') {
            // Another process (rolling deploy, overlapping reload) created and
            // registered its own counter first. The winner's pointer is
            // durable; OUR channel is the duplicate. Adopt the winner in
            // memory and dispose of ours through the same durable machinery
            // as the abort path, so a crash here cannot orphan it.
            config.channel_id = identity.winnerChannelId;
            const survivorPersisted = await this.persistPendingCleanup(config, channel.id);
            if (!survivorPersisted) {
              await this.deleteChannelWithRetries(channel, 'Stats channel lost identity race');
            }
            continue;
          }
          if (identity.outcome === 'ambiguous') {
            // The identity write may have COMMITTED with a lost response and
            // the read-back could not settle it. Deleting would risk killing
            // a live counter whose durable pointer survives recovery — keep
            // the channel, remember it locally so later ticks RETRY its
            // identity instead of creating another counter per interval, and
            // best-effort record the reconciler pointer too.
            this.ambiguousChannels.set(config.id, channel.id);
            await this.persistPendingCleanup(config, channel.id);
            throw new Error(
              `Failed to confirm stats channel identity: ${identity.message}`,
            );
          }
          if (identity.outcome === 'error') {
            // The Discord channel exists but its identity could not be
            // persisted even with retries: config.channel_id stays null, so
            // every later update would create ANOTHER counter channel. Record
            // the survivor DURABLY first — the reconciler then adopts it as
            // the counter (channel_id is still null) or deletes it, so a
            // restart cannot orphan it. Only when the pointer itself cannot
            // be written do we fall back to delete-now, and only past THAT to
            // the loud manual-cleanup log.
            const survivorPersisted = await this.persistPendingCleanup(config, channel.id);
            if (!survivorPersisted) {
              await this.deleteChannelWithRetries(channel, 'Stats channel identity write failed');
            }
            throw new Error(`Failed to persist stats channel identity: ${identity.message}`);
          }
          channelId = channel.id;
          created = true;
        }

        const { error: lastValueError } = await this.supabase
          .from('stats_channels')
          .update({ last_value: value, last_updated_at: new Date().toISOString() })
          .eq('id', config.id);
        if (lastValueError) {
          throw new Error(`Failed to persist stats channel value: ${lastValueError.message}`);
        }
        config.last_value = value;
        this.eventBus.emit('stats_channel.updated', this.guild.id, {
          statChannelId: config.id,
          channelId,
          statType: config.stat_type,
          value,
          created,
        });
      } catch (err) {
        log.error(`Failed to update ${config.stat_type}:`, err);
        await this.raiseUpdateFailedAlert(config, err);
        continue;
      }
      try {
        await this.resolveUpdateAlerts(config);
      } catch (recoveryError) {
        log.error(`Failed to reconcile recovered ${config.stat_type} alert:`, recoveryError);
      }
    }
  }

  /**
   * CLAIM the empty channel slot for a freshly created channel, with retries.
   * The write is conditional on channel_id still being null: two overlapping
   * processes (rolling deploy, reload) can both create a Discord channel for
   * the same config, and an unconditional last-writer-wins update would leave
   * the loser's channel durably unowned. 'persisted' also updates the
   * in-memory row; 'lost_race' reports the winner's id (null when the config
   * row itself vanished mid-flight).
   */
  private async persistChannelIdentity(
    config: StatsChannelConfig,
    channelId: string,
  ): Promise<
    | { outcome: 'persisted' }
    | { outcome: 'lost_race'; winnerChannelId: string | null }
    | { outcome: 'error'; message: string }
    | { outcome: 'ambiguous'; message: string }
  > {
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data: claimed, error } = await this.supabase
        .from('stats_channels')
        .update({ channel_id: channelId })
        .eq('id', config.id)
        .is('channel_id', null)
        .select('id')
        .maybeSingle();
      if (!error && claimed) {
        config.channel_id = channelId;
        return { outcome: 'persisted' };
      }
      if (!error) {
        // Zero rows matched: someone else claimed the slot, the config row
        // vanished — or OUR earlier attempt committed but its acknowledgement
        // was lost. Read the current pointer to tell those apart.
        const { data: row, error: readError } = await this.supabase
          .from('stats_channels')
          .select('channel_id')
          .eq('id', config.id)
          .maybeSingle();
        if (!readError) {
          const winner = typeof row?.channel_id === 'string' ? row.channel_id : null;
          if (winner === channelId) {
            config.channel_id = channelId;
            return { outcome: 'persisted' };
          }
          return { outcome: 'lost_race', winnerChannelId: winner };
        }
        lastError = readError.message;
      } else {
        lastError = error.message;
      }
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
    // Final read-back: the FIRST conditional claim may have committed with a
    // lost acknowledgement while the database then stayed down for every
    // retry. If the durable row already points at this channel, reporting
    // error would delete a LIVE counter the config can never recreate
    // (channel_id is non-null after recovery).
    const { data: finalRow, error: finalReadError } = await this.supabase
      .from('stats_channels')
      .select('channel_id')
      .eq('id', config.id)
      .maybeSingle();
    if (!finalReadError) {
      if (finalRow?.channel_id === channelId) {
        config.channel_id = channelId;
        return { outcome: 'persisted' };
      }
      return { outcome: 'error', message: lastError };
    }
    return { outcome: 'ambiguous', message: lastError };
  }

  /** Delete a just-created duplicate/abort channel; logs loudly on exhaustion. */
  private async deleteChannelWithRetries(
    channel: { id: string; delete: (reason?: string) => Promise<unknown> },
    reason: string,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await channel.delete(reason);
        return true;
      } catch (deleteError) {
        if (attempt === 3) {
          log.error(
            `Stats channel ${channel.id} could not be deleted (${reason}) and no durable `
            + 'cleanup state could be written; it is orphaned in Discord and must be removed '
            + 'manually:',
            { error: String(deleteError) },
          );
        } else {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    }
    return false;
  }

  /**
   * Durably record an abort survivor on its stats_channels row so the
   * reconciler owns it by id. The append is a single-statement RPC — two
   * processes losing the same identity race must BOTH keep their pointer; a
   * read-merge-write here let the last writer drop the other duplicate's
   * only durable record. A call that matched no row (config deleted
   * mid-flight) is a FAILED persist, because the pointer would not exist
   * anywhere.
   */
  private async persistPendingCleanup(
    config: StatsChannelConfig,
    channelId: string,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { data, error } = await this.supabase.rpc('append_stats_pending_cleanup', {
          p_config_id: config.id,
          p_channel_id: channelId,
        });
        if (error) throw new Error(error.message);
        if (data !== true) throw new Error('stats channel row no longer exists');
        const known = Array.isArray(config.pending_cleanup_channel_ids)
          ? config.pending_cleanup_channel_ids
          : [];
        if (!known.includes(channelId)) {
          config.pending_cleanup_channel_ids = [...known, channelId];
        }
        log.warn(
          `Stats channel ${channelId} recorded for recovery after its identity write failed`,
        );
        return true;
      } catch (persistError) {
        if (attempt === 3) {
          log.error('Could not persist stats-channel cleanup state after retries:', {
            statsChannelId: config.id,
            channelId,
            error: String(persistError),
          });
        } else {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    }
    return false;
  }

  /**
   * Recover abort survivors recorded in pending_cleanup_channel_ids. An
   * ACTIVE config whose channel_id is still null ADOPTS its survivor — the
   * channel was created correctly, only the identity write failed — anything
   * else is deleted. Ids leave the list only on proof (adopted, deleted, or
   * confirmed gone); failures stay listed for the next pass. Scans the table
   * directly, not this.channels: deactivated configs can own survivors too.
   */
  private async reconcilePendingCleanup(): Promise<void> {
    const { data, error } = await this.supabase
      .from('stats_channels')
      .select('id, channel_id, active, pending_cleanup_channel_ids')
      .eq('guild_id', this.guild.id)
      .neq('pending_cleanup_channel_ids', '[]')
      .limit(200);
    if (error) {
      log.error('Failed to scan stats-channel cleanup state:', { error: error.message });
      return;
    }
    for (const row of data ?? []) {
      const pending = Array.isArray(row.pending_cleanup_channel_ids)
        ? (row.pending_cleanup_channel_ids as unknown[])
          .filter((id): id is string => typeof id === 'string')
        : [];
      if (pending.length === 0) continue;
      const remaining: string[] = [];
      let liveChannelId = typeof row.channel_id === 'string' ? row.channel_id : null;
      for (const channelId of pending) {
        if (channelId === liveChannelId) {
          // Already the live counter (a prior pass adopted it but could not
          // trim the list). Dropping the id is the only work left.
          continue;
        }
        let channel;
        let missing = false;
        try {
          channel = await this.guild.channels.fetch(channelId);
          missing = !channel;
        } catch (fetchError) {
          const code =
            typeof fetchError === 'object' && fetchError !== null && 'code' in fetchError
              ? Number((fetchError as { code: unknown }).code)
              : Number.NaN;
          if (code === RESTJSONErrorCodes.UnknownChannel) {
            missing = true;
          } else {
            log.warn('Could not verify stats-channel abort survivor; will retry:', {
              statsChannelId: row.id,
              channelId,
              error: String(fetchError),
            });
            remaining.push(channelId);
            continue;
          }
        }
        if (missing) continue;
        if (row.active === true && liveChannelId === null) {
          // Adoption is conditional on channel_id still being null so a
          // racing instance's create/adopt is never overwritten.
          const { data: adopted, error: adoptError } = await this.supabase
            .from('stats_channels')
            .update({ channel_id: channelId })
            .eq('id', row.id)
            .is('channel_id', null)
            .select('id')
            .maybeSingle();
          if (!adoptError && adopted) {
            liveChannelId = channelId;
            const local = this.channels.find((config) => config.id === row.id);
            if (local) local.channel_id = channelId;
            continue;
          }
          // Lost the race or the write failed: keep the pointer and let the
          // next pass see fresh state rather than deleting a channel that may
          // have just become the live counter.
          remaining.push(channelId);
          continue;
        }
        try {
          await channel?.delete('Stats counter abort survivor cleanup');
        } catch (deleteError) {
          log.warn('Stats-channel abort survivor could not be deleted; will retry:', {
            statsChannelId: row.id,
            channelId,
            error: String(deleteError),
          });
          remaining.push(channelId);
        }
      }
      const resolvedIds = pending.filter((channelId) => !remaining.includes(channelId));
      if (resolvedIds.length > 0) {
        // Remove exactly the RESOLVED ids in one statement so a concurrent
        // append (another process recording its own survivor) is never
        // overwritten by this trim.
        const { error: trimError } = await this.supabase.rpc(
          'remove_stats_pending_cleanup',
          { p_config_id: row.id, p_channel_ids: resolvedIds },
        );
        if (trimError) {
          log.error('Failed to trim stats-channel cleanup state:', {
            statsChannelId: row.id,
            error: trimError.message,
          });
        } else {
          const local = this.channels.find((config) => config.id === row.id);
          if (local) {
            local.pending_cleanup_channel_ids = (local.pending_cleanup_channel_ids ?? [])
              .filter((channelId) => !resolvedIds.includes(channelId));
          }
        }
      }
    }
  }

  /**
   * Raise exactly one owner alert when a stats counter channel has been deleted,
   * so the degraded counter is visible instead of silently frozen. Deduplicated
   * on the open (unresolved) alert for this specific stats channel.
   */
  private async raiseChannelDeletedAlert(config: StatsChannelConfig): Promise<void> {
    if (!config.channel_id) return;
    try {
      const { data: openAlerts } = await this.supabase
        .from('alerts')
        .select('id, metadata')
        .eq('guild_id', this.guild.id)
        .eq('alert_type', 'stats_channel_deleted')
        .eq('resolved', false)
        .limit(1000);
      const already = (openAlerts ?? []).some(
        (a: { metadata?: { stats_channel_id?: string } | null }) =>
          a.metadata?.stats_channel_id === config.id,
      );
      if (already) return;

      await raiseOwnerAlert(this.supabase, this.guild.id, {
        alertType: 'stats_channel_deleted',
        severity: 'warning',
        title: 'Stats counter channel was deleted',
        message:
          `The "${config.stat_type}" stats counter channel (${config.channel_id}) no longer exists. ` +
          `Its value has stopped updating. Recreate the counter from the dashboard to restore it.`,
        metadata: {
          stats_channel_id: config.id,
          channel_id: config.channel_id,
          stat_type: config.stat_type,
        },
        guild: this.guild,
      });
    } catch (alertErr) {
      log.error('Failed to write stats-channel deleted alert:', { error: String(alertErr) });
    }
  }

  private async raiseUpdateFailedAlert(config: StatsChannelConfig, error: unknown): Promise<void> {
    if (this.alertedDegradedChannels.has(config.id)) return;
    const message = error instanceof Error ? error.message : String(error);
    if (!this.degradedChannels.has(config.id)) {
      this.degradedChannels.add(config.id);
      this.eventBus.emit('stats_channel.update_failed', this.guild.id, {
        statChannelId: config.id,
        channelId: config.channel_id,
        statType: config.stat_type,
        error: message,
      });
    }
    const result = await raiseOwnerAlert(this.supabase, this.guild.id, {
      alertType: 'stats_channel_update_failed',
      severity: 'warning',
      title: 'Stats counter update failed',
      message:
        `The "${config.stat_type}" counter could not be updated (${message}). ` +
        'Its channel permissions and Discord availability need attention.',
      metadata: {
        stats_channel_id: config.id,
        channel_id: config.channel_id,
        stat_type: config.stat_type,
        error: message,
      },
      guild: this.guild,
    }).catch((alertErr) => {
      log.error('Failed to write stats-channel update alert:', { error: String(alertErr) });
      return { inserted: false, insertErrorCode: undefined, delivered: false };
    });
    // Latch ONLY on a delivered owner notice (same contract as message-log):
    // a durable row whose ping failed keeps retrying — one attempt per update
    // interval, deduped at the row by the partial unique index.
    if (result.delivered) {
      this.alertedDegradedChannels.add(config.id);
    }
  }

  private async resolveUpdateAlerts(config: StatsChannelConfig): Promise<void> {
    const firstSuccessThisBoot = !this.recoveryChecked.has(config.id);
    if (!this.degradedChannels.has(config.id) && !firstSuccessThisBoot) return;

    const updateResolution = await resolveOwnerAlertWithStatus(
      this.supabase,
      this.guild.id,
      'stats_channel_update_failed',
      { stats_channel_id: config.id },
      {
        guild: this.guild,
        notice: `The "${config.stat_type}" stats counter is updating again.`,
      },
    );
    if (!updateResolution.succeeded) return;
    if (config.channel_id) {
      const deletedResolution = await resolveOwnerAlertWithStatus(
        this.supabase,
        this.guild.id,
        'stats_channel_deleted',
        { stats_channel_id: config.id },
        { guild: this.guild },
      );
      if (!deletedResolution.succeeded) return;
    }
    this.recoveryChecked.add(config.id);
    this.degradedChannels.delete(config.id);
    this.alertedDegradedChannels.delete(config.id);
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
