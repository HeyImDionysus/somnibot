/**
 * Music Player Manager — orchestrates Shoukaku players, queue, and Discord interactions.
 *
 * Architecture doc §29
 *
 * Handles: play, pause, resume, stop, skip, seek, volume, loop, shuffle,
 * auto-disconnect, auto-pause, vote-skip, DJ role enforcement.
 */
import {
  type Guild,
  type TextChannel,
  type VoiceBasedChannel,
  ChannelType,
} from 'discord.js';
import type { Shoukaku, Player, Track, TrackExceptionEvent, TrackEndEvent } from 'shoukaku';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import type { PlatformEventBus } from '../../services/event-bus.js';
import { MusicQueueManager, type QueueEntry, type GuildQueue, type LoopMode } from './music-queue.js';
import {
  buildNowPlayingEmbed,
  buildAddedEmbed,
  buildPlaylistAddedEmbed,
  buildMusicErrorEmbed,
  buildMusicInfoEmbed,
} from './music-embeds.js';
import { MusicSelfHealer, type SearchProvider } from './music-self-healer.js';
import { applyFilterPreset, applyCustomTimescale, describeActiveFilters, type FilterPreset } from './music-filters.js';
import type { Band, TimescaleSettings } from 'shoukaku';
import { createLogger } from '@somnibot/shared';

const log = createLogger('MusicPlayer');

// ── Config ────────────────────────────────────────────────

interface MusicConfig {
  defaultVolume: number;
  maxQueueLength: number;
  allowDuplicates: boolean;
  djRoleId: string | null;
  autoLeaveTimeout: number;   // ms — default 5 min
  inactivityTimeout: number;  // ms — default 30 min
}

const DEFAULT_CONFIG: MusicConfig = {
  defaultVolume: 50,
  maxQueueLength: 500,
  allowDuplicates: true,
  djRoleId: null,
  autoLeaveTimeout: 5 * 60 * 1000,
  inactivityTimeout: 30 * 60 * 1000,
};

// ── Player Manager ────────────────────────────────────────

