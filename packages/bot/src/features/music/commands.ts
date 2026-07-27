/**
 * Music Slash Commands — /play, /queue, /np, /skip, /stop, /volume, /loop, /shuffle, /seek, /remove
 *
 * Architecture doc §29
 */
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  ChannelType,
  type GuildMember,
} from 'discord.js';
import type { MusicPlayerManager } from './music-player.js';
import {
  buildNowPlayingEmbed,
  buildQueueEmbed,
  buildAddedEmbed,
  buildPlaylistAddedEmbed,
  buildMusicErrorEmbed,
  buildMusicInfoEmbed,
  buildFilterEmbed,
  formatDuration,
} from './music-embeds.js';
import type { FilterPreset } from './music-filters.js';

// ── Command Builders ──────────────────────────────────────

export function buildMusicCommands(): SlashCommandBuilder[] {
  const play = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or add it to the queue')
    .addStringOption((opt) =>
      opt
        .setName('query')
        .setDescription('Song name, URL, or playlist URL')
        .setRequired(true),
    ) as SlashCommandBuilder;

  const skip = new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track (DJ: force-skip, others: vote-skip)');

  const stop = new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback, clear the queue, and leave voice');

  const queue = new SlashCommandBuilder()
    .setName('queue')
    .setDescription('View the current music queue')
    .addIntegerOption((opt) =>
      opt
        .setName('page')
        .setDescription('Page number')
        .setMinValue(1)
        .setRequired(false),
    ) as SlashCommandBuilder;

  const np = new SlashCommandBuilder()
    .setName('np')
    .setDescription('Show the currently playing track');

  const volume = new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the playback volume')
    .addIntegerOption((opt) =>
      opt
        .setName('level')
        .setDescription('Volume level (0–150)')
        .setMinValue(0)
        .setMaxValue(150)
        .setRequired(true),
    ) as SlashCommandBuilder;

  const loop = new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set loop mode')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('Loop mode')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Track', value: 'track' },
          { name: 'Queue', value: 'queue' },
        ),
    ) as SlashCommandBuilder;

  const shuffle = new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Shuffle the upcoming tracks in the queue');

  const seek = new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Seek to a position in the current track')
    .addStringOption((opt) =>
      opt
        .setName('position')
        .setDescription('Position to seek to (e.g., 1:30, 90)')
        .setRequired(true),
    ) as SlashCommandBuilder;

  const remove = new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue')
    .addIntegerOption((opt) =>
      opt
        .setName('position')
        .setDescription('Position in the upcoming queue (1 = next track)')
        .setMinValue(1)
        .setRequired(true),
    ) as SlashCommandBuilder;

  const move = new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move a track you requested to a new position in the queue')
    .addIntegerOption((opt) =>
      opt
        .setName('from')
        .setDescription('Current position in the upcoming queue (1 = next track)')
        .setMinValue(1)
        .setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('to')
        .setDescription('New position in the upcoming queue (1 = next track)')
        .setMinValue(1)
        .setRequired(true),
    ) as SlashCommandBuilder;

  const pause = new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause or resume playback');

  const filter = new SlashCommandBuilder()
    .setName('filter')
    .setDescription('Apply audio filters (DJ only)')
    .addStringOption((opt) =>
      opt
        .setName('preset')
        .setDescription('Filter preset to apply')
        .setRequired(false)
        .addChoices(
          { name: '🔊 Bass Boost', value: 'bassboost' },
          { name: '🔔 Treble Boost', value: 'treble' },
          { name: '🌙 Nightcore', value: 'nightcore' },
          { name: '🌊 Vaporwave', value: 'vaporwave' },
          { name: '🎧 8D Audio', value: '8d' },
          { name: '🔄 Reset (clear all)', value: 'reset' },
        ),
    )
    .addNumberOption((opt) =>
      opt
        .setName('speed')
        .setDescription('Playback speed (0.1–3.0, default 1.0)')
        .setMinValue(0.1)
        .setMaxValue(3.0)
        .setRequired(false),
    )
    .addNumberOption((opt) =>
      opt
        .setName('pitch')
        .setDescription('Pitch multiplier (0.1–3.0, default 1.0)')
        .setMinValue(0.1)
        .setMaxValue(3.0)
        .setRequired(false),
    )
    .addNumberOption((opt) =>
      opt
        .setName('rate')
        .setDescription('Audio rate (0.1–3.0, default 1.0)')
        .setMinValue(0.1)
        .setMaxValue(3.0)
        .setRequired(false),
    ) as SlashCommandBuilder;

  return [play, skip, stop, queue, np, volume, loop, shuffle, seek, remove, move, pause, filter];
}

