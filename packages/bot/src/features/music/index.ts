/**
 * Music System — barrel export.
 *
 * Phase 11: Lavalink-powered music with Shoukaku, Valkey-backed queue,
 * slash commands, rich embeds, DJ permissions, self-healing, and audio filters.
 */
export { MusicPlayerManager } from './music-player.js';
export { MusicQueueManager, type QueueEntry, type GuildQueue, type LoopMode } from './music-queue.js';
export { MusicSelfHealer } from './music-self-healer.js';
export { buildMusicCommands, handleMusicCommand } from './commands.js';
export {
  buildNowPlayingEmbed,
  buildQueueEmbed,
  buildAddedEmbed,
  buildPlaylistAddedEmbed,
  buildMusicErrorEmbed,
  buildMusicInfoEmbed,
  buildFilterEmbed,
} from './music-embeds.js';
export {
  applyFilterPreset,
  describeActiveFilters,
  FILTER_PRESETS,
  type FilterPreset,
} from './music-filters.js';