export class MusicPlayerManager {
  public readonly queueManager: MusicQueueManager;
  private readonly selfHealer = new MusicSelfHealer();
  private config: MusicConfig = { ...DEFAULT_CONFIG };
  private autoLeaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inactivityTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly guild: Guild,
    private readonly shoukaku: Shoukaku,
    private readonly supabase: SupabaseClient,
    private readonly valkey: Valkey,
    private readonly eventBus: PlatformEventBus,
  ) {
    this.queueManager = new MusicQueueManager(valkey);
  }

  /** Initialize — load config from database, set up Shoukaku event handlers. */
  async init(): Promise<void> {
    await this.loadConfig();
    this.setupShoukakuEvents();

    // V5 Audit P3-8: After restart, check if Shoukaku reconnected to an
    // empty voice channel and start the auto-leave timer immediately.
    // Without this, the bot could sit alone indefinitely after a restart.
    const existingPlayer = this.shoukaku.players?.get(this.guild.id);
    if (existingPlayer) {
      const queue = await this.queueManager.getQueue(this.guild.id);
      if (queue?.voiceChannelId) {
        const vc = this.guild.channels.cache.get(queue.voiceChannelId);
        if (vc?.isVoiceBased()) {
          const humans = vc.members.filter((m) => !m.user.bot);
          if (humans.size === 0) {
            log.info(`Post-restart: bot alone in VC, starting auto-leave timer for ${this.guild.id}`);
            this.startAutoLeaveTimer(this.guild.id);
          }
        }
      }
    }

    log.info('Player manager started');
  }

  /** Clean up timers on shutdown. */
  shutdown(): void {
    for (const timer of this.autoLeaveTimers.values()) clearTimeout(timer);
    for (const timer of this.inactivityTimers.values()) clearTimeout(timer);
    this.autoLeaveTimers.clear();
    this.inactivityTimers.clear();
  }

  // ── Config ──────────────────────────────────────────────

  private async loadConfig(): Promise<void> {
    const { data } = await this.supabase
      .from('guild_config')
      .select('music_default_volume, dj_role_id, music_auto_leave_minutes, music_auto_destroy_minutes')
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    if (data) {
      const autoLeaveMin = data.music_auto_leave_minutes ?? 5;
      const autoDestroyMin = data.music_auto_destroy_minutes ?? 30;
      this.config = {
        ...DEFAULT_CONFIG,
        defaultVolume: data.music_default_volume ?? DEFAULT_CONFIG.defaultVolume,
        djRoleId: data.dj_role_id ?? null,
        autoLeaveTimeout: autoLeaveMin * 60 * 1000,
        inactivityTimeout: autoDestroyMin * 60 * 1000,
      };
    }
  }

  /** Reload config (called when settings change via dashboard). */
  async reloadConfig(): Promise<void> {
    await this.loadConfig();
  }

  getConfig(): MusicConfig {
    return { ...this.config };
  }

  /**
   * Get current player status for dashboard display.
   */
  async getStatus(): Promise<{
    nowPlaying: { title: string; author: string; url: string; duration: number; position: number; requester: string; thumbnail: string | null } | null;
    queue: { length: number; duration: number };
    listeners: number;
  }> {
    const guildId = this.guild.id;
    const player = this.shoukaku.players.get(guildId);

    if (!player || !player.track) {
      return { nowPlaying: null, queue: { length: 0, duration: 0 }, listeners: 0 };
    }

    // Count listeners in the voice channel
    const connection = this.shoukaku.connections.get(guildId);
    const voiceChannel = connection?.channelId
      ? this.guild.channels.cache.get(connection.channelId)
      : null;
    const listeners = voiceChannel?.isVoiceBased()
      ? voiceChannel.members.filter((m) => !m.user.bot).size
      : 0;

    // Get track info from the queue (player.track is just a base64 string)
    const queue = await this.queueManager.getQueue(guildId);
    const currentEntry = queue && queue.currentIndex < queue.entries.length
      ? queue.entries[queue.currentIndex]
      : null;

    return {
      nowPlaying: {
        title: currentEntry?.title ?? 'Unknown',
        author: currentEntry?.author ?? 'Unknown',
        url: currentEntry?.uri ?? '',
        duration: currentEntry?.duration ?? 0,
        position: player.position ?? 0,
        requester: currentEntry?.requestedBy ?? 'Unknown',
        thumbnail: currentEntry?.artworkUrl ?? null,
      },
      queue: {
        length: queue?.entries.length ?? 0,
        duration: queue?.entries.reduce((sum, e) => sum + e.duration, 0) ?? 0,
      },
      listeners: Math.max(0, listeners),
    };
  }

  // ── DJ Permissions ──────────────────────────────────────

  /** Check if a user has DJ privileges. */
  async isDJ(userId: string): Promise<boolean> {
    if (!this.config.djRoleId) return true; // No DJ role = everyone is DJ

    const member = await this.guild.members.fetch(userId).catch(() => null);
    if (!member) return false;

    // Server owner is always DJ
    if (member.id === this.guild.ownerId) return true;

    // Has DJ role
    if (member.roles.cache.has(this.config.djRoleId)) return true;

    // Admin permission
    if (member.permissions.has('Administrator')) return true;

    // Alone in voice channel = auto-DJ
    const queue = await this.queueManager.getQueue(this.guild.id);
    if (queue) {
      const voiceChannel = this.guild.channels.cache.get(queue.voiceChannelId);
      if (voiceChannel && voiceChannel.isVoiceBased()) {
        const humanMembers = voiceChannel.members.filter((m) => !m.user.bot);
        if (humanMembers.size <= 1) return true;
      }
    }

    return false;
  }

  // ── Core Playback ───────────────────────────────────────

  /** Search and play a track. Returns the queue entry or error message. */
  async play(
    query: string,
    userId: string,
    voiceChannel: VoiceBasedChannel,
    textChannel: TextChannel,
  ): Promise<{ success: boolean; message?: string; entry?: QueueEntry; count?: number; playlistName?: string }> {
    // Get or create queue
    let queue = await this.queueManager.getQueue(this.guild.id);
    const isNewQueue = !queue;

    if (!queue) {
      queue = this.queueManager.createQueue(
        this.guild.id,
        voiceChannel.id,
        textChannel.id,
        this.config.defaultVolume,
      );
      await this.queueManager.saveQueue(queue);
    }

    // Check queue size limit
    if (queue.entries.length >= this.config.maxQueueLength) {
      return { success: false, message: `Queue is full (max ${this.config.maxQueueLength} tracks)` };
    }

    // V9 Audit §12.P2: Per-user queue limit — prevent one user from monopolizing the queue.
    const userQueueCount = queue.entries.filter((e) => e.requestedBy === userId).length;
    const MAX_PER_USER = 50;
    if (userQueueCount >= MAX_PER_USER) {
      return { success: false, message: `You've reached the per-user limit of ${MAX_PER_USER} queued tracks` };
    }

    // Resolve search query
    const searchQuery = this.resolveSearchQuery(query);

    // Get or create a Shoukaku player
    let player = this.shoukaku.players.get(this.guild.id) ?? null;

    if (!player) {
      const node = this.shoukaku.options.nodeResolver(this.shoukaku.nodes);
      if (!node) {
        return { success: false, message: 'No Lavalink nodes available' };
      }

      player = await this.shoukaku.joinVoiceChannel({
        guildId: this.guild.id,
        channelId: voiceChannel.id,
        // V11 Audit M-4: Use the guild's actual shard ID for multi-shard support.
        shardId: this.guild.shardId,
        deaf: true,
      });

      this.setupPlayerEvents(player);
    }

    // Search for tracks
    const result = await player.node.rest.resolve(searchQuery);

    if (!result || result.loadType === 'empty' || result.loadType === 'error') {
      this.selfHealer.recordFailure();
      return { success: false, message: 'No results found for your query' };
    }

    this.selfHealer.recordSuccess();

    let addedEntries: QueueEntry[] = [];
    let playlistName: string | undefined;

    if (result.loadType === 'playlist') {
      // Add all tracks from playlist
      playlistName = result.data.info.name;
      for (const track of result.data.tracks) {
        if (queue.entries.length + addedEntries.length >= this.config.maxQueueLength) break;

        const entry = this.trackToEntry(track, userId);
        if (!this.config.allowDuplicates && queue.entries.some((e) => e.uri === entry.uri)) {
          continue;
        }
        addedEntries.push(entry);
      }
    } else {
      // Single track (search or track load)
      const track = result.loadType === 'search'
        ? result.data[0]
        : result.data;

      if (!track) {
        return { success: false, message: 'No results found for your query' };
      }

      const entry = this.trackToEntry(track, userId);

      if (!this.config.allowDuplicates && queue.entries.some((e) => e.uri === entry.uri)) {
        return { success: false, message: 'This track is already in the queue' };
      }

      addedEntries = [entry];
    }

    if (addedEntries.length === 0) {
      return { success: false, message: 'No tracks could be added (duplicates filtered)' };
    }

    // Add to queue
    queue.entries.push(...addedEntries);
    await this.queueManager.saveQueue(queue);

    // If this is the first track (or queue was empty), start playing
    const shouldPlay = isNewQueue || queue.entries.length === addedEntries.length ||
      !player.track;

    if (shouldPlay) {
      const firstEntry = queue.entries[queue.currentIndex];
      if (firstEntry) {
        await player.playTrack({ track: { encoded: firstEntry.track } });
        await this.setVolume(this.guild.id, queue.volume);
      }
    }

    // Reset inactivity timer
    this.resetInactivityTimer(this.guild.id);

    if (addedEntries.length === 1 && addedEntries[0]) {
      const position = queue.entries.length - queue.currentIndex;
      return { success: true, entry: addedEntries[0], message: undefined, count: 1 };
    }

    return {
      success: true,
      count: addedEntries.length,
      playlistName,
    };
  }

  /** Skip the current track. */
  async skip(guildId: string): Promise<{ success: boolean; message: string }> {
    const player = this.shoukaku.players.get(guildId);
    if (!player) return { success: false, message: 'Nothing is playing' };

    await this.queueManager.clearVoteSkip(guildId);

    const { track, queueEnded } = await this.queueManager.nextTrack(guildId);

    if (queueEnded || !track) {
      await player.stopTrack();
      return { success: true, message: '⏭️ Skipped — queue ended' };
    }

    await player.playTrack({ track: { encoded: track.track } });
    return { success: true, message: `⏭️ Skipped to **${track.title}**` };
  }

  /** Vote-skip (for non-DJ members). */
  async voteSkip(guildId: string, userId: string): Promise<{ success: boolean; message: string }> {
    const queue = await this.queueManager.getQueue(guildId);
    if (!queue) return { success: false, message: 'Nothing is playing' };

    const voiceChannel = this.guild.channels.cache.get(queue.voiceChannelId);
    if (!voiceChannel || !voiceChannel.isVoiceBased()) {
      return { success: false, message: 'Bot is not in a voice channel' };
    }

    if (await this.queueManager.hasVotedSkip(guildId, userId)) {
      return { success: false, message: 'You already voted to skip' };
    }

    const humanCount = voiceChannel.members.filter((m) => !m.user.bot).size;
    const required = Math.ceil(humanCount / 2); // Majority vote
    const votes = await this.queueManager.addVoteSkip(guildId, userId);

    if (votes >= required) {
      return this.skip(guildId);
    }

    return {
      success: true,
      message: `🗳️ Skip vote: **${votes}/${required}** needed`,
    };
  }

  /** Stop playback and clear the queue. */
  async stop(guildId: string): Promise<{ success: boolean; message: string }> {
    const player = this.shoukaku.players.get(guildId);
    if (player) {
      await player.stopTrack();
      await this.shoukaku.leaveVoiceChannel(guildId);
    }

    await this.queueManager.destroyQueue(guildId);
    this.clearTimers(guildId);

    return { success: true, message: '⏹️ Stopped playback and cleared the queue' };
  }

  /** Pause or resume playback. */
  async togglePause(guildId: string): Promise<{ success: boolean; paused: boolean; message: string }> {
    const player = this.shoukaku.players.get(guildId);
    if (!player) return { success: false, paused: false, message: 'Nothing is playing' };

    const queue = await this.queueManager.getQueue(guildId);
    if (!queue) return { success: false, paused: false, message: 'No active queue' };

    const newPaused = !queue.paused;
    await player.setPaused(newPaused);
    queue.paused = newPaused;
    await this.queueManager.saveQueue(queue);

    if (newPaused) {
      this.resetInactivityTimer(guildId);
    } else {
      this.clearInactivityTimer(guildId);
    }

    return {
      success: true,
      paused: newPaused,
      message: newPaused ? '⏸️ Paused' : '▶️ Resumed',
    };
  }

  /** Seek to a position in the current track. */
  async seek(guildId: string, positionMs: number): Promise<{ success: boolean; message: string }> {
    const player = this.shoukaku.players.get(guildId);
    if (!player) return { success: false, message: 'Nothing is playing' };

    const current = await this.queueManager.getCurrentTrack(guildId);
    if (!current) return { success: false, message: 'No track is playing' };

    if (current.isStream) {
      return { success: false, message: 'Cannot seek in a live stream' };
    }

    if (positionMs < 0 || positionMs > current.duration) {
      return { success: false, message: 'Invalid seek position' };
    }

    await player.seekTo(positionMs);
    return { success: true, message: `⏩ Seeked to \`${this.formatSeekPosition(positionMs)}\`` };
  }

  /** Set volume (0–100). */
  async setVolume(guildId: string, volume: number): Promise<{ success: boolean; message: string }> {
    const player = this.shoukaku.players.get(guildId);
    if (!player) return { success: false, message: 'Nothing is playing' };

    const clamped = Math.max(0, Math.min(150, volume));
    await player.setGlobalVolume(clamped);

    const queue = await this.queueManager.getQueue(guildId);
    if (queue) {
      queue.volume = clamped;
      await this.queueManager.saveQueue(queue);
    }

    return { success: true, message: `🔊 Volume set to **${clamped}%**` };
  }

  /** Set loop mode. */
  async setLoopMode(guildId: string, mode: LoopMode): Promise<{ success: boolean; message: string }> {
    const queue = await this.queueManager.getQueue(guildId);
    if (!queue) return { success: false, message: 'No active queue' };

    queue.loopMode = mode;
    await this.queueManager.saveQueue(queue);

    const labels = { off: '▶️ Loop off', track: '🔂 Looping track', queue: '🔁 Looping queue' };
    return { success: true, message: labels[mode] };
  }

  /** Cycle through loop modes: off → queue → track → off. */
  async cycleLoopMode(guildId: string): Promise<{ success: boolean; mode: LoopMode; message: string }> {
    const queue = await this.queueManager.getQueue(guildId);
    if (!queue) return { success: false, mode: 'off', message: 'No active queue' };

    const cycle: LoopMode[] = ['off', 'queue', 'track'];
    const currentIdx = cycle.indexOf(queue.loopMode);
    const nextMode = cycle[(currentIdx + 1) % cycle.length]!;

    const result = await this.setLoopMode(guildId, nextMode);
    return { ...result, mode: nextMode };
  }

  /** Shuffle the queue. */
  async shuffle(guildId: string): Promise<{ success: boolean; message: string }> {
    const success = await this.queueManager.shuffle(guildId);
    if (!success) return { success: false, message: 'No active queue to shuffle' };
    return { success: true, message: '🔀 Queue shuffled' };
  }

  /** Remove a track from the queue by position (1-indexed, relative to upcoming). */
  async remove(guildId: string, position: number): Promise<{ success: boolean; message: string }> {
    const queue = await this.queueManager.getQueue(guildId);
    if (!queue) return { success: false, message: 'No active queue' };

    const index = queue.currentIndex + position;
    if (index <= queue.currentIndex || index >= queue.entries.length) {
      return { success: false, message: 'Invalid position' };
    }

    const removed = await this.queueManager.removeEntry(guildId, index);
    if (!removed) return { success: false, message: 'Failed to remove track' };

    return { success: true, message: `🗑️ Removed **${removed.title}** from the queue` };
  }

  /** Get the current player position in ms. */
  getPlayerPosition(guildId: string): number {
    const player = this.shoukaku.players.get(guildId);
    return player?.position ?? 0;
  }

  // ── Filters ─────────────────────────────────────────────

  /** Apply a filter preset. */
  async applyFilter(guildId: string, preset: FilterPreset): Promise<{ success: boolean; message: string }> {
    const player = this.shoukaku.players.get(guildId);
    if (!player) return { success: false, message: 'Nothing is playing' };

    await applyFilterPreset(player, preset);

    if (preset === 'reset') {
      return { success: true, message: '🔄 All filters cleared' };
    }

    const { FILTER_PRESETS } = await import('./music-filters.js');
    const info = FILTER_PRESETS[preset];
    return { success: true, message: `${info.emoji} Applied **${info.name}** filter` };
  }

  /** Apply custom speed/pitch/rate. */
  async applyCustomSpeed(guildId: string, speed?: number, pitch?: number, rate?: number): Promise<{ success: boolean; message: string }> {
    const player = this.shoukaku.players.get(guildId);
    if (!player) return { success: false, message: 'Nothing is playing' };

    const settings: TimescaleSettings = {};
    if (speed !== undefined) settings.speed = Math.max(0.1, Math.min(3.0, speed));
    if (pitch !== undefined) settings.pitch = Math.max(0.1, Math.min(3.0, pitch));
    if (rate !== undefined) settings.rate = Math.max(0.1, Math.min(3.0, rate));

    await applyCustomTimescale(player, settings);

    const parts: string[] = [];
    if (settings.speed !== undefined) parts.push(`speed: ${settings.speed}x`);
    if (settings.pitch !== undefined) parts.push(`pitch: ${settings.pitch}x`);
    if (settings.rate !== undefined) parts.push(`rate: ${settings.rate}x`);

    return { success: true, message: `⏱️ Applied timescale — ${parts.join(', ')}` };
  }

  /** Get a description of the active filters. */
  getActiveFilters(guildId: string): string {
    const player = this.shoukaku.players.get(guildId);
    if (!player) return 'None';
    return describeActiveFilters(player);
  }

  // ── Now Playing Updates ─────────────────────────────────

  /** Send or update the now-playing embed. */
  async sendNowPlaying(guildId: string): Promise<void> {
    const queue = await this.queueManager.getQueue(guildId);
    if (!queue) return;

    const current = queue.entries[queue.currentIndex];
    if (!current) return;

    const textChannel = this.guild.channels.cache.get(queue.textChannelId);
    if (!textChannel || textChannel.type !== ChannelType.GuildText) return;

    const position = this.getPlayerPosition(guildId);
    const activeFilters = this.getActiveFilters(guildId);
    const { embeds, components } = buildNowPlayingEmbed(current, position, queue, activeFilters);

    // Try to edit existing now-playing message
    const existingMsgId = await this.queueManager.getNowPlayingMessage(guildId);
    if (existingMsgId) {
      try {
        const msg = await textChannel.messages.fetch(existingMsgId);
        await msg.edit({ embeds, components });
        return;
      } catch {
        // Message deleted, send new one
      }
    }

    // Send new now-playing message
    const msg = await textChannel.send({ embeds, components });
    await this.queueManager.setNowPlayingMessage(guildId, msg.id);
  }

  // ── Voice State Handling ────────────────────────────────

  /** Called when voice state changes — handles auto-pause/resume/leave. */
  async handleVoiceStateChange(channelId: string): Promise<void> {
    const queue = await this.queueManager.getQueue(this.guild.id);
    if (!queue || queue.voiceChannelId !== channelId) return;

    const voiceChannel = this.guild.channels.cache.get(channelId);
    if (!voiceChannel || !voiceChannel.isVoiceBased()) return;

    const humanMembers = voiceChannel.members.filter((m) => !m.user.bot);

    if (humanMembers.size === 0) {
      // Bot is alone — auto-pause and start leave timer
      const player = this.shoukaku.players.get(this.guild.id);
      if (player && !queue.paused) {
        await player.setPaused(true);
        queue.paused = true;
        await this.queueManager.saveQueue(queue);
      }
      this.startAutoLeaveTimer(this.guild.id);
    } else {
      // Someone joined — cancel leave timer and resume if we auto-paused
      this.clearAutoLeaveTimer(this.guild.id);

      const player = this.shoukaku.players.get(this.guild.id);
      if (player && queue.paused) {
        await player.setPaused(false);
        queue.paused = false;
        await this.queueManager.saveQueue(queue);
      }
    }
  }

  // ── Button Interactions ─────────────────────────────────

  /** Handle music button interactions from now-playing embeds. */
  async handleButton(buttonId: string, userId: string): Promise<{ message: string }> {
    const guildId = this.guild.id;

    switch (buttonId) {
      case 'music:pause_resume': {
        const hasPerm = await this.isDJ(userId);
        if (!hasPerm) return { message: '❌ You need the DJ role to do that' };
        const result = await this.togglePause(guildId);
        return { message: result.message };
      }
      case 'music:skip': {
        const isDj = await this.isDJ(userId);
        if (isDj) {
          const result = await this.skip(guildId);
          return { message: result.message };
        }
        const result = await this.voteSkip(guildId, userId);
        return { message: result.message };
      }
      case 'music:stop': {
        const hasPerm = await this.isDJ(userId);
        if (!hasPerm) return { message: '❌ You need the DJ role to stop playback' };
        const result = await this.stop(guildId);
        return { message: result.message };
      }
      case 'music:shuffle': {
        const hasPerm = await this.isDJ(userId);
        if (!hasPerm) return { message: '❌ You need the DJ role to shuffle' };
        const result = await this.shuffle(guildId);
        return { message: result.message };
      }
      case 'music:loop': {
        const hasPerm = await this.isDJ(userId);
        if (!hasPerm) return { message: '❌ You need the DJ role to change loop mode' };
        const result = await this.cycleLoopMode(guildId);
        return { message: result.message };
      }
      // V53 Phase 3 (3.6): Volume buttons
      case 'music:vol_down': {
        const hasPerm = await this.isDJ(userId);
        if (!hasPerm) return { message: '❌ You need the DJ role to change volume' };
        const result = await this.setVolume(guildId, Math.max(0, (await this.queueManager.getQueue(guildId))?.volume ?? 50) - 10);
        return { message: result.message };
      }
      case 'music:vol_up': {
        const hasPerm = await this.isDJ(userId);
        if (!hasPerm) return { message: '❌ You need the DJ role to change volume' };
        const result = await this.setVolume(guildId, Math.min(100, ((await this.queueManager.getQueue(guildId))?.volume ?? 50) + 10));
        return { message: result.message };
      }
      default:
        return { message: '❌ Unknown action' };
    }
  }

  // ── Internal Helpers ────────────────────────────────────

  private resolveSearchQuery(query: string): string {
    // Direct URLs pass through
    if (query.startsWith('http://') || query.startsWith('https://')) {
      return query;
    }
    // Use current search provider (self-healer may have switched it)
    return `${this.selfHealer.getSearchProvider()}:${query}`;
  }

  private trackToEntry(track: Track, requestedBy: string): QueueEntry {
    return {
      track: track.encoded,
      title: track.info.title || 'Unknown',
      author: track.info.author || 'Unknown',
      duration: track.info.isStream ? 0 : (track.info.length || 0),
      uri: track.info.uri || '',
      artworkUrl: track.info.artworkUrl ?? null,
      requestedBy,
      addedAt: Date.now(),
      isStream: track.info.isStream || false,
    };
  }

  private formatSeekPosition(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  // ── Shoukaku Events ─────────────────────────────────────

  private setupShoukakuEvents(): void {
    this.shoukaku.on('ready', (name) => {
      log.info(`Lavalink node "${name}" ready`);
    });

    this.shoukaku.on('error', (name, error) => {
      log.error(`Lavalink node "${name}" error:`, error);
    });

    this.shoukaku.on('close', (name, code, reason) => {
      log.warn(`Lavalink node "${name}" closed: ${code} — ${reason}`);
    });
  }

  private setupPlayerEvents(player: Player): void {
    player.on('start', () => {
      this.sendNowPlaying(this.guild.id).catch((err) => {
        log.error('Failed to send now-playing:', { error: String(err) });
      });
      this.clearInactivityTimer(this.guild.id);

      // Emit track.started event
      this.queueManager.getQueue(this.guild.id).then((queue) => {
        const np = queue && queue.currentIndex < queue.entries.length
          ? queue.entries[queue.currentIndex]
          : null;
        if (np) {
          this.eventBus.emit('track.started', this.guild.id, {
            title: np.title ?? 'Unknown',
            author: np.author ?? 'Unknown',
            uri: np.uri ?? '',
            duration: np.duration ?? 0,
            requestedBy: np.requestedBy,
          });
          // Track music stats in Valkey
          this.trackMusicStats('track_played', {
            title: np.title ?? 'Unknown',
            author: np.author ?? 'Unknown',
            requestedBy: np.requestedBy,
          });
        }
      }).catch((e: unknown) => { log.warn('Operation failed:', (e as Error)?.message ?? e); });
    });

    player.on('end', async (data: TrackEndEvent) => {
      if (data.reason === 'replaced') return; // Track was replaced (skip)

      // Emit track.ended event for the track that just finished
      const currentQueue = await this.queueManager.getQueue(this.guild.id);
      const np = currentQueue && currentQueue.currentIndex < currentQueue.entries.length
        ? currentQueue.entries[currentQueue.currentIndex]
        : null;
      if (np) {
        this.eventBus.emit('track.ended', this.guild.id, {
          title: np.title ?? 'Unknown',
          author: np.author ?? 'Unknown',
          uri: np.uri ?? '',
          reason: data.reason === 'finished' ? 'finished' : 'skipped',
        });
      }

      const { track, queueEnded } = await this.queueManager.nextTrack(this.guild.id);

      if (queueEnded || !track) {
        // Queue ended — emit event
        const totalPlayed = await this.getMusicStat('tracks_played_session');
        this.eventBus.emit('queue.ended', this.guild.id, {
          totalTracksPlayed: totalPlayed,
        });
        await this.resetSessionStats();

        await this.queueManager.clearNowPlayingMessage(this.guild.id);
        this.resetInactivityTimer(this.guild.id);

        const queue = await this.queueManager.getQueue(this.guild.id);
        if (queue) {
          const textChannel = this.guild.channels.cache.get(queue.textChannelId);
          if (textChannel && textChannel.type === ChannelType.GuildText) {
            await textChannel.send({
              embeds: [buildMusicInfoEmbed('📭 Queue ended — add more tracks with `/play`')],
            }).catch((e: unknown) => { log.warn('Operation failed:', (e as Error)?.message ?? e); });
          }
        }
        return;
      }

      // Play next track
      await player.playTrack({ track: { encoded: track.track } });
      await this.queueManager.clearVoteSkip(this.guild.id);
    });

    player.on('exception', async (data: TrackExceptionEvent) => {
      log.error('Track exception:', data);
      const { shouldRecover, strategy } = this.selfHealer.recordFailure();

      if (shouldRecover && strategy === 'switch_search_provider') {
        this.selfHealer.switchSearchProvider();
      }

      // Skip to next track
      const queue = await this.queueManager.getQueue(this.guild.id);
      if (queue) {
        const textChannel = this.guild.channels.cache.get(queue.textChannelId);
        if (textChannel && textChannel.type === ChannelType.GuildText) {
          await textChannel.send({
            embeds: [buildMusicErrorEmbed('Failed to play track — skipping to next')],
          }).catch((e: unknown) => { log.warn('Operation failed:', (e as Error)?.message ?? e); });
        }
      }

      const { track } = await this.queueManager.nextTrack(this.guild.id);
      if (track) {
        await player.playTrack({ track: { encoded: track.track } });
      }
    });

    player.on('stuck', async () => {
      log.warn('Track stuck, skipping...');
      const { track } = await this.queueManager.nextTrack(this.guild.id);
      if (track) {
        await player.playTrack({ track: { encoded: track.track } });
      }
    });

    player.on('closed', async () => {
      log.info('Player connection closed — attempting reconnect');
      const queue = await this.queueManager.getQueue(this.guild.id);
      if (!queue || !queue.voiceChannelId) {
        // No queue to resume — clean up
        await this.queueManager.destroyQueue(this.guild.id);
        this.clearTimers(this.guild.id);
        return;
      }

      // Attempt reconnect with back-off
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await new Promise((r) => setTimeout(r, attempt * 2000));
          const newPlayer = await this.shoukaku.joinVoiceChannel({
            guildId: this.guild.id,
            channelId: queue.voiceChannelId,
            shardId: this.guild.shardId,
          });
          this.setupPlayerEvents(newPlayer);

          // Resume playback — re-resolve via URI in case encoded track expired
          const currentTrack = queue.currentIndex < queue.entries.length
            ? queue.entries[queue.currentIndex]
            : null;
          if (currentTrack?.uri) {
            try {
              const resolved = await newPlayer.node.rest.resolve(currentTrack.uri);
              if (resolved?.data && !Array.isArray(resolved.data) && 'encoded' in resolved.data) {
                await newPlayer.playTrack({ track: { encoded: resolved.data.encoded } });
              } else if (resolved?.data && Array.isArray(resolved.data) && resolved.data.length > 0) {
                await newPlayer.playTrack({ track: { encoded: resolved.data[0].encoded } });
              } else if (currentTrack.track) {
                // Fallback to the original encoded track
                await newPlayer.playTrack({ track: { encoded: currentTrack.track } });
              }
            } catch {
              // Last resort: try the stale encoded track
              if (currentTrack.track) {
                await newPlayer.playTrack({ track: { encoded: currentTrack.track } });
              }
            }
          } else if (currentTrack?.track) {
            await newPlayer.playTrack({ track: { encoded: currentTrack.track } });
          }
          log.info(`Reconnected after ${attempt} attempt(s)`);
          return;
        } catch (err) {
          log.warn(`Reconnect attempt ${attempt}/3 failed:`, err);
        }
      }

      // All reconnect attempts failed — clean up
      log.error('Failed to reconnect after 3 attempts — destroying queue');
      await this.queueManager.destroyQueue(this.guild.id);
      this.clearTimers(this.guild.id);
    });
  }

  // ── Auto Leave / Inactivity Timers ──────────────────────

  private startAutoLeaveTimer(guildId: string): void {
    this.clearAutoLeaveTimer(guildId);
    this.autoLeaveTimers.set(
      guildId,
      setTimeout(async () => {
        try {
          log.info(`Auto-leaving voice in guild ${guildId} (empty channel timeout)`);
          await this.stop(guildId);
        } catch (err) {
          log.error(`Auto-leave error for guild ${guildId}:`, err);
        }
      }, this.config.autoLeaveTimeout),
    );
  }

  private clearAutoLeaveTimer(guildId: string): void {
    const timer = this.autoLeaveTimers.get(guildId);
    if (timer) {
      clearTimeout(timer);
      this.autoLeaveTimers.delete(guildId);
    }
  }

  private resetInactivityTimer(guildId: string): void {
    this.clearInactivityTimer(guildId);
    this.inactivityTimers.set(
      guildId,
      setTimeout(async () => {
        try {
          log.info(`Auto-destroying player in guild ${guildId} (inactivity timeout)`);
          await this.stop(guildId);
        } catch (err) {
          log.error(`Inactivity auto-stop error for guild ${guildId}:`, err);
        }
      }, this.config.inactivityTimeout),
    );
  }

  private clearInactivityTimer(guildId: string): void {
    const timer = this.inactivityTimers.get(guildId);
    if (timer) {
      clearTimeout(timer);
      this.inactivityTimers.delete(guildId);
    }
  }

  private clearTimers(guildId: string): void {
    this.clearAutoLeaveTimer(guildId);
    this.clearInactivityTimer(guildId);
  }

  // ── Music Stats Tracking ────────────────────────────────

  /**
   * Track a music stat in Valkey for analytics.
   * Stats are stored with daily keys and expire after 90 days.
   */
  private async trackMusicStats(
    statType: string,
    data: Record<string, string>,
  ): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const guildId = this.guild.id;

    try {
      // Increment daily track count
      const dailyKey = `music:stats:${guildId}:${today}:tracks_played`;
      await this.valkey.incr(dailyKey);
      await this.valkey.expire(dailyKey, 90 * 86400); // 90 days

      // Increment session track count
      const sessionKey = `music:session:${guildId}:tracks_played`;
      await this.valkey.incr(sessionKey);
      await this.valkey.expire(sessionKey, 86400);

      // Track most-requested songs (sorted set)
      if (data.title) {
        const topKey = `music:stats:${guildId}:${today}:top_tracks`;
        await this.valkey.zincrby(topKey, 1, `${data.author} — ${data.title}`);
        await this.valkey.expire(topKey, 90 * 86400);
      }

      // Track most-active requesters
      if (data.requestedBy) {
        const reqKey = `music:stats:${guildId}:${today}:top_requesters`;
        await this.valkey.zincrby(reqKey, 1, data.requestedBy);
        await this.valkey.expire(reqKey, 90 * 86400);
      }

      // Track total listening time (increment by track duration if available)
      if (statType === 'track_played') {
        const listenKey = `music:stats:${guildId}:${today}:listen_minutes`;
        await this.valkey.incr(listenKey);
        await this.valkey.expire(listenKey, 90 * 86400);
      }
    } catch {
      // Stats are best-effort — don't let failures affect music playback
    }
  }

  private async getMusicStat(key: string): Promise<number> {
    try {
      const val = await this.valkey.get(`music:session:${this.guild.id}:${key}`);
      return parseInt(val ?? '0', 10);
    } catch {
      return 0;
    }
  }

  private async resetSessionStats(): Promise<void> {
    try {
      await this.valkey.del(`music:session:${this.guild.id}:tracks_played`);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Get music stats for the dashboard analytics page.
   */
  async getStats(days: number = 7): Promise<{
    totalTracksPlayed: number;
    topTracks: { name: string; count: number }[];
    topRequesters: { userId: string; count: number }[];
    dailyPlays: { date: string; count: number }[];
  }> {
    const guildId = this.guild.id;
    const stats = {
      totalTracksPlayed: 0,
      topTracks: [] as { name: string; count: number }[],
      topRequesters: [] as { userId: string; count: number }[],
      dailyPlays: [] as { date: string; count: number }[],
    };

    try {
      for (let i = 0; i < days; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().slice(0, 10);

        const countStr = await this.valkey.get(`music:stats:${guildId}:${dateStr}:tracks_played`);
        const count = parseInt(countStr ?? '0', 10);
        stats.totalTracksPlayed += count;
        stats.dailyPlays.push({ date: dateStr, count });

        // Aggregate top tracks
        if (i === 0) {
          const topTracks = await this.valkey.zrevrange(
            `music:stats:${guildId}:${dateStr}:top_tracks`,
            0, 9,
            'WITHSCORES',
          );
          for (let j = 0; j < topTracks.length; j += 2) {
            stats.topTracks.push({
              name: topTracks[j]!,
              count: parseInt(topTracks[j + 1] ?? '0', 10),
            });
          }

          const topReq = await this.valkey.zrevrange(
            `music:stats:${guildId}:${dateStr}:top_requesters`,
            0, 9,
            'WITHSCORES',
          );
          for (let j = 0; j < topReq.length; j += 2) {
            stats.topRequesters.push({
              userId: topReq[j]!,
              count: parseInt(topReq[j + 1] ?? '0', 10),
            });
          }
        }
      }
    } catch {
      // Stats are best-effort
    }

    return stats;
  }
}