// ── Command Handlers ──────────────────────────────────────

export async function handleMusicCommand(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
): Promise<void> {
  const name = interaction.commandName;
  const guildId = interaction.guildId!;

  switch (name) {
    case 'play':
      await handlePlay(interaction, musicPlayer);
      break;
    case 'skip':
      await handleSkip(interaction, musicPlayer, guildId);
      break;
    case 'stop':
      await handleStop(interaction, musicPlayer, guildId);
      break;
    case 'queue':
      await handleQueue(interaction, musicPlayer, guildId);
      break;
    case 'np':
      await handleNowPlaying(interaction, musicPlayer, guildId);
      break;
    case 'volume':
      await handleVolume(interaction, musicPlayer, guildId);
      break;
    case 'loop':
      await handleLoop(interaction, musicPlayer, guildId);
      break;
    case 'shuffle':
      await handleShuffle(interaction, musicPlayer, guildId);
      break;
    case 'seek':
      await handleSeek(interaction, musicPlayer, guildId);
      break;
    case 'remove':
      await handleRemove(interaction, musicPlayer, guildId);
      break;
    case 'move':
      await handleMove(interaction, musicPlayer, guildId);
      break;
    case 'pause':
      await handlePause(interaction, musicPlayer, guildId);
      break;
    case 'filter':
      await handleFilter(interaction, musicPlayer, guildId);
      break;
    default:
      await interaction.reply({ content: '❌ Unknown music command', ephemeral: true });
  }
}

// ── Individual Handlers ───────────────────────────────────

async function handlePlay(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
): Promise<void> {
  const member = interaction.member as GuildMember;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    await interaction.reply({
      embeds: [buildMusicErrorEmbed('You must be in a voice channel to use this command')],
      ephemeral: true,
    });
    return;
  }

  const textChannel = interaction.channel;
  if (!textChannel || textChannel.type !== ChannelType.GuildText) {
    await interaction.reply({
      embeds: [buildMusicErrorEmbed('This command can only be used in a text channel')],
      ephemeral: true,
    });
    return;
  }

  const query = interaction.options.getString('query', true);

  await interaction.deferReply();

  const result = await musicPlayer.play(query, member.id, voiceChannel, textChannel);

  if (!result.success) {
    await interaction.editReply({
      embeds: [buildMusicErrorEmbed(result.message ?? 'Failed to play track')],
    });
    return;
  }

  if (result.count && result.count > 1 && result.playlistName) {
    await interaction.editReply({
      embeds: [buildPlaylistAddedEmbed(result.count, result.playlistName)],
    });
  } else if (result.entry) {
    const queue = await musicPlayer.queueManager.getQueue(interaction.guildId!);
    const position = queue ? queue.entries.length - queue.currentIndex : 1;
    await interaction.editReply({
      embeds: [buildAddedEmbed(result.entry, position)],
    });
  } else {
    await interaction.editReply({
      embeds: [buildMusicInfoEmbed(`✅ Added **${result.count ?? 1}** track(s) to the queue`)],
    });
  }
}

async function handleSkip(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
  guildId: string,
): Promise<void> {
  const isDj = await musicPlayer.isDJ(interaction.user.id);

  if (isDj) {
    const result = await musicPlayer.skip(guildId, { userId: interaction.user.id, method: 'dj_force' });
    await interaction.reply({
      embeds: [buildMusicInfoEmbed(result.message)],
    });
  } else {
    const result = await musicPlayer.voteSkip(guildId, interaction.user.id);
    await interaction.reply({
      embeds: [result.success
        ? buildMusicInfoEmbed(result.message)
        : buildMusicErrorEmbed(result.message)],
    });
  }
}

async function handleStop(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
  guildId: string,
): Promise<void> {
  const isDj = await musicPlayer.isDJ(interaction.user.id);
  if (!isDj) {
    musicPlayer.auditPermissionDenied(interaction.user.id, 'stop');
    await interaction.reply({
      embeds: [buildMusicErrorEmbed('You need the DJ role to stop playback')],
      ephemeral: true,
    });
    return;
  }

  const result = await musicPlayer.stop(guildId, { userId: interaction.user.id, reason: 'command' });
  await interaction.reply({
    embeds: [buildMusicInfoEmbed(result.message)],
  });
}

async function handleQueue(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
  guildId: string,
): Promise<void> {
  const queue = await musicPlayer.queueManager.getQueue(guildId);
  if (!queue) {
    await interaction.reply({
      embeds: [buildMusicInfoEmbed('📭 No active queue. Use `/play` to start one.')],
      ephemeral: true,
    });
    return;
  }

  const page = interaction.options.getInteger('page') ?? 1;
  const { embeds, components } = buildQueueEmbed(queue, page);
  await interaction.reply({ embeds, components });
}

