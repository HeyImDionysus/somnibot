/**
 * Music Embeds — Rich Discord embeds for now-playing and queue display.
 *
 * Uses the SomniBot brand palette (CYAN for music).
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { QueueEntry, GuildQueue, LoopMode } from './music-queue.js';

const MUSIC_COLOR = 0x00D4FF; // SOMNI_PALETTE.CYAN

// ── Progress Bar ──────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function buildProgressBar(positionMs: number, durationMs: number, length = 14): string {
  if (durationMs <= 0) return '🔘' + '▬'.repeat(length - 1);
  const ratio = Math.min(positionMs / durationMs, 1);
  const filled = Math.round(ratio * length);
  const bar =
    '▬'.repeat(Math.max(0, filled)) +
    '🔘' +
    '▬'.repeat(Math.max(0, length - filled - 1));
  return bar;
}

function loopModeLabel(mode: LoopMode): string {
  switch (mode) {
    case 'track':
      return '🔂 Track';
    case 'queue':
      return '🔁 Queue';
    default:
      return '▶️ Off';
  }
}

// ── Now Playing Embed ─────────────────────────────────────

export function buildNowPlayingEmbed(
  entry: QueueEntry,
  positionMs: number,
  queue: GuildQueue,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const progress = buildProgressBar(positionMs, entry.duration);
  const posStr = formatDuration(positionMs);
  const durStr = formatDuration(entry.duration);

  const embed = new EmbedBuilder()
    .setColor(MUSIC_COLOR)
    .setAuthor({ name: '🎵 Now Playing' })
    .setTitle(entry.title)
    .setURL(entry.uri)
    .setDescription(
      `by **${entry.author}**\n\n` +
      `${progress}\n` +
      `\`${posStr}\` / \`${durStr}\``,
    )
    .addFields(
      { name: 'Requested by', value: `<@${entry.requestedBy}>`, inline: true },
      { name: 'Volume', value: `${queue.volume}%`, inline: true },
      { name: 'Loop', value: loopModeLabel(queue.loopMode), inline: true },
    );

  if (entry.artworkUrl) {
    embed.setThumbnail(entry.artworkUrl);
  }

  if (queue.entries.length > 1) {
    const remaining = queue.entries.length - queue.currentIndex - 1;
    embed.setFooter({ text: `Queue: ${remaining} track${remaining === 1 ? '' : 's'} remaining` });
  }

  // Playback control buttons
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('music:pause_resume')
      .setEmoji(queue.paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music:skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music:stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('music:shuffle')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music:loop')
      .setEmoji(queue.loopMode === 'off' ? '🔁' : queue.loopMode === 'queue' ? '🔂' : '▶️')
      .setStyle(queue.loopMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

// ── Queue Embed ───────────────────────────────────────────

const TRACKS_PER_PAGE = 10;

export function buildQueueEmbed(
  queue: GuildQueue,
  page = 1,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const totalTracks = queue.entries.length;

  if (totalTracks === 0) {
    const embed = new EmbedBuilder()
      .setColor(MUSIC_COLOR)
      .setDescription('📭 The queue is empty. Use `/play` to add tracks.');
    return { embeds: [embed], components: [] };
  }

  const totalPages = Math.ceil((totalTracks - 1) / TRACKS_PER_PAGE) || 1;
  const safePage = Math.max(1, Math.min(page, totalPages));

  // Current track
  const current = queue.entries[queue.currentIndex];
  let description = '';

  if (current) {
    description += `**Now Playing:**\n[${current.title}](${current.uri}) — \`${formatDuration(current.duration)}\` — <@${current.requestedBy}>\n\n`;
  }

  // Upcoming tracks for this page
  const upcomingStart = queue.currentIndex + 1;
  const startIdx = upcomingStart + (safePage - 1) * TRACKS_PER_PAGE;
  const endIdx = Math.min(startIdx + TRACKS_PER_PAGE, totalTracks);

  if (startIdx < totalTracks) {
    description += '**Up Next:**\n';
    for (let i = startIdx; i < endIdx; i++) {
      const entry = queue.entries[i];
      if (!entry) continue;
      const position = i - upcomingStart + 1;
      description += `\`${position}.\` [${entry.title}](${entry.uri}) — \`${formatDuration(entry.duration)}\` — <@${entry.requestedBy}>\n`;
    }
  }

  // Total duration
  const totalDuration = queue.entries.reduce((sum, e) => sum + e.duration, 0);

  const embed = new EmbedBuilder()
    .setColor(MUSIC_COLOR)
    .setAuthor({ name: '📜 Music Queue' })
    .setDescription(description)
    .setFooter({
      text: `Page ${safePage}/${totalPages} · ${totalTracks} track${totalTracks === 1 ? '' : 's'} · ${formatDuration(totalDuration)} total · Loop: ${loopModeLabel(queue.loopMode)}`,
    });

  // Pagination buttons
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (totalPages > 1) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`music:queue_page:${safePage - 1}`)
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 1),
      new ButtonBuilder()
        .setCustomId(`music:queue_page:${safePage + 1}`)
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages),
    );
    components.push(row);
  }

  return { embeds: [embed], components };
}

// ── Added to Queue Embed ──────────────────────────────────

export function buildAddedEmbed(
  entry: QueueEntry,
  position: number,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(MUSIC_COLOR)
    .setDescription(
      `✅ Added [**${entry.title}**](${entry.uri}) to the queue\n` +
      `Duration: \`${formatDuration(entry.duration)}\` · Position: \`#${position}\``,
    );

  if (entry.artworkUrl) {
    embed.setThumbnail(entry.artworkUrl);
  }

  return embed;
}

export function buildPlaylistAddedEmbed(
  count: number,
  playlistName: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(MUSIC_COLOR)
    .setDescription(`✅ Added **${count}** tracks from **${playlistName}** to the queue`);
}

// ── Error Embed ───────────────────────────────────────────

export function buildMusicErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xF23F43) // Discord danger
    .setDescription(`❌ ${message}`);
}

// ── Info Embed ────────────────────────────────────────────

export function buildMusicInfoEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(MUSIC_COLOR)
    .setDescription(message);
}

export { formatDuration };
