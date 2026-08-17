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
import type { Shoukaku, Player, Track, TrackExceptionEvent, TrackEndEvent, TrackStartEvent, TrackStuckEvent, WebSocketClosedEvent } from 'shoukaku';
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
import { raiseOwnerAlert } from '../../services/alert-service.js';

const log = createLogger('MusicPlayer');

// ── Config ────────────────────────────────────────────────

interface MusicConfig {
  defaultVolume: number;
  maxQueueLength: number;
  allowDuplicates: boolean;
  perUserQueueCap: number;
  djRoleId: string | null;
  autoLeaveTimeout: number;   // ms — default 5 min
  inactivityTimeout: number;  // ms — default 30 min
  // ── Fairness controls (catalog: music.json) ──
  voteSkipThresholdPercent: number;  // % of human listeners needed to skip
  selfSkipEnabled: boolean;          // requester can skip their own track without a vote
  requesterMoveEnabled: boolean;     // requester can move their own queued track
  priorityVotingEnabled: boolean;    // a DJ's skip vote carries immediately
}

/** How a skip was resolved — recorded on the music.skipped audit event so the
 *  fairness arbitration (DJ force / listener vote / self / DJ priority) is
 *  observable in the append-only audit trail. */
export type SkipMethod = 'dj_force' | 'vote' | 'self' | 'priority';

/** Why playback was stopped and the queue torn down — recorded on music.stopped. */
export type StopReason = 'command' | 'auto_leave' | 'inactivity' | 'connection_lost';

/**
 * Who applied a fairness-gated control, for the music.control_applied audit
 * event. `internal: true` marks a bot-side restore rather than an owner-visible
 * control change (re-applying the queue's stored volume when playback starts,
 * or a public method delegating to another one) — those write no audit row, so
 * one member action never lands two.
 */
export type ControlActor = { userId?: string; internal?: boolean };

type PlayResult = {
  success: boolean;
  message?: string;
  entry?: QueueEntry;
  count?: number;
  playlistName?: string;
};

type PlayMutationResult = {
  response: PlayResult;
  playback: Promise<void> | null;
};

type PauseTransition = {
  previousPaused: boolean;
  newPaused: boolean;
  revision: number;
};

type PendingTrackStart = {
  entry: QueueEntry;
  encodedTrack: string;
  playbackRevision: number;
  sessionRevision: number;
};

type PlaybackIdentity = {
  playbackRevision: number;
  sessionRevision: number;
};

type PlaybackEventTrack = Track & {
  userData?: {
    somnibotPlayback?: Partial<PlaybackIdentity>;
  };
};

type QueueEndState = {
  textChannelId: string | null;
  sessionRevision: number;
};

const DEFAULT_CONFIG: MusicConfig = {
  defaultVolume: 50,
  maxQueueLength: 5000,
  allowDuplicates: true,
  perUserQueueCap: 50,
  djRoleId: null,
  autoLeaveTimeout: 5 * 60 * 1000,
  inactivityTimeout: 30 * 60 * 1000,
  voteSkipThresholdPercent: 50,
  selfSkipEnabled: true,
  requesterMoveEnabled: true,
  priorityVotingEnabled: true,
};

// ── Player Manager ────────────────────────────────────────