async function handleNowPlaying(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
  guildId: string,
): Promise<void> {
  const queue = await musicPlayer.queueManager.getQueue(guildId);
  if (!queue) {
    await interaction.reply({
      embeds: [buildMusicInfoEmbed('📭 Nothing is playing right now.')],
      ephemeral: true,
    });
    return;
  }

  const current = queue.entries[queue.currentIndex];
  if (!current) {
    await interaction.reply({
      embeds: [buildMusicInfoEmbed('📭 Nothing is playing right now.')],
      ephemeral: true,
    });
    return;
  }

  const position = musicPlayer.getPlayerPosition(guildId);
  const activeFilters = musicPlayer.getActiveFilters(guildId);
  const { embeds, components } = buildNowPlayingEmbed(current, position, queue, activeFilters);
  await interaction.reply({ embeds, components: components });
}

async function handleVolume(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
  guildId: string,
): Promise<void> {
  const isDj = await musicPlayer.isDJ(interaction.user.id);
  if (!isDj) {
    musicPlayer.auditPermissionDenied(interaction.user.id, 'volume');
    await interaction.reply({
      embeds: [buildMusicErrorEmbed('You need the DJ role to change the volume')],
      ephemeral: true,
    });
    return;
  }

  const level = interaction.options.getInteger('level', true);
  const result = await musicPlayer.setVolume(guildId, level, { userId: interaction.user.id });
  await interaction.reply({
    embeds: [result.success
      ? buildMusicInfoEmbed(result.message)
      : buildMusicErrorEmbed(result.message)],
  });
}

async function handleLoop(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
  guildId: string,
): Promise<void> {
  const isDj = await musicPlayer.isDJ(interaction.user.id);
  if (!isDj) {
    musicPlayer.auditPermissionDenied(interaction.user.id, 'loop');
    await interaction.reply({
      embeds: [buildMusicErrorEmbed('You need the DJ role to change the loop mode')],
      ephemeral: true,
    });
    return;
  }

  const mode = interaction.options.getString('mode', true) as 'off' | 'track' | 'queue';
  const result = await musicPlayer.setLoopMode(guildId, mode, { userId: interaction.user.id });
  await interaction.reply({
    embeds: [buildMusicInfoEmbed(result.message)],
  });
}

async function handleShuffle(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
  guildId: string,
): Promise<void> {
  const isDj = await musicPlayer.isDJ(interaction.user.id);
  if (!isDj) {
    musicPlayer.auditPermissionDenied(interaction.user.id, 'shuffle');
    await interaction.reply({
      embeds: [buildMusicErrorEmbed('You need the DJ role to shuffle the queue')],
      ephemeral: true,
    });
    return;
  }

  const result = await musicPlayer.shuffle(guildId, { userId: interaction.user.id });
  await interaction.reply({
    embeds: [result.success
      ? buildMusicInfoEmbed(result.message)
      : buildMusicErrorEmbed(result.message)],
  });
}

async function handleSeek(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
  guildId: string,
): Promise<void> {
  const isDj = await musicPlayer.isDJ(interaction.user.id);
  if (!isDj) {
    musicPlayer.auditPermissionDenied(interaction.user.id, 'seek');
    await interaction.reply({
      embeds: [buildMusicErrorEmbed('You need the DJ role to seek')],
      ephemeral: true,
    });
    return;
  }

  const positionStr = interaction.options.getString('position', true);
  const positionMs = parseSeekPosition(positionStr);

  if (positionMs === null) {
    await interaction.reply({
      embeds: [buildMusicErrorEmbed('Invalid position format. Use `1:30` or `90` (seconds)')],
      ephemeral: true,
    });
    return;
  }

  const result = await musicPlayer.seek(guildId, positionMs, { userId: interaction.user.id });
  await interaction.reply({
    embeds: [result.success
      ? buildMusicInfoEmbed(result.message)
      : buildMusicErrorEmbed(result.message)],
  });
}

async function handleRemove(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
  guildId: string,
): Promise<void> {
  const isDj = await musicPlayer.isDJ(interaction.user.id);
  if (!isDj) {
    musicPlayer.auditPermissionDenied(interaction.user.id, 'remove');
    await interaction.reply({
      embeds: [buildMusicErrorEmbed('You need the DJ role to remove tracks')],
      ephemeral: true,
    });
    return;
  }

  const position = interaction.options.getInteger('position', true);
  const result = await musicPlayer.remove(guildId, position, { userId: interaction.user.id });
  await interaction.reply({
    embeds: [result.success
      ? buildMusicInfoEmbed(result.message)
      : buildMusicErrorEmbed(result.message)],
  });
}

