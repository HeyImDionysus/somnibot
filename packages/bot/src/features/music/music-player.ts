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
    console.log('[Music] Player manager started');
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
      .select('default_volume, max_queue_length, allow_duplicates, dj_role_id')
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    if (data) {
      this.config = {
        ...DEFAULT_CONFIG,
        defaultVolume: data.default_volume ?? DEFAULT_CONFIG.defaultVolume,
        maxQueueLength: data.max_queue_length ?? DEFAULT_CONFIG.maxQueueLength,
        allowDuplicates: data.allow_duplicates ?? DEFAULT_CONFIG.allowDuplicates,
        djRoleId: data.dj_role_id ?? null,
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
        shardId: 0,
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
    const { embeds, components } = buildNowPlayingEmbed(current, position, queue);

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
      duration: track.info.length || 0,
      uri: track.info.uri || '',
      artworkUrl: track.info.artworkUrl ?? null,
      requestedBy,
      addedAt: Date.now(),
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
      console.log(`[Music] Lavalink node "${name}" ready`);
    });

    this.shoukaku.on('error', (name, error) => {
      console.error(`[Music] Lavalink node "${name}" error:`, error);
    });

    this.shoukaku.on('close', (name, code, reason) => {
      console.warn(`[Music] Lavalink node "${name}" closed: ${code} — ${reason}`);
    });
  }

  private setupPlayerEvents(player: Player): void {
    player.on('start', () => {
      this.sendNowPlaying(this.guild.id).catch((err) => {
        console.error('[Music] Failed to send now-playing:', err);
      });
      this.clearInactivityTimer(this.guild.id);
    });

    player.on('end', async (data: TrackEndEvent) => {
      if (data.reason === 'replaced') return; // Track was replaced (skip)

      const { track, queueEnded } = await this.queueManager.nextTrack(this.guild.id);

      if (queueEnded || !track) {
        // Queue ended
        await this.queueManager.clearNowPlayingMessage(this.guild.id);
        this.resetInactivityTimer(this.guild.id);

        const queue = await this.queueManager.getQueue(this.guild.id);
        if (queue) {
          const textChannel = this.guild.channels.cache.get(queue.textChannelId);
          if (textChannel && textChannel.type === ChannelType.GuildText) {
            await textChannel.send({
              embeds: [buildMusicInfoEmbed('📭 Queue ended — add more tracks with `/play`')],
            }).catch(() => {});
          }
        }
        return;
      }

      // Play next track
      await player.playTrack({ track: { encoded: track.track } });
      await this.queueManager.clearVoteSkip(this.guild.id);
    });

    player.on('exception', async (data: TrackExceptionEvent) => {
      console.error('[Music] Track exception:', data);
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
          }).catch(() => {});
        }
      }

      const { track } = await this.queueManager.nextTrack(this.guild.id);
      if (track) {
        await player.playTrack({ track: { encoded: track.track } });
      }
    });

    player.on('stuck', async () => {
      console.warn('[Music] Track stuck, skipping...');
      const { track } = await this.queueManager.nextTrack(this.guild.id);
      if (track) {
        await player.playTrack({ track: { encoded: track.track } });
      }
    });

    player.on('closed', async () => {
      console.log('[Music] Player connection closed');
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
        console.log(`[Music] Auto-leaving voice in guild ${guildId} (empty channel timeout)`);
        await this.stop(guildId);
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
        console.log(`[Music] Auto-destroying player in guild ${guildId} (inactivity timeout)`);
        await this.stop(guildId);
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
}