export class MusicPlayerManager {
  public readonly queueManager: MusicQueueManager;
  private readonly selfHealer = new MusicSelfHealer();
  private config: MusicConfig = { ...DEFAULT_CONFIG };
  private autoLeaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inactivityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private voiceOperationRevision = 0;
  private reconnectingVoice = false;
  private intentionalVoiceLeaveDepth = 0;
  private disposed = false;
  private queueMutationTail: Promise<void> = Promise.resolve();
  private playbackMutationTail: Promise<void> = Promise.resolve();
  private queueExhausted = false;
  private stopInProgress = false;
  private stopRevision = 0;
  private playRequestRevision = 0;
  private pendingPlayRequests = new Set<number>();
  private uncommittedVoiceSession = false;
  private uncommittedVoiceChannelId: string | null = null;
  private uncommittedVoiceCleanupInProgress = false;
  private pendingVoiceJoin: Promise<Player> | null = null;
  private pendingVoiceChannelId: string | null = null;
  private pendingTrackStarts: PendingTrackStart[] = [];
  private trackPlaybackRevision = 0;
  private latestStartedPlaybackRevision = 0;
  private playbackSessionRevision = 0;
  private playbackMutationRevision = 0;
  private nowPlayingMutationTail: Promise<void> = Promise.resolve();
  private playbackRestartRequired = false;
  private pauseRevision = 0;
  private appliedPaused: boolean | null = null;
  private volumeRevision = 0;
  private appliedVolume: number | null = null;

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
      if (!existingPlayer.track && queue && queue.currentIndex < queue.entries.length) {
        this.playbackRestartRequired = true;
      }
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
    this.disposed = true;
    this.voiceOperationRevision += 1;
    this.playbackSessionRevision += 1;
    this.playbackMutationRevision += 1;
    this.pendingTrackStarts = [];
    for (const timer of this.autoLeaveTimers.values()) clearTimeout(timer);
    for (const timer of this.inactivityTimers.values()) clearTimeout(timer);
    this.autoLeaveTimers.clear();
    this.inactivityTimers.clear();
  }

  // ── Config ──────────────────────────────────────────────

  private async loadConfig(): Promise<void> {
    const { data } = await this.supabase
      .from('guild_config')
      .select('music_default_volume, dj_role_id, music_auto_leave_minutes, music_auto_destroy_minutes, max_queue_length, allow_duplicates, per_user_queue_cap, vote_skip_threshold_percent, self_skip_enabled, requester_move_enabled, priority_voting_enabled')
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    if (data) {
      const autoLeaveMin = data.music_auto_leave_minutes ?? 5;
      const autoDestroyMin = data.music_auto_destroy_minutes ?? 30;
      this.config = {
        ...DEFAULT_CONFIG,
        defaultVolume: data.music_default_volume ?? DEFAULT_CONFIG.defaultVolume,
        maxQueueLength: data.max_queue_length ?? DEFAULT_CONFIG.maxQueueLength,
        allowDuplicates: data.allow_duplicates ?? DEFAULT_CONFIG.allowDuplicates,
        perUserQueueCap: data.per_user_queue_cap ?? DEFAULT_CONFIG.perUserQueueCap,
        djRoleId: data.dj_role_id ?? null,
        autoLeaveTimeout: autoLeaveMin * 60 * 1000,
        inactivityTimeout: autoDestroyMin * 60 * 1000,
        voteSkipThresholdPercent: data.vote_skip_threshold_percent ?? DEFAULT_CONFIG.voteSkipThresholdPercent,
        selfSkipEnabled: data.self_skip_enabled ?? DEFAULT_CONFIG.selfSkipEnabled,
        requesterMoveEnabled: data.requester_move_enabled ?? DEFAULT_CONFIG.requesterMoveEnabled,
        priorityVotingEnabled: data.priority_voting_enabled ?? DEFAULT_CONFIG.priorityVotingEnabled,
      };
      this.queueManager.setLimits({
        maxQueueSize: this.config.maxQueueLength,
        maxPerUserQueue: this.config.perUserQueueCap,
      });
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

  // ── Audit helpers ───────────────────────────────────────

  /**
   * [music-player-fairness] Record a denied fairness-gated control (a DJ-only
   * action attempted by a non-DJ, or a queue move a member isn't allowed to
   * make) on the append-only audit trail so enforcement is observable.
   */
  auditPermissionDenied(userId: string, action: string): void {
    this.eventBus.emit('music.denied', this.guild.id, { userId, action });
  }

  /**
   * The APPLIED counterpart of auditPermissionDenied — every fairness-gated
   * control whose DENIAL is audited records its SUCCESS too, so the trail
   * cannot show refusals for a control it never shows being used. Skip and
   * stop are excluded: they already emit their own richer events.
   */
  private auditControlApplied(
    context: ControlActor,
    action: string,
    value?: string | number | null,
  ): void {
    if (context.internal || !context.userId) return;
    this.eventBus.emit('music.control_applied', this.guild.id, {
      userId: context.userId,
      action,
      value: value ?? null,
    });
  }

  /** Record one truthful member audit for the filter state this action applied. */
  auditFilterActionApplied(
    userId: string,
    preset: FilterPreset,
    speed?: number,
    pitch?: number,
    rate?: number,
  ): void {
    const parts = [`preset: ${preset}`];
    if (speed !== undefined) parts.push(`speed: ${Math.max(0.1, Math.min(3.0, speed))}x`);
    if (pitch !== undefined) parts.push(`pitch: ${Math.max(0.1, Math.min(3.0, pitch))}x`);
    if (rate !== undefined) parts.push(`rate: ${Math.max(0.1, Math.min(3.0, rate))}x`);
    this.auditControlApplied({ userId }, 'filter', parts.join(', '));
  }

  /**
   * [music-collaborative-queue] Store-outage lane: when the Valkey-backed queue
   * store is unreachable, emit an audit event and persist a durable owner alert
   * so an operator can see that playback is degraded. Best-effort — a failed
   * alert insert never masks the original failure.
   */
  private async raiseStoreOutageAlert(userId: string, operation: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.eventBus.emit('music.store_outage', this.guild.id, { userId, operation, error: message });
    try {
      await raiseOwnerAlert(this.supabase, this.guild.id, {
        alertType: 'music_store_outage',
        severity: 'warning',
        title: 'Music queue store unavailable',
        message: `The music queue store could not be reached during "${operation}". Playback is degraded until it recovers.`,
        metadata: { user_id: userId, operation, error: message },
        guild: this.guild,
      });
    } catch (alertErr) {
      log.warn('Failed to raise music store-outage alert:', (alertErr as Error)?.message ?? alertErr);
    }
  }

  // ── Core Playback ───────────────────────────────────────

  /** Search and play a track. Returns the queue entry or error message. */
  async play(
    query: string,
    userId: string,
    voiceChannel: VoiceBasedChannel,
    textChannel: TextChannel,
  ): Promise<{ success: boolean; message?: string; entry?: QueueEntry; count?: number; playlistName?: string }> {
    if (this.reconnectingVoice) {
      return { success: false, message: 'Voice is reconnecting — please try again shortly.' };
    }
    if (this.uncommittedVoiceCleanupInProgress) {
      return { success: false, message: 'Voice is resetting — please try again shortly.' };
    }
    if (this.stopInProgress) {
      return { success: false, message: 'Playback is stopping — please try again shortly.' };
    }
    const requestRevision = ++this.playRequestRevision;
    this.pendingPlayRequests.add(requestRevision);
    const expectedStopRevision = this.stopRevision;

    let queueBeforeResolve: GuildQueue | null;
    try {
      queueBeforeResolve = await this.queueManager.getQueue(this.guild.id);
    } catch (err) {
      await this.raiseStoreOutageAlert(userId, 'load_queue', err);
      await this.completePlayRequest(requestRevision, true);
      return { success: false, message: 'Music storage is temporarily unavailable — please try again shortly.' };
    }
    if (queueBeforeResolve && !this.queueExhausted) {
      const capacityRejection = this.getCapacityRejection(queueBeforeResolve, userId);
      if (capacityRejection) {
        await this.completePlayRequest(requestRevision, true);
        return capacityRejection;
      }
    }
    if (this.stopInProgress || this.stopRevision !== expectedStopRevision) {
      await this.completePlayRequest(requestRevision, false);
      return { success: false, message: 'Playback is stopping — please try again shortly.' };
    }

    const searchQuery = this.resolveSearchQuery(query);
    let player = this.shoukaku.players.get(this.guild.id) ?? null;
    try {
      if (!player) {
        if (this.pendingVoiceJoin) {
          if (this.pendingVoiceChannelId !== voiceChannel.id) {
            await this.completePlayRequest(requestRevision, false);
            return {
              success: false,
              message: 'Voice is already connecting in another channel — please use that channel or try again shortly.',
            };
          }
          player = await this.pendingVoiceJoin;
        } else {
          const node = this.shoukaku.options.nodeResolver(this.shoukaku.nodes);
          if (!node) {
            await this.completePlayRequest(requestRevision, false);
            return { success: false, message: 'No Lavalink nodes available' };
          }

          this.voiceOperationRevision += 1;
          const join = this.shoukaku.joinVoiceChannel({
            guildId: this.guild.id,
            channelId: voiceChannel.id,
            // V11 Audit M-4: Use the guild's actual shard ID for multi-shard support.
            shardId: this.guild.shardId,
            deaf: true,
          });
          this.pendingVoiceJoin = join;
          this.pendingVoiceChannelId = voiceChannel.id;
          try {
            player = await join;
            this.setupPlayerEvents(player);
            this.uncommittedVoiceSession = true;
            this.uncommittedVoiceChannelId = voiceChannel.id;
          } finally {
            if (this.pendingVoiceJoin === join) {
              this.pendingVoiceJoin = null;
              this.pendingVoiceChannelId = null;
            }
          }
        }
      }
      if (
        this.uncommittedVoiceSession &&
        this.uncommittedVoiceChannelId !== null &&
        this.uncommittedVoiceChannelId !== voiceChannel.id
      ) {
        await this.completePlayRequest(requestRevision, false);
        return {
          success: false,
          message: 'Voice is already connected in another channel — please use that channel.',
        };
      }
      const activePlayer = player;
      const expectedVoiceRevision = this.voiceOperationRevision;

      const result = await activePlayer.node.rest.resolve(searchQuery);
      if (
        this.stopInProgress ||
        this.stopRevision !== expectedStopRevision ||
        this.voiceOperationRevision !== expectedVoiceRevision
      ) {
        await this.completePlayRequest(requestRevision, false);
        return { success: false, message: 'Playback was stopped before the track could be queued.' };
      }
      await this.waitForPlaybackMutations();
      const transition = await this.withQueueMutation(() => this.playWithinQueueMutation(
        userId,
        voiceChannel,
        textChannel,
        activePlayer,
        result,
        requestRevision,
        expectedVoiceRevision,
        expectedStopRevision,
      ));
      if (transition.playback) await transition.playback;
      await this.completePlayRequest(requestRevision, !transition.response.success);
      return transition.response;
    } catch (error) {
      await this.completePlayRequest(requestRevision, true);
      throw error;
    }
  }

  private getCapacityRejection(
    queue: GuildQueue,
    userId: string,
  ): { success: false; message: string } | null {
    if (queue.entries.length >= this.config.maxQueueLength) {
      this.eventBus.emit('music.capacity_rejected', this.guild.id, {
        userId,
        reason: 'queue_full',
        limit: this.config.maxQueueLength,
      });
      return { success: false, message: `Queue is full (max ${this.config.maxQueueLength} tracks)` };
    }

    const maxPerUser = this.config.perUserQueueCap;
    const userQueueCount = queue.entries.filter((entry) => entry.requestedBy === userId).length;
    if (userQueueCount >= maxPerUser) {
      this.eventBus.emit('music.capacity_rejected', this.guild.id, {
        userId,
        reason: 'user_limit',
        limit: maxPerUser,
      });
      return { success: false, message: `You've reached the per-user limit of ${maxPerUser} queued tracks` };
    }

    return null;
  }

  private async playWithinQueueMutation(
    userId: string,
    voiceChannel: VoiceBasedChannel,
    textChannel: TextChannel,
    player: Player,
    result: Awaited<ReturnType<Player['node']['rest']['resolve']>>,
    requestRevision: number,
    expectedVoiceRevision: number,
    expectedStopRevision: number,
  ): Promise<PlayMutationResult> {

    if (
      this.stopInProgress ||
      this.stopRevision !== expectedStopRevision ||
      this.voiceOperationRevision !== expectedVoiceRevision
    ) {
      return {
        response: { success: false, message: 'Playback was stopped before the track could be queued.' },
        playback: null,
      };
    }

    // Get or create queue. [music-collaborative-queue] The queue lives in the
    // Valkey store; if that store is unreachable, raise a durable owner alert
    // (store-outage lane) instead of letting the request fail silently.
    let existingQueue: GuildQueue | null;
    try {
      existingQueue = await this.queueManager.getQueue(this.guild.id);
    } catch (err) {
      await this.raiseStoreOutageAlert(userId, 'load_queue', err);
      return {
        response: { success: false, message: 'Music storage is temporarily unavailable — please try again shortly.' },
        playback: null,
      };
    }

    const isNewQueue = !existingQueue;
    let queue: GuildQueue;
    if (existingQueue) {
      queue = existingQueue;
    } else {
      queue = this.queueManager.createQueue(
        this.guild.id,
        voiceChannel.id,
        textChannel.id,
        this.config.defaultVolume,
      );
    }

    if (this.uncommittedVoiceSession) {
      queue.voiceChannelId = this.uncommittedVoiceChannelId ?? voiceChannel.id;
      queue.textChannelId = textChannel.id;
    }

    const queueWasExhausted = this.queueExhausted || Boolean(
      existingQueue && existingQueue.entries.length === 0,
    );
    if (queueWasExhausted) {
      queue.entries = [];
      queue.currentIndex = 0;
      queue.paused = false;
      queue.shuffled = false;
      this.pauseRevision += 1;
    }

    // Check queue size limit — [music-collaborative-queue] capacity lane.
    const capacityRejection = this.getCapacityRejection(queue, userId);
    if (capacityRejection) return { response: capacityRejection, playback: null };

    if (!result || result.loadType === 'empty' || result.loadType === 'error') {
      this.selfHealer.recordFailure();
      return { response: { success: false, message: 'No results found for your query' }, playback: null };
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
        return { response: { success: false, message: 'No results found for your query' }, playback: null };
      }

      const entry = this.trackToEntry(track, userId);

      if (!this.config.allowDuplicates && queue.entries.some((e) => e.uri === entry.uri)) {
        return { response: { success: false, message: 'This track is already in the queue' }, playback: null };
      }

      addedEntries = [entry];
    }

    if (addedEntries.length === 0) {
      return {
        response: { success: false, message: 'No tracks could be added (duplicates filtered)' },
        playback: null,
      };
    }

    // Add to queue
    queue.entries.push(...addedEntries);
    try {
      await this.queueManager.saveQueue(queue);
    } catch (err) {
      await this.raiseStoreOutageAlert(userId, 'save_queue', err);
      return {
        response: { success: false, message: 'Music storage is temporarily unavailable — please try again shortly.' },
        playback: null,
      };
    }
    if (queueWasExhausted) this.playbackSessionRevision += 1;
    const ownsUncommittedVoiceSession = this.uncommittedVoiceSession;
    this.uncommittedVoiceSession = false;
    this.uncommittedVoiceChannelId = null;

    // Audit the persisted ADD side of the shared queue before playback setup.
    // music.skipped / music.stopped record only removals, so without this the
    // trail shows tracks leaving a queue nothing was ever recorded as entering.
    // One row per accepted /play (single track or whole playlist), matching how
    // one skip = one row.
    const firstAdded = addedEntries[0]!;
    this.eventBus.emit('music.queued', this.guild.id, {
      userId,
      title: addedEntries.length === 1 ? firstAdded.title : (playlistName ?? firstAdded.title),
      author: firstAdded.author,
      uri: sanitizeAuditMediaUri(firstAdded.uri),
      trackCount: addedEntries.length,
      playlistName: playlistName ?? null,
      queueLength: queue.entries.length,
      sessionStarted: isNewQueue || queueWasExhausted,
    });

    // If this is the first track (or queue was empty), start playing
    const shouldPlay = isNewQueue || queueWasExhausted || ownsUncommittedVoiceSession || this.playbackRestartRequired ||
      queue.entries.length === addedEntries.length;

    let playback: Promise<void> | null = null;
    if (shouldPlay) {
      const firstEntry = queue.entries[queue.currentIndex];
      if (firstEntry) {
        this.queueExhausted = false;
        const volume = queue.volume;
        playback = this.enqueueTrackPlaybackAfterQueueMutation(player, firstEntry, async () => {
          await player.setGlobalVolume(volume);
          this.appliedVolume = volume;
        });
      }
    }

    // Reset inactivity timer
    this.resetInactivityTimer(this.guild.id);

    if (addedEntries.length === 1 && addedEntries[0]) {
      return {
        response: { success: true, entry: addedEntries[0], message: undefined, count: 1 },
        playback,
      };
    }

    return {
      response: {
        success: true,
        count: addedEntries.length,
        playlistName,
      },
      playback,
    };
  }

  /**
   * Skip the current track. `context` carries the actor + fairness path so the
   * skip can be audited; all skip entry points (DJ force, vote threshold, self,
   * DJ priority) funnel through here so a single emit covers every skip.
   */
  async skip(
    guildId: string,
    context: { userId?: string; method?: SkipMethod } = {},
  ): Promise<{ success: boolean; message: string }> {
    const player = this.shoukaku.players.get(guildId);
    if (!player) return { success: false, message: 'Nothing is playing' };

    const transition = await this.withQueueMutation(async () => {
      if (this.stopInProgress) return null;
      await this.queueManager.clearVoteSkip(guildId);
      const skippedTrack = await this.queueManager.getCurrentTrack(guildId);
      const queueTransition = await this.queueManager.nextTrack(guildId);
      let playback: Promise<void>;
      if (queueTransition.queueEnded || !queueTransition.track) {
        playback = this.enqueuePlaybackAfterQueueMutation(async () => {
          await player.stopTrack();
        });
      } else {
        playback = this.enqueueTrackPlaybackAfterQueueMutation(player, queueTransition.track);
      }
      return { skipped: skippedTrack, ...queueTransition, playback };
    });
    if (!transition) {
      return { success: false, message: 'Playback is stopping — please try again shortly.' };
    }
    const { skipped, track, queueEnded, playback } = transition;

    // [music-player-fairness] Audit the skip outcome — proves which fairness
    // path resolved the skip and who invoked it.
    this.eventBus.emit('music.skipped', this.guild.id, {
      userId: context.userId,
      method: context.method ?? 'dj_force',
      title: skipped?.title ?? 'Unknown',
      author: skipped?.author ?? 'Unknown',
      requestedBy: skipped?.requestedBy ?? 'unknown',
      queueEnded: queueEnded || !track,
    });

    await playback;
    if (queueEnded || !track) return { success: true, message: '⏭️ Skipped — queue ended' };
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

    const current = queue.entries[queue.currentIndex];

    // Self-skip: when enabled, the requester of the current track skips it
    // outright (no vote) — it's their own song.
    if (this.config.selfSkipEnabled && current && current.requestedBy === userId) {
      return this.skip(guildId, { userId, method: 'self' });
    }

    // Priority voting: when enabled AND a DJ role is actually configured, a DJ's
    // skip vote carries immediately. (Without a DJ role, isDJ() is true for
    // everyone, so there is no privileged group — fall through to a normal vote.)
    if (this.config.priorityVotingEnabled && this.config.djRoleId && (await this.isDJ(userId))) {
      return this.skip(guildId, { userId, method: 'priority' });
    }

    if (await this.queueManager.hasVotedSkip(guildId, userId)) {
      return { success: false, message: 'You already voted to skip' };
    }

    // Configurable threshold: need ceil(listeners * threshold%) votes (min 1).
    const humanCount = voiceChannel.members.filter((m) => !m.user.bot).size;
    const required = Math.max(
      1,
      Math.ceil((humanCount * this.config.voteSkipThresholdPercent) / 100),
    );
    const votes = await this.queueManager.addVoteSkip(guildId, userId);

    if (votes >= required) {
      return this.skip(guildId, { userId, method: 'vote' });
    }

    return {
      success: true,
      message: `🗳️ Skip vote: **${votes}/${required}** needed`,
    };
  }

  /** Stop playback and clear the queue. `context` records who/what tore the
   *  shared queue down so the lifecycle transition is auditable. */
  async stop(
    guildId: string,
    context: { userId?: string; reason?: StopReason } = {},
  ): Promise<{ success: boolean; message: string }> {
    const stopClaim = await this.withQueueMutation(async () => {
      if (this.stopInProgress) return null;
      this.stopInProgress = true;
      try {
        const queueBeforeStop = await this.queueManager.getQueue(guildId);
        this.stopRevision += 1;
        this.voiceOperationRevision += 1;
        this.playbackSessionRevision += 1;
        this.playbackMutationRevision += 1;
        this.pendingTrackStarts = [];
        const player = this.shoukaku.players.get(guildId) ?? null;
        const pendingPlayer = this.pendingVoiceJoin;
        this.intentionalVoiceLeaveDepth += 1;
        const playback = this.enqueuePlaybackAfterQueueMutation(async () => {
          let playerToStop = player;
          if (!playerToStop && pendingPlayer) {
            try {
              playerToStop = await pendingPlayer;
            } catch {
              return;
            }
          }
          if (!playerToStop) return;
          try {
            await playerToStop.stopTrack();
          } catch (error) {
            log.warn('Failed to stop the current track during queue teardown:', (error as Error)?.message ?? error);
          }
          await this.clearVoiceConnectionForRecovery(guildId, 'Stop voice cleanup');
        });
        return { queueBeforeStop, playback };
      } catch (error) {
        this.stopInProgress = false;
        throw error;
      }
    });
    if (!stopClaim) {
      return { success: true, message: '⏹️ Playback is already stopping' };
    }
    try {
      await stopClaim.playback;

      await this.withQueueMutation(async () => {
        await this.queueManager.destroyQueue(guildId);
        this.queueExhausted = false;
        this.uncommittedVoiceSession = false;
        this.uncommittedVoiceChannelId = null;
        this.playbackRestartRequired = false;
        this.pendingTrackStarts = [];
        this.trackPlaybackRevision += 1;
        this.appliedPaused = null;
        this.appliedVolume = null;
        this.pauseRevision += 1;
        this.volumeRevision += 1;
      });
      this.clearTimers(guildId);

      // [music-collaborative-queue] Audit the queue teardown /
      // [music-player-fairness] lifecycle stop so the shared session's end is
      // observable, including automatic (empty-channel / inactivity) teardowns.
      this.eventBus.emit('music.stopped', this.guild.id, {
        userId: context.userId,
        reason: context.reason ?? 'command',
        trackCount: stopClaim.queueBeforeStop?.entries.length ?? 0,
      });

      return { success: true, message: '⏹️ Stopped playback and cleared the queue' };
    } finally {
      await this.withQueueMutation(async () => {
        this.stopInProgress = false;
      });
      this.intentionalVoiceLeaveDepth -= 1;
    }
  }

  /** Pause or resume playback. */
  async togglePause(guildId: string, context: ControlActor = {}): Promise<{ success: boolean; paused: boolean; message: string }> {
    const player = this.shoukaku.players.get(guildId);
    if (!player) return { success: false, paused: false, message: 'Nothing is playing' };
    const expectedStopRevision = this.stopRevision;
    const expectedSessionRevision = this.playbackSessionRevision;
    if (this.stopInProgress) {
      return { success: false, paused: false, message: 'Playback is stopping' };
    }

    const pauseTransition = await this.withQueueMutation(async () => {
      if (this.stopInProgress || this.stopRevision !== expectedStopRevision) return null;
      const queue = await this.queueManager.getQueue(guildId);
      if (!queue) return null;

      const previousPaused = queue.paused;
      if (this.appliedPaused === null) this.appliedPaused = previousPaused;
      const newPaused = !queue.paused;
      queue.paused = newPaused;
      await this.queueManager.saveQueue(queue);
      const revision = ++this.pauseRevision;
      const state = { finalPaused: newPaused };
      const playback = this.enqueuePlaybackAfterQueueMutation(async () => {
        state.finalPaused = await this.reconcilePlayerPauseState(player, newPaused, revision);
      });
      return {
        previousPaused,
        newPaused,
        revision,
        sessionRevision: expectedSessionRevision,
        state,
        playback,
      };
    });
    if (!pauseTransition) return { success: false, paused: false, message: 'No active queue' };

    try {
      await pauseTransition.playback;
      const appliedPaused = pauseTransition.state.finalPaused;
      const reportedPaused = pauseTransition.sessionRevision === this.playbackSessionRevision
        ? pauseTransition.newPaused
        : appliedPaused;
      this.auditControlApplied(context, 'pause', reportedPaused ? 'paused' : 'resumed');
      if (appliedPaused) {
        this.resetInactivityTimer(guildId);
      } else {
        this.clearInactivityTimer(guildId);
      }

      return {
        success: true,
        paused: reportedPaused,
        message: reportedPaused ? '⏸️ Paused' : '▶️ Resumed',
      };
    } catch (error) {
      await this.rollbackPauseTransition(guildId, pauseTransition);
      throw error;
    }
  }

  /** Seek to a position in the current track. */
  async seek(guildId: string, positionMs: number, context: ControlActor = {}): Promise<{ success: boolean; message: string }> {
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
    this.auditControlApplied(context, 'seek', positionMs);
    return { success: true, message: `⏩ Seeked to \`${this.formatSeekPosition(positionMs)}\`` };
  }

  /** Set volume (0–100). */
  async setVolume(guildId: string, volume: number, context: ControlActor = {}): Promise<{ success: boolean; message: string }> {
    const player = this.shoukaku.players.get(guildId);
    if (!player) return { success: false, message: 'Nothing is playing' };
    const expectedStopRevision = this.stopRevision;
    if (this.stopInProgress) return { success: false, message: 'Playback is stopping' };

    const clamped = Math.max(0, Math.min(150, volume));
    const transition = await this.withQueueMutation(async () => {
      if (this.stopInProgress || this.stopRevision !== expectedStopRevision) return null;
      let previousVolume: number | null = null;
      let revision: number | null = null;
      if (!context.internal) {
        const queue = await this.queueManager.getQueue(guildId);
        if (queue) {
          previousVolume = queue.volume;
          queue.volume = clamped;
          await this.queueManager.saveQueue(queue);
          revision = ++this.volumeRevision;
          if (this.appliedVolume === null) this.appliedVolume = previousVolume;
        }
      }
      return {
        previousVolume,
        revision,
        playback: this.enqueuePlaybackAfterQueueMutation(async () => {
          await player.setGlobalVolume(clamped);
          this.appliedVolume = clamped;
        }),
      };
    });
    if (!transition) return { success: false, message: 'Playback is stopping' };
    try {
      await transition.playback;
    } catch (error) {
      const rollbackVolume = this.appliedVolume ?? transition.previousVolume;
      const failedRevision = transition.revision;
      if (rollbackVolume !== null && failedRevision !== null) {
        await this.withQueueMutation(async () => {
          const queue = await this.queueManager.getQueue(guildId);
          if (
            !queue ||
            queue.volume !== clamped ||
            this.volumeRevision !== failedRevision
          ) return;
          queue.volume = rollbackVolume;
          await this.queueManager.saveQueue(queue);
          this.volumeRevision += 1;
        });
      }
      throw error;
    }

    this.auditControlApplied(context, 'volume', clamped);
    return { success: true, message: `🔊 Volume set to **${clamped}%**` };
  }

  /** Set loop mode. */
  async setLoopMode(guildId: string, mode: LoopMode, context: ControlActor = {}): Promise<{ success: boolean; message: string }> {
    const expectedStopRevision = this.stopRevision;
    if (this.stopInProgress) return { success: false, message: 'Playback is stopping' };
    const updated = await this.withQueueMutation(async () => {
      if (this.stopInProgress || this.stopRevision !== expectedStopRevision) return false;
      const queue = await this.queueManager.getQueue(guildId);
      if (!queue) return false;
      queue.loopMode = mode;
      await this.queueManager.saveQueue(queue);
      return true;
    });
    if (!updated) return { success: false, message: 'No active queue' };

    this.auditControlApplied(context, 'loop', mode);
    const labels = { off: '▶️ Loop off', track: '🔂 Looping track', queue: '🔁 Looping queue' };
    return { success: true, message: labels[mode] };
  }

  /** Cycle through loop modes: off → queue → track → off. */
  async cycleLoopMode(guildId: string, context: ControlActor = {}): Promise<{ success: boolean; mode: LoopMode; message: string }> {
    const expectedStopRevision = this.stopRevision;
    if (this.stopInProgress) {
      return { success: false, mode: 'off', message: 'Playback is stopping' };
    }
    const queue = await this.queueManager.getQueue(guildId);
    if (!queue) return { success: false, mode: 'off', message: 'No active queue' };
    if (this.stopInProgress || this.stopRevision !== expectedStopRevision) {
      return { success: false, mode: queue.loopMode, message: 'Playback is stopping' };
    }

    const cycle: LoopMode[] = ['off', 'queue', 'track'];
    const currentIdx = cycle.indexOf(queue.loopMode);
    const nextMode = cycle[(currentIdx + 1) % cycle.length]!;

    // setLoopMode writes the single 'loop' row for this one member action.
    const result = await this.setLoopMode(guildId, nextMode, context);
    return { ...result, mode: nextMode };
  }

  /** Shuffle the queue. */
  async shuffle(guildId: string, context: ControlActor = {}): Promise<{ success: boolean; message: string }> {
    const expectedStopRevision = this.stopRevision;
    if (this.stopInProgress) return { success: false, message: 'Playback is stopping' };
    const success = await this.withQueueMutation(async () => {
      if (this.stopInProgress || this.stopRevision !== expectedStopRevision) return false;
      return this.queueManager.shuffle(guildId);
    });
    if (!success) return { success: false, message: 'No active queue to shuffle' };
    this.auditControlApplied(context, 'shuffle');
    return { success: true, message: '🔀 Queue shuffled' };
  }

  /** Remove a track from the queue by position (1-indexed, relative to upcoming). */
  async remove(guildId: string, position: number, context: ControlActor = {}): Promise<{ success: boolean; message: string }> {
    const expectedStopRevision = this.stopRevision;
    if (this.stopInProgress) return { success: false, message: 'Playback is stopping' };
    return this.withQueueMutation(async () => {
      if (this.stopInProgress || this.stopRevision !== expectedStopRevision) {
        return { success: false, message: 'Playback is stopping' };
      }
      const queue = await this.queueManager.getQueue(guildId);
      if (!queue) return { success: false, message: 'No active queue' };

      const index = queue.currentIndex + position;
      if (index <= queue.currentIndex || index >= queue.entries.length) {
        return { success: false, message: 'Invalid position' };
      }

      const removed = await this.queueManager.removeEntry(guildId, index);
      if (!removed) return { success: false, message: 'Failed to remove track' };

      this.auditControlApplied(context, 'remove', removed.title);
      return { success: true, message: `🗑️ Removed **${removed.title}** from the queue` };
    });
  }

  /**
   * Move an upcoming track to a new position (both 1-indexed, relative to the
   * upcoming queue). A DJ may always reorder. Otherwise the requester of that
   * track may move it only when requester-move is enabled — the fairness control
   * that lets the person who queued a song reposition it without DJ perms.
   */
  async move(
    guildId: string,
    userId: string,
    fromPosition: number,
    toPosition: number,
  ): Promise<{ success: boolean; message: string }> {
    const expectedStopRevision = this.stopRevision;
    if (this.stopInProgress) return { success: false, message: 'Playback is stopping' };
    const userIsDJ = await this.isDJ(userId);
    return this.withQueueMutation(async () => {
      if (this.stopInProgress || this.stopRevision !== expectedStopRevision) {
        return { success: false, message: 'Playback is stopping' };
      }
      const queue = await this.queueManager.getQueue(guildId);
      if (!queue) return { success: false, message: 'No active queue' };

      const fromIndex = queue.currentIndex + fromPosition;
      const toIndex = queue.currentIndex + toPosition;
      if (fromIndex <= queue.currentIndex || fromIndex >= queue.entries.length) {
        return { success: false, message: 'Invalid source position' };
      }
      if (toIndex <= queue.currentIndex || toIndex >= queue.entries.length) {
        return { success: false, message: 'Invalid target position' };
      }

      const entry = queue.entries[fromIndex];
      if (!entry) return { success: false, message: 'Invalid source position' };

      if (!userIsDJ) {
        if (!this.config.requesterMoveEnabled) {
          this.auditPermissionDenied(userId, 'move');
          return { success: false, message: 'Only a DJ can move tracks here.' };
        }
        if (entry.requestedBy !== userId) {
          this.auditPermissionDenied(userId, 'move');
          return { success: false, message: 'You can only move tracks you requested.' };
        }
      }

      const moved = await this.queueManager.moveEntry(guildId, fromIndex, toIndex);
      if (!moved) return { success: false, message: 'Failed to move track' };
      this.auditControlApplied({ userId }, 'move', `${fromPosition}→${toPosition}`);
      return { success: true, message: `↔️ Moved **${entry.title}** to position ${toPosition}` };
    });
  }

  /** Get the current player position in ms. */
  getPlayerPosition(guildId: string): number {
    const player = this.shoukaku.players.get(guildId);
    return player?.position ?? 0;
  }

  // ── Filters ─────────────────────────────────────────────

  /** Apply a filter preset. */
  async applyFilter(guildId: string, preset: FilterPreset, context: ControlActor = {}): Promise<{ success: boolean; message: string }> {
    const player = this.shoukaku.players.get(guildId);
    if (!player) return { success: false, message: 'Nothing is playing' };

    await applyFilterPreset(player, preset);
    this.auditControlApplied(context, 'filter', preset);

    if (preset === 'reset') {
      return { success: true, message: '🔄 All filters cleared' };
    }

    const { FILTER_PRESETS } = await import('./music-filters.js');
    const info = FILTER_PRESETS[preset];
    return { success: true, message: `${info.emoji} Applied **${info.name}** filter` };
  }

  /** Apply custom speed/pitch/rate. */
  async applyCustomSpeed(guildId: string, speed?: number, pitch?: number, rate?: number, context: ControlActor = {}): Promise<{ success: boolean; message: string }> {
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

    // Same 'filter' vocabulary as the denial (/filter gates both branches).
    this.auditControlApplied(context, 'filter', parts.join(', '));
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
  async sendNowPlaying(
    guildId: string,
    scheduledEntry?: QueueEntry,
    expectedSessionRevision?: number,
    expectedPlaybackRevision?: number,
  ): Promise<void> {
    const previousUpdate = this.nowPlayingMutationTail;
    let releaseUpdate: (() => void) | undefined;
    this.nowPlayingMutationTail = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    await previousUpdate;
    const sessionIsCurrent = (): boolean => (
      (expectedSessionRevision === undefined || expectedSessionRevision === this.playbackSessionRevision) &&
      (expectedPlaybackRevision === undefined || expectedPlaybackRevision === this.latestStartedPlaybackRevision)
    );
    try {
      const queue = await this.queueManager.getQueue(guildId);
      if (!queue || !sessionIsCurrent()) return;

      const current = scheduledEntry ?? queue.entries[queue.currentIndex];
      if (!current) return;

      const textChannel = this.guild.channels.cache.get(queue.textChannelId);
      if (!textChannel || textChannel.type !== ChannelType.GuildText) return;

      const position = this.getPlayerPosition(guildId);
      const activeFilters = this.getActiveFilters(guildId);
      const { embeds, components } = buildNowPlayingEmbed(current, position, queue, activeFilters);

      // Try to edit existing now-playing message
      const existingMsgId = await this.queueManager.getNowPlayingMessage(guildId);
      if (!sessionIsCurrent()) return;
      if (existingMsgId) {
        try {
          const msg = await textChannel.messages.fetch(existingMsgId);
          if (!sessionIsCurrent()) return;
          await msg.edit({ embeds, components });
          if (!sessionIsCurrent()) {
            await msg.delete().catch(() => undefined);
          }
          return;
        } catch {
          if (!sessionIsCurrent()) return;
          // Message deleted, send new one
        }
      }

      // Send new now-playing message
      if (!sessionIsCurrent()) return;
      const msg = await textChannel.send({ embeds, components });
      if (!sessionIsCurrent()) {
        await msg.delete().catch(() => undefined);
        return;
      }
      await this.queueManager.setNowPlayingMessage(guildId, msg.id);
      if (!sessionIsCurrent()) {
        await this.queueManager.clearNowPlayingMessage(guildId).catch(() => undefined);
        await msg.delete().catch(() => undefined);
      }
    } finally {
      releaseUpdate?.();
    }
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
      if (player) {
        const transition = await this.withQueueMutation(async () => {
          const latestQueue = await this.queueManager.getQueue(this.guild.id);
          if (this.stopInProgress || !latestQueue || latestQueue.voiceChannelId !== channelId || latestQueue.paused) return null;
          const previousPaused = latestQueue.paused;
          if (this.appliedPaused === null) this.appliedPaused = previousPaused;
          latestQueue.paused = true;
          await this.queueManager.saveQueue(latestQueue);
          const revision = ++this.pauseRevision;
          const state = { finalPaused: true };
          const playback = this.enqueuePlaybackAfterQueueMutation(async () => {
            state.finalPaused = await this.reconcilePlayerPauseState(player, true, revision);
          });
          return { previousPaused, newPaused: true, revision, state, playback };
        });
        if (transition !== null) {
          try {
            await transition.playback;
          } catch (error) {
            await this.rollbackPauseTransition(this.guild.id, transition);
            throw error;
          }
        }
      }
      this.startAutoLeaveTimer(this.guild.id);
    } else {
      // Someone joined — cancel leave timer and resume if we auto-paused
      this.clearAutoLeaveTimer(this.guild.id);

      const player = this.shoukaku.players.get(this.guild.id);
      if (player) {
        const transition = await this.withQueueMutation(async () => {
          const latestQueue = await this.queueManager.getQueue(this.guild.id);
          if (this.stopInProgress || !latestQueue || latestQueue.voiceChannelId !== channelId || !latestQueue.paused) return null;
          const previousPaused = latestQueue.paused;
          if (this.appliedPaused === null) this.appliedPaused = previousPaused;
          latestQueue.paused = false;
          await this.queueManager.saveQueue(latestQueue);
          const revision = ++this.pauseRevision;
          const state = { finalPaused: false };
          const playback = this.enqueuePlaybackAfterQueueMutation(async () => {
            state.finalPaused = await this.reconcilePlayerPauseState(player, false, revision);
          });
          return { previousPaused, newPaused: false, revision, state, playback };
        });
        if (transition !== null) {
          try {
            await transition.playback;
          } catch (error) {
            await this.rollbackPauseTransition(this.guild.id, transition);
            throw error;
          }
        }
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
        if (!hasPerm) { this.auditPermissionDenied(userId, 'pause'); return { message: '❌ You need the DJ role to do that' }; }
        const result = await this.togglePause(guildId, { userId });
        return { message: result.message };
      }
      case 'music:skip': {
        const isDj = await this.isDJ(userId);
        if (isDj) {
          const result = await this.skip(guildId, { userId, method: 'dj_force' });
          return { message: result.message };
        }
        const result = await this.voteSkip(guildId, userId);
        return { message: result.message };
      }
      case 'music:stop': {
        const hasPerm = await this.isDJ(userId);
        if (!hasPerm) { this.auditPermissionDenied(userId, 'stop'); return { message: '❌ You need the DJ role to stop playback' }; }
        const result = await this.stop(guildId, { userId, reason: 'command' });
        return { message: result.message };
      }
      case 'music:shuffle': {
        const hasPerm = await this.isDJ(userId);
        if (!hasPerm) { this.auditPermissionDenied(userId, 'shuffle'); return { message: '❌ You need the DJ role to shuffle' }; }
        const result = await this.shuffle(guildId, { userId });
        return { message: result.message };
      }
      case 'music:loop': {
        const hasPerm = await this.isDJ(userId);
        if (!hasPerm) { this.auditPermissionDenied(userId, 'loop'); return { message: '❌ You need the DJ role to change loop mode' }; }
        const result = await this.cycleLoopMode(guildId, { userId });
        return { message: result.message };
      }
      // V53 Phase 3 (3.6): Volume buttons
      case 'music:vol_down': {
        const hasPerm = await this.isDJ(userId);
        if (!hasPerm) { this.auditPermissionDenied(userId, 'volume'); return { message: '❌ You need the DJ role to change volume' }; }
        const result = await this.setVolume(guildId, Math.max(0, (await this.queueManager.getQueue(guildId))?.volume ?? 50) - 10, { userId });
        return { message: result.message };
      }
      case 'music:vol_up': {
        const hasPerm = await this.isDJ(userId);
        if (!hasPerm) { this.auditPermissionDenied(userId, 'volume'); return { message: '❌ You need the DJ role to change volume' }; }
        const result = await this.setVolume(guildId, Math.min(100, ((await this.queueManager.getQueue(guildId))?.volume ?? 50) + 10), { userId });
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
    player.on('start', (data?: TrackStartEvent) => {
      if (this.disposed) return;
      const encodedTrack = data?.track.encoded;
      const playbackIdentity = this.getPlaybackIdentity(data?.track);
      const pendingIndex = playbackIdentity
        ? this.pendingTrackStarts.findIndex(
          (pending) => pending.playbackRevision === playbackIdentity.playbackRevision,
        )
        : encodedTrack
          ? this.pendingTrackStarts.findIndex((pending) => pending.encodedTrack === encodedTrack)
          : 0;
      const scheduledStart = pendingIndex >= 0
        ? this.pendingTrackStarts.splice(pendingIndex, 1)[0]
        : undefined;
      if (playbackIdentity && !scheduledStart) return;
      if (
        scheduledStart &&
        scheduledStart.playbackRevision < this.latestStartedPlaybackRevision
      ) return;
      if (scheduledStart) {
        this.latestStartedPlaybackRevision = scheduledStart.playbackRevision;
      }
      const expectedSessionRevision = scheduledStart?.sessionRevision ?? this.playbackSessionRevision;
      if (expectedSessionRevision !== this.playbackSessionRevision) return;
      if (scheduledStart) this.clearInactivityTimer(this.guild.id);

      // Emit track.started event
      this.queueManager.getQueue(this.guild.id).then((queue) => {
        if (
          this.disposed ||
          expectedSessionRevision !== this.playbackSessionRevision ||
          !queue
        ) return;
        const queueEntry = queue.currentIndex < queue.entries.length
          ? queue.entries[queue.currentIndex]
          : null;
        if (!scheduledStart && encodedTrack && queueEntry?.track !== encodedTrack) return;
        this.queueExhausted = false;
        if (scheduledStart?.playbackRevision === this.trackPlaybackRevision) {
          this.playbackRestartRequired = false;
        }
        const scheduledEntry = scheduledStart?.entry;
        this.sendNowPlaying(
          this.guild.id,
          scheduledEntry,
          expectedSessionRevision,
          scheduledStart?.playbackRevision,
        ).catch((err) => {
          log.error('Failed to send now-playing:', { error: String(err) });
        });
        if (!scheduledStart) this.clearInactivityTimer(this.guild.id);
        if (queue?.paused) {
          this.resetInactivityTimer(this.guild.id);
        }
        const np = scheduledEntry ?? queueEntry;
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
      const playbackIdentity = this.getPlaybackIdentity(data.track);
      const expectedSessionRevision = playbackIdentity?.sessionRevision ?? this.playbackSessionRevision;
      const expectedPlaybackRevision = playbackIdentity?.playbackRevision;
      const transition = await this.withQueueMutation(async (): Promise<{
        queueEnded: boolean;
        textChannelId: string | null;
        sessionRevision: number | null;
        playback: Promise<void> | null;
      }> => {
        if (
          this.disposed ||
          this.stopInProgress ||
          this.queueExhausted ||
          expectedSessionRevision !== this.playbackSessionRevision ||
          (expectedPlaybackRevision !== undefined &&
            expectedPlaybackRevision !== this.trackPlaybackRevision)
        ) {
          return { queueEnded: false, textChannelId: null, sessionRevision: null, playback: null };
        }
        if (data.reason === 'replaced') {
          return { queueEnded: false, textChannelId: null, sessionRevision: null, playback: null };
        }

        // Emit track.ended event for the track that just finished
        const currentQueue = await this.queueManager.getQueue(this.guild.id);
        if (this.disposed) return { queueEnded: false, textChannelId: null, sessionRevision: null, playback: null };
        const np = currentQueue && currentQueue.currentIndex < currentQueue.entries.length
          ? currentQueue.entries[currentQueue.currentIndex]
          : null;
        if (!playbackIdentity && data.track?.encoded && np?.track !== data.track.encoded) {
          return { queueEnded: false, textChannelId: null, sessionRevision: null, playback: null };
        }
        if (np) {
          this.eventBus.emit('track.ended', this.guild.id, {
            title: np.title ?? 'Unknown',
            author: np.author ?? 'Unknown',
            uri: np.uri ?? '',
            reason: data.reason === 'finished' ? 'finished' : 'skipped',
          });
        }

        let track: QueueEntry | null;
        let queueEnded: boolean;
        try {
          ({ track, queueEnded } = await this.queueManager.nextTrack(this.guild.id));
        } catch (error) {
          this.playbackRestartRequired = true;
          throw error;
        }
        if (this.disposed) return { queueEnded: false, textChannelId: null, sessionRevision: null, playback: null };

        if (queueEnded || !track) {
          const queueEnd = await this.completeQueueEndTransition();
          return { queueEnded: true, ...queueEnd, playback: null };
        }

        try {
          await this.queueManager.clearVoteSkip(this.guild.id);
        } catch (error) {
          log.warn('Failed to clear skip votes while advancing the music queue:', (error as Error)?.message ?? error);
        }
        const playback = this.enqueueTrackPlaybackAfterQueueMutation(player, track);
        return { queueEnded: false, textChannelId: null, sessionRevision: null, playback };
      });

      if (transition.playback) await transition.playback;
      if (transition.queueEnded && transition.sessionRevision !== null) {
        await this.sendQueueEndedNotice(transition.textChannelId, transition.sessionRevision);
      }
    });

    player.on('exception', async (data: TrackExceptionEvent) => {
      if (this.disposed) return;
      const expectedStopRevision = this.stopRevision;
      const exceptionTrack = (data as TrackExceptionEvent & { track?: PlaybackEventTrack }).track;
      const playbackIdentity = this.getPlaybackIdentity(exceptionTrack);
      const expectedSessionRevision = playbackIdentity?.sessionRevision ?? this.playbackSessionRevision;
      const expectedPlaybackRevision = playbackIdentity?.playbackRevision;
      if (
        expectedPlaybackRevision !== undefined &&
        expectedPlaybackRevision !== this.trackPlaybackRevision
      ) return;
      const failedTrack = exceptionTrack?.encoded ?? player.track;
      this.discardPendingTrackStart(failedTrack, expectedPlaybackRevision);
      log.error('Track exception:', data);
      const { shouldRecover, strategy } = this.selfHealer.recordFailure();

      if (shouldRecover && strategy === 'switch_search_provider') {
        this.selfHealer.switchSearchProvider();
      }

      // Skip to next track
      const queue = await this.queueManager.getQueue(this.guild.id);
      if (this.disposed) return;
      if (queue) {
        const textChannel = this.guild.channels.cache.get(queue.textChannelId);
        if (textChannel && textChannel.type === ChannelType.GuildText) {
          await textChannel.send({
            embeds: [buildMusicErrorEmbed('Failed to play track — skipping to next')],
          }).catch((e: unknown) => { log.warn('Operation failed:', (e as Error)?.message ?? e); });
        }
      }

      const transition = await this.withQueueMutation(async () => {
        if (
          this.stopInProgress ||
          this.stopRevision !== expectedStopRevision ||
          this.queueExhausted ||
          expectedSessionRevision !== this.playbackSessionRevision ||
          (expectedPlaybackRevision !== undefined &&
            expectedPlaybackRevision !== this.trackPlaybackRevision)
        ) return null;
        const activeQueue = await this.queueManager.getQueue(this.guild.id);
        if (!activeQueue) return null;
        const { track } = await this.queueManager.nextTrack(this.guild.id);
        if (!track) {
          const queueEnd = await this.completeQueueEndTransition();
          return {
            queueEnded: true,
            ...queueEnd,
            playback: null,
          };
        }
        return {
          queueEnded: false,
          textChannelId: null,
          sessionRevision: null,
          playback: this.enqueueTrackPlaybackAfterQueueMutation(player, track),
        };
      });
      if (this.disposed) return;
      if (transition?.playback) await transition.playback;
      if (transition?.queueEnded && transition.sessionRevision !== null) {
        await this.sendQueueEndedNotice(transition.textChannelId, transition.sessionRevision);
      }
    });

    player.on('stuck', async (data?: TrackStuckEvent) => {
      if (this.disposed) return;
      const expectedStopRevision = this.stopRevision;
      const playbackIdentity = this.getPlaybackIdentity(data?.track);
      const expectedSessionRevision = playbackIdentity?.sessionRevision ?? this.playbackSessionRevision;
      const expectedPlaybackRevision = playbackIdentity?.playbackRevision;
      if (
        expectedPlaybackRevision !== undefined &&
        expectedPlaybackRevision !== this.trackPlaybackRevision
      ) return;
      this.discardPendingTrackStart(data?.track.encoded ?? player.track, expectedPlaybackRevision);
      log.warn('Track stuck, skipping...');
      const transition = await this.withQueueMutation(async () => {
        if (
          this.stopInProgress ||
          this.stopRevision !== expectedStopRevision ||
          this.queueExhausted ||
          expectedSessionRevision !== this.playbackSessionRevision ||
          (expectedPlaybackRevision !== undefined &&
            expectedPlaybackRevision !== this.trackPlaybackRevision)
        ) return null;
        const activeQueue = await this.queueManager.getQueue(this.guild.id);
        if (!activeQueue) return null;
        const { track } = await this.queueManager.nextTrack(this.guild.id);
        if (!track) {
          const queueEnd = await this.completeQueueEndTransition();
          return {
            queueEnded: true,
            ...queueEnd,
            playback: null,
          };
        }
        return {
          queueEnded: false,
          textChannelId: null,
          sessionRevision: null,
          playback: this.enqueueTrackPlaybackAfterQueueMutation(player, track),
        };
      });
      if (this.disposed) return;
      if (transition?.playback) await transition.playback;
      if (transition?.queueEnded && transition.sessionRevision !== null) {
        await this.sendQueueEndedNotice(transition.textChannelId, transition.sessionRevision);
      }
    });

    player.on('closed', async (event: WebSocketClosedEvent) => {
      if (this.disposed) return;
      try {
        await this.recoverVoiceConnection(player, event);
      } catch (error) {
        log.error('Unexpected player reconnect failure:', error);
      }
    });
  }

  private async recoverVoiceConnection(player: Player, event: WebSocketClosedEvent): Promise<void> {
    const guildId = this.guild.id;
    const activePlayer = this.shoukaku.players.get(guildId);
    if (this.intentionalVoiceLeaveDepth > 0 || this.reconnectingVoice || (activePlayer && activePlayer !== player)) {
      return;
    }

    this.reconnectingVoice = true;
    const recoveryRevision = ++this.voiceOperationRevision;
    this.playbackSessionRevision += 1;
    this.playbackMutationRevision += 1;
    this.pendingTrackStarts = [];
    this.trackPlaybackRevision += 1;
    const recoveryIsCurrent = (): boolean => recoveryRevision === this.voiceOperationRevision;

    try {
      log.info(`Player voice websocket closed (${event.code}, remote=${event.byRemote}): ${event.reason || 'no reason'} — attempting reconnect`);
      const queue = await this.queueManager.getQueue(guildId);
      if (!recoveryIsCurrent()) return;

      const resumePosition = Math.max(0, player.position ?? 0);
      await this.clearVoiceConnectionForRecovery(guildId, 'Stale player cleanup');
      if (!recoveryIsCurrent()) return;

      if (!queue || !queue.voiceChannelId) {
        await this.queueManager.destroyQueue(guildId);
        this.clearTimers(guildId);
        return;
      }

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
          if (!recoveryIsCurrent()) return;

          const newPlayer = await this.shoukaku.joinVoiceChannel({
            guildId,
            channelId: queue.voiceChannelId,
            shardId: this.guild.shardId,
            deaf: true,
          });
          const recoveryWasCancelled = async (): Promise<boolean> => {
            if (recoveryIsCurrent()) return false;
            await this.clearVoiceConnectionForRecovery(guildId, 'Cancelled recovery cleanup');
            return true;
          };
          if (await recoveryWasCancelled()) return;

          this.setupPlayerEvents(newPlayer);
          const currentTrack = queue.currentIndex < queue.entries.length
            ? queue.entries[queue.currentIndex]
            : null;
          const resumeTrack = async (encoded: string): Promise<boolean> => {
            if (await recoveryWasCancelled()) return false;
            if (!currentTrack) return false;
            const playbackRevision = ++this.trackPlaybackRevision;
            const scheduledStart: PendingTrackStart = {
              entry: currentTrack,
              encodedTrack: encoded,
              playbackRevision,
              sessionRevision: this.playbackSessionRevision,
            };
            this.pendingTrackStarts.push(scheduledStart);
            try {
              await newPlayer.playTrack({
                track: {
                  encoded,
                  userData: {
                    somnibotPlayback: {
                      playbackRevision,
                      sessionRevision: scheduledStart.sessionRevision,
                    },
                  },
                },
                position: currentTrack.isStream ? 0 : resumePosition,
                volume: queue.volume,
                paused: queue.paused,
              });
            } catch (error) {
              const pendingIndex = this.pendingTrackStarts.indexOf(scheduledStart);
              if (pendingIndex >= 0) this.pendingTrackStarts.splice(pendingIndex, 1);
              throw error;
            }
            if (this.trackPlaybackRevision === playbackRevision) {
              this.playbackRestartRequired = false;
            }
            this.appliedPaused = queue.paused;
            this.appliedVolume = queue.volume;
            return !(await recoveryWasCancelled());
          };

          if (currentTrack?.uri) {
            try {
              const resolved = await newPlayer.node.rest.resolve(currentTrack.uri);
              if (await recoveryWasCancelled()) return;
              if (resolved?.data && !Array.isArray(resolved.data) && 'encoded' in resolved.data) {
                if (!(await resumeTrack(resolved.data.encoded))) return;
              } else if (resolved?.data && Array.isArray(resolved.data) && resolved.data.length > 0) {
                if (!(await resumeTrack(resolved.data[0].encoded))) return;
              } else if (currentTrack.track) {
                if (!(await resumeTrack(currentTrack.track))) return;
              }
            } catch {
              if (currentTrack.track) {
                if (!(await resumeTrack(currentTrack.track))) return;
              }
            }
          } else if (currentTrack?.track) {
            if (!(await resumeTrack(currentTrack.track))) return;
          }
          if (queue.paused) this.resetInactivityTimer(guildId);
          log.info(`Reconnected after ${attempt} attempt(s)`);
          return;
        } catch (error) {
          log.warn(`Reconnect attempt ${attempt}/3 failed:`, error);
          await this.clearVoiceConnectionForRecovery(guildId, `Reconnect cleanup after attempt ${attempt}/3`);
        }
      }

      log.error('Failed to reconnect after 3 attempts — destroying queue');
      this.eventBus.emit('music.stopped', guildId, {
        userId: undefined,
        reason: 'connection_lost',
        trackCount: queue.entries.length,
      });
      await this.queueManager.destroyQueue(guildId);
      this.clearTimers(guildId);
    } finally {
      this.reconnectingVoice = false;
    }
  }

  private async tryLeaveVoiceChannel(guildId: string, phase: string): Promise<boolean> {
    try {
      await this.shoukaku.leaveVoiceChannel(guildId);
      return true;
    } catch (error) {
      log.warn(`${phase} failed:`, error);
      return false;
    }
  }

  private async withQueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queueMutationTail;
    let release: (() => void) | undefined;
    this.queueMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async waitForPlaybackMutations(): Promise<void> {
    let pendingPlayback = this.playbackMutationTail;
    while (true) {
      await pendingPlayback;
      if (pendingPlayback === this.playbackMutationTail) return;
      pendingPlayback = this.playbackMutationTail;
    }
  }

  private enqueuePlaybackMutation(operation: () => Promise<void>): Promise<void> {
    const operationRevision = this.playbackMutationRevision;
    const playback = this.playbackMutationTail.then(async () => {
      if (this.disposed || operationRevision !== this.playbackMutationRevision) return;
      await operation();
    });
    this.playbackMutationTail = playback.catch(() => undefined);
    return playback;
  }

  private enqueuePlaybackAfterQueueMutation(operation: () => Promise<void>): Promise<void> {
    const queueRelease = this.queueMutationTail;
    return this.enqueuePlaybackMutation(async () => {
      await queueRelease;
      await operation();
    });
  }

  private enqueueTrackPlaybackAfterQueueMutation(
    player: Player,
    entry: QueueEntry,
    afterStart?: () => Promise<void>,
  ): Promise<void> {
    const playbackRevision = ++this.trackPlaybackRevision;
    const scheduledStart: PendingTrackStart = {
      entry,
      encodedTrack: entry.track,
      playbackRevision,
      sessionRevision: this.playbackSessionRevision,
    };
    this.playbackRestartRequired = false;
    return this.enqueuePlaybackAfterQueueMutation(async () => {
      this.pendingTrackStarts.push(scheduledStart);
      try {
        await player.playTrack({
          track: {
            encoded: entry.track,
            userData: {
              somnibotPlayback: {
                playbackRevision,
                sessionRevision: scheduledStart.sessionRevision,
              },
            },
          },
        });
        this.appliedPaused = false;
      } catch (error) {
        const pendingIndex = this.pendingTrackStarts.indexOf(scheduledStart);
        if (pendingIndex >= 0) this.pendingTrackStarts.splice(pendingIndex, 1);
        if (this.trackPlaybackRevision === playbackRevision) {
          this.playbackRestartRequired = true;
        }
        throw error;
      }
      if (this.trackPlaybackRevision === playbackRevision) {
        this.playbackRestartRequired = false;
      }
      if (afterStart) await afterStart();
    });
  }

  private discardPendingTrackStart(
    encodedTrack: string | null | undefined,
    playbackRevision?: number,
  ): void {
    let pendingIndex = playbackRevision === undefined
      ? encodedTrack
        ? this.pendingTrackStarts.findIndex((pending) => pending.encodedTrack === encodedTrack)
        : 0
      : this.pendingTrackStarts.findIndex((pending) => pending.playbackRevision === playbackRevision);
    if (
      playbackRevision === undefined &&
      pendingIndex < 0 &&
      this.pendingTrackStarts.length === 1
    ) pendingIndex = 0;
    if (pendingIndex >= 0) this.pendingTrackStarts.splice(pendingIndex, 1);
  }

  private getPlaybackIdentity(track: Track | undefined): PlaybackIdentity | null {
    const identity = (track as PlaybackEventTrack | undefined)?.userData?.somnibotPlayback;
    if (
      typeof identity?.playbackRevision !== 'number' ||
      typeof identity.sessionRevision !== 'number'
    ) return null;
    return {
      playbackRevision: identity.playbackRevision,
      sessionRevision: identity.sessionRevision,
    };
  }

  private async completeQueueEndTransition(): Promise<QueueEndState> {
    if (this.queueExhausted) {
      return { textChannelId: null, sessionRevision: this.playbackSessionRevision };
    }
    this.queueExhausted = true;
    this.playbackRestartRequired = false;
    this.pendingTrackStarts = [];
    this.trackPlaybackRevision += 1;
    this.playbackSessionRevision += 1;
    this.pauseRevision += 1;
    this.appliedPaused = false;
    const queue = await this.queueManager.getQueue(this.guild.id);
    if (queue) {
      queue.entries = [];
      queue.currentIndex = 0;
      queue.paused = false;
      queue.shuffled = false;
      let lastPersistenceError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.queueManager.saveQueue(queue);
          lastPersistenceError = undefined;
          break;
        } catch (error) {
          lastPersistenceError = error;
          log.warn(
            `Failed to persist the exhausted music queue (${attempt}/3):`,
            (error as Error)?.message ?? error,
          );
        }
      }
      if (lastPersistenceError !== undefined) throw lastPersistenceError;
    }
    const totalPlayed = await this.getMusicStat('tracks_played_session');
    this.eventBus.emit('queue.ended', this.guild.id, {
      totalTracksPlayed: totalPlayed,
    });
    await this.resetSessionStats();
    await this.queueManager.clearNowPlayingMessage(this.guild.id)
      .catch((error: unknown) => {
        log.warn('Failed to clear the previous now-playing message:', (error as Error)?.message ?? error);
      });
    await this.queueManager.clearVoteSkip(this.guild.id)
      .catch((error: unknown) => {
        log.warn('Failed to clear skip votes for the exhausted queue:', (error as Error)?.message ?? error);
      });
    this.resetInactivityTimer(this.guild.id);
    return {
      textChannelId: queue?.textChannelId ?? null,
      sessionRevision: this.playbackSessionRevision,
    };
  }

  private async sendQueueEndedNotice(
    textChannelId: string | null,
    expectedSessionRevision: number,
  ): Promise<void> {
    if (!textChannelId || expectedSessionRevision !== this.playbackSessionRevision) return;
    const textChannel = this.guild.channels.cache.get(textChannelId);
    if (!textChannel || textChannel.type !== ChannelType.GuildText) return;
    const notice = await textChannel.send({
      embeds: [buildMusicInfoEmbed('📭 Queue ended — add more tracks with `/play`')],
    }).catch((error: unknown) => {
      log.warn('Failed to send the queue-ended notice:', (error as Error)?.message ?? error);
    });
    if (notice && expectedSessionRevision !== this.playbackSessionRevision) {
      await notice.delete().catch((error: unknown) => {
        log.warn('Failed to remove a stale queue-ended notice:', (error as Error)?.message ?? error);
      });
    }
  }

  private async reconcilePlayerPauseState(
    player: Player,
    requestedPaused: boolean,
    requestedRevision: number,
  ): Promise<boolean> {
    let paused = requestedPaused;
    let revision = requestedRevision;

    while (true) {
      await player.setPaused(paused);
      this.appliedPaused = paused;
      const latest = await this.withQueueMutation(async () => {
        const queue = await this.queueManager.getQueue(this.guild.id);
        return { paused: queue?.paused ?? false, revision: this.pauseRevision };
      });
      if (latest.paused === paused && latest.revision === revision) return paused;
      paused = latest.paused;
      revision = latest.revision;
    }
  }

  private async rollbackPauseTransition(guildId: string, transition: PauseTransition): Promise<void> {
    const rollbackPaused = this.appliedPaused ?? transition.previousPaused;
    await this.withQueueMutation(async () => {
      const queue = await this.queueManager.getQueue(guildId);
      if (
        !queue ||
        queue.paused !== transition.newPaused ||
        this.pauseRevision !== transition.revision
      ) return;
      queue.paused = rollbackPaused;
      await this.queueManager.saveQueue(queue);
      this.pauseRevision += 1;
    });
  }

  private async completePlayRequest(requestRevision: number, shouldCleanUp: boolean): Promise<void> {
    const shouldLeaveVoice = await this.withQueueMutation(async () => {
      this.pendingPlayRequests.delete(requestRevision);
      if (
        !shouldCleanUp ||
        this.stopInProgress ||
        !this.uncommittedVoiceSession ||
        this.pendingPlayRequests.size > 0
      ) return false;

      let queue: GuildQueue | null = null;
      try {
        queue = await this.queueManager.getQueue(this.guild.id);
      } catch (error) {
        log.warn('Failed to inspect the unused queue after an unsuccessful play request:', (error as Error)?.message ?? error);
      }
      if (queue && queue.entries.length > 0) {
        this.playbackRestartRequired = true;
        this.uncommittedVoiceSession = false;
        this.uncommittedVoiceChannelId = null;
        return false;
      }

      if (queue) {
        try {
          await this.queueManager.destroyQueue(this.guild.id);
        } catch (error) {
          log.warn('Failed to remove an unused queue after an unsuccessful play request:', (error as Error)?.message ?? error);
        }
      }

      this.uncommittedVoiceSession = false;
      this.uncommittedVoiceChannelId = null;
      this.uncommittedVoiceCleanupInProgress = true;
      this.voiceOperationRevision += 1;
      this.intentionalVoiceLeaveDepth += 1;
      return true;
    });
    if (!shouldLeaveVoice) return;

    try {
      await this.shoukaku.leaveVoiceChannel(this.guild.id);
    } catch (error) {
      log.warn('Failed to leave voice after an unsuccessful play request:', (error as Error)?.message ?? error);
    } finally {
      this.intentionalVoiceLeaveDepth -= 1;
      this.uncommittedVoiceCleanupInProgress = false;
    }
  }

  private async clearVoiceConnectionForRecovery(guildId: string, phase: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await this.tryLeaveVoiceChannel(guildId, `${phase} (${attempt}/3)`)) return;
    }

    log.error(`${phase} failed after 3 attempts — force-clearing local voice state`);
    const connection = this.shoukaku.connections.get(guildId);
    try {
      connection?.disconnect();
    } catch (error) {
      log.warn(`${phase} forced connection disconnect failed:`, error);
    } finally {
      this.shoukaku.connections.delete(guildId);
    }

    const stalePlayer = this.shoukaku.players.get(guildId);
    try {
      stalePlayer?.clean();
    } catch (error) {
      log.warn(`${phase} forced player cleanup failed:`, error);
    } finally {
      this.shoukaku.players.delete(guildId);
    }
  }

  // ── Auto Leave / Inactivity Timers ──────────────────────

  private startAutoLeaveTimer(guildId: string): void {
    this.clearAutoLeaveTimer(guildId);
    this.autoLeaveTimers.set(
      guildId,
      setTimeout(async () => {
        try {
          log.info(`Auto-leaving voice in guild ${guildId} (empty channel timeout)`);
          await this.stop(guildId, { reason: 'auto_leave' });
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
          await this.stop(guildId, { reason: 'inactivity' });
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

/**
 * Audit rows are retained far longer than a playback request. Direct stream
 * URLs can contain basic-auth userinfo, signed query tokens, or fragments, so
 * retain only non-secret routing identity in the append-only ledger.
 */
function sanitizeAuditMediaUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}