/**
 * /move — reposition an upcoming track. Authorization is inside
 * musicPlayer.move: a DJ may always reorder; otherwise the requester of that
 * track may move it only when the requester-move fairness control is enabled.
 */
async function handleMove(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
  guildId: string,
): Promise<void> {
  const from = interaction.options.getInteger('from', true);
  const to = interaction.options.getInteger('to', true);
  const result = await musicPlayer.move(guildId, interaction.user.id, from, to);
  await interaction.reply({
    embeds: [result.success
      ? buildMusicInfoEmbed(result.message)
      : buildMusicErrorEmbed(result.message)],
    ephemeral: !result.success,
  });
}

async function handlePause(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
  guildId: string,
): Promise<void> {
  const isDj = await musicPlayer.isDJ(interaction.user.id);
  if (!isDj) {
    musicPlayer.auditPermissionDenied(interaction.user.id, 'pause');
    await interaction.reply({
      embeds: [buildMusicErrorEmbed('You need the DJ role to pause/resume')],
      ephemeral: true,
    });
    return;
  }

  const result = await musicPlayer.togglePause(guildId, { userId: interaction.user.id });
  await interaction.reply({
    embeds: [result.success
      ? buildMusicInfoEmbed(result.message)
      : buildMusicErrorEmbed(result.message)],
  });
}

async function handleFilter(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
  guildId: string,
): Promise<void> {
  const isDj = await musicPlayer.isDJ(interaction.user.id);
  if (!isDj) {
    musicPlayer.auditPermissionDenied(interaction.user.id, 'filter');
    await interaction.reply({
      embeds: [buildMusicErrorEmbed('You need the DJ role to change filters')],
      ephemeral: true,
    });
    return;
  }

  const preset = interaction.options.getString('preset') as FilterPreset | null;
  const speed = interaction.options.getNumber('speed');
  const pitch = interaction.options.getNumber('pitch');
  const rate = interaction.options.getNumber('rate');

  // If neither preset nor custom values provided, show current filters
  if (!preset && speed === null && pitch === null && rate === null) {
    const active = musicPlayer.getActiveFilters(guildId);
    await interaction.reply({
      embeds: [buildFilterEmbed('🎛️ Current audio filters', active)],
    });
    return;
  }

  // Apply preset first (if given)
  if (preset) {
    const result = await musicPlayer.applyFilter(guildId, preset, { userId: interaction.user.id });
    if (!result.success) {
      await interaction.reply({
        embeds: [buildMusicErrorEmbed(result.message)],
        ephemeral: true,
      });
      return;
    }

    // If only preset, respond with it
    if (speed === null && pitch === null && rate === null) {
      const active = musicPlayer.getActiveFilters(guildId);
      await interaction.reply({
        embeds: [buildFilterEmbed(result.message, active)],
      });
      return;
    }
  }

  // Apply custom timescale (speed/pitch/rate)
  if (speed !== null || pitch !== null || rate !== null) {
    const result = await musicPlayer.applyCustomSpeed(
      guildId,
      speed ?? undefined,
      pitch ?? undefined,
      rate ?? undefined,
      { userId: interaction.user.id },
    );
    if (!result.success) {
      await interaction.reply({
        embeds: [buildMusicErrorEmbed(result.message)],
        ephemeral: true,
      });
      return;
    }

    const active = musicPlayer.getActiveFilters(guildId);
    await interaction.reply({
      embeds: [buildFilterEmbed(result.message, active)],
    });
    return;
  }
}

// ── Helpers ───────────────────────────────────────────────

/** Parse a seek position string (e.g., "1:30", "90", "1:02:30") to milliseconds. */
function parseSeekPosition(input: string): number | null {
  const trimmed = input.trim();

  // Try mm:ss or hh:mm:ss format
  const parts = trimmed.split(':').map(Number);
  if (parts.some(isNaN)) return null;

  if (parts.length === 2) {
    const [mins, secs] = parts as [number, number];
    if (mins < 0 || secs < 0 || secs >= 60) return null;
    return (mins * 60 + secs) * 1000;
  }

  if (parts.length === 3) {
    const [hours, mins, secs] = parts as [number, number, number];
    if (hours < 0 || mins < 0 || secs < 0 || mins >= 60 || secs >= 60) return null;
    return (hours * 3600 + mins * 60 + secs) * 1000;
  }

  if (parts.length === 1) {
    const seconds = parts[0]!;
    if (seconds < 0) return null;
    return seconds * 1000;
  }

  return null;
}
