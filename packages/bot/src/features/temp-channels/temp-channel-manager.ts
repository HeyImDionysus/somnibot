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
import { eventBus as defaultEventBus, type PlatformEventBus } from '../../services/event-bus.js';
import { writeAuditLog } from '../../services/audit.js';
import { createLogger } from '@somnibot/shared';
import { raiseOwnerAlert } from '../../services/alert-service.js';
import { renderTempChannelTemplate } from './templates.js';

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
  empty_grace_seconds: number | null;
  allow_text_channel: boolean;
  allow_claim: boolean;
  moderator_roles: string[];
  active: boolean;
  // Owner-brandable member-facing templates (null/blank ⇒ built-in default).
  room_created_template: string | null;
  control_applied_template: string | null;
  control_denied_template: string | null;
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
  private inFlightJoins: Set<string> = new Set(); // `${memberId}:${hubChannelId}` currently spawning

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus = defaultEventBus,
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

    // Join-event idempotency: a re-delivered voiceStateUpdate (Discord gateway
    // resume/reconnect can re-emit the same hub-join) must not spawn a SECOND
    // room. A fresh create yields a new channel id, so the active_temp_channels
    // PK gives no protection — guard on an in-flight key keyed by member+hub.
    const joinKey = `${member.id}:${hubChannelId}`;
    if (this.inFlightJoins.has(joinKey)) return;
    this.inFlightJoins.add(joinKey);

    // Format channel name. The catalog's single documented variable is
    // {owner-name}; {username}/{user}/{tag}/{count} are supported aliases.
    const channelName = hub.naming_format
      .replace(/\{owner-name\}/g, member.displayName)
      .replace(/\{username\}/g, member.displayName)
      .replace(/\{user\}/g, member.displayName)
      .replace(/\{tag\}/g, member.user.username)
      .replace(/\{count\}/g, String(this.activeChannels.size + 1));

    try {
      const category = this.guild.channels.cache.get(hub.category_id) as CategoryChannel | undefined;

      // Create the voice channel. A single transient failure must not leave the
      // member with no room — retry briefly so at most one room per join event.
      const vc = await this.withRetry(
        () =>
          this.guild.channels.create({
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
          }),
        'temp channel create',
      );

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

      this.eventBus.emit('temp_channel.created', this.guild.id, {
        channelId: vc.id,
        textChannelId,
        hubId: hub.id,
        hubChannelId: hub.hub_channel_id,
        ownerId: member.id,
      });

      // Move the member to the new channel
      await member.voice.setChannel(vc);

      // Post the (owner-brandable) welcome into the new room. Best-effort — a
      // send failure must never undo a room that was created successfully.
      await this.sendRoomCreatedMessage(member, hub, vc, textChannelId);

      log.info(`Created "${vc.name}" for ${member.user.username}`);
    } catch (err) {
      // Room creation failed after retries — do not fail silently. Notify the
      // member and raise exactly one owner alert so the outage is visible.
      log.error('Failed to create temp channel:', { error: String(err) });
      this.eventBus.emit('temp_channel.creation_failed', this.guild.id, {
        hubId: hub.id,
        hubChannelId: hub.hub_channel_id,
        memberId: member.id,
        error: String(err),
      });
      await this.notifyCreationFailure(member, hub, err);
    } finally {
      this.inFlightJoins.delete(joinKey);
    }
  }

  /**
   * Run an operation with a bounded retry so a single transient failure does not
   * drop the whole action. Returns the first successful result or rethrows the
   * last error after all attempts are exhausted.
   */
  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    const maxAttempts = 2;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) {
          log.warn(`${label} attempt ${attempt} failed, retrying`, { error: String(err) });
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Surface a room-creation outage: DM the member and raise one owner alert.
   * (The temp_channels.creation_failed audit event is emitted by the caller's
   * platform-event pipeline; the alerts row here drives the dashboard badge and
   * the owner alert channel.)
   */
  private async notifyCreationFailure(
    member: GuildMember,
    hub: HubConfig,
    err: unknown,
  ): Promise<void> {
    // Member notice (best effort — DMs may be closed).
    try {
      await member.send(
        "⚠️ I couldn't create your temporary voice channel just now. Please try again in a moment, or let a server admin know if it keeps happening.",
      );
    } catch {
      // Member has DMs disabled — nothing more we can surface to them here.
    }

    // Owner alert — alerts row + alert-channel notice (X1/M2).
    try {
      await raiseOwnerAlert(this.supabase, this.guild.id, {
        alertType: 'temp_channel_creation_failed',
        severity: 'warning',
        title: 'Temporary voice channel could not be created',
        message:
          `A member tried to create a temporary voice channel from hub <#${hub.hub_channel_id}> ` +
          `but creation failed: ${String(err)}. Check my Manage Channels permission and the hub's category.`,
        metadata: { hub_id: hub.id, hub_channel_id: hub.hub_channel_id, member_id: member.id },
        guild: this.guild,
      });
    } catch (alertErr) {
      log.error('Failed to write temp-channel creation alert:', { error: String(alertErr) });
    }
  }

  /**
   * Post the branded "room created" welcome into the new room. Prefers the paired
   * text channel; otherwise the voice channel's built-in text chat. Best-effort:
   * a send failure (missing perms, no text surface, etc.) is logged and swallowed
   * so it can never roll back a room that was created successfully. Mentions are
   * disabled so a template can't be turned into an @everyone ping.
   */
  private async sendRoomCreatedMessage(
    member: GuildMember,
    hub: HubConfig,
    vc: VoiceChannel,
    textChannelId: string | null,
  ): Promise<void> {
    try {
      const content = renderTempChannelTemplate(hub, 'room_created', {
        'owner-name': member.displayName,
        owner: member.displayName,
        username: member.displayName,
        user: member.displayName,
        tag: member.user.username,
        'room-name': vc.name,
        server: this.guild.name,
      });
      if (!content.trim()) return;

      // Prefer the paired text channel; fall back to the voice channel's own
      // text chat. Duck-type `.send` (via unknown) so this works for any
      // sendable channel without a wide discord.js type guard.
      const target: unknown = textChannelId
        ? this.guild.channels.cache.get(textChannelId)
        : vc;
      const sender = target as { send?: (payload: unknown) => Promise<unknown> } | null | undefined;
      if (sender && typeof sender.send === 'function') {
        await sender.send({ content, allowedMentions: { parse: [] } });
      }
    } catch (err) {
      log.warn('Failed to post room-created message:', { error: String(err) });
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
      // Channel already gone — clean up the stale record (reconciliation).
      await this.removeChannel(channelId);
      this.eventBus.emit('temp_channel.orphan_reconciled', this.guild.id, {
        channelId,
        ownerId: active.owner_id,
      });
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

    // Channel empty — start empty-room grace countdown. The catalog control is
    // empty-grace-seconds (seconds); keep_alive_minutes is a compatibility
    // fallback for any hub not yet backfilled to the seconds column.
    const hub = this.getHubForChannel(channelId);
    const graceSeconds = hub?.empty_grace_seconds ?? ((hub?.keep_alive_minutes ?? 1) * 60);
    const keepAliveMs = graceSeconds * 1000;

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

    const ownerId = active.owner_id;

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
    this.eventBus.emit('temp_channel.deleted', this.guild.id, {
      channelId,
      ownerId,
      reason: 'empty',
    });
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

    this.eventBus.emit('temp_channel.claimed', this.guild.id, {
      channelId,
      previousOwnerId: oldOwnerId,
      newOwnerId,
    });
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
    for (const [channelId, active] of this.activeChannels) {
      const vc = this.guild.channels.cache.get(channelId);
      if (!vc) {
        await this.removeChannel(channelId);
        // [community-temporary-channels] Append-only audit row per reconciled
        // orphan. Written directly because start() runs during guild init
        // BEFORE the per-guild AuditService attaches its event listener, so the
        // temp_channel.orphan_reconciled emit below is never mapped to an
        // audit_logs row on this startup path.
        await writeAuditLog(this.supabase, {
          guildId: this.guild.id,
          actorType: 'system',
          actorId: 'system',
          action: 'temp_channel.orphan_reconciled',
          targetType: 'channel',
          targetId: channelId,
          details: { ownerId: active.owner_id, reason: 'startup_reconciliation' },
        });
        this.eventBus.emit('temp_channel.orphan_reconciled', this.guild.id, {
          channelId,
          ownerId: active.owner_id,
        });
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
