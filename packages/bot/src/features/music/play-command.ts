import {
  ChannelType,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import type { BrandKit } from '../branding/index.js';
import {
  buildAddedEmbed,
  buildMusicErrorEmbed,
  buildMusicInfoEmbed,
  buildPlaylistAddedEmbed,
} from './music-embeds.js';
import type { MusicPlayerManager } from './music-player.js';

export async function handlePlayCommand(
  interaction: ChatInputCommandInteraction,
  musicPlayer: MusicPlayerManager,
  brandKit: BrandKit,
): Promise<void> {
  const member = interaction.member as GuildMember;
  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    await interaction.reply({
      embeds: [buildMusicErrorEmbed('You must be in a voice channel to use this command', brandKit)],
      ephemeral: true,
    });
    return;
  }

  const textChannel = interaction.channel;
  if (!textChannel || textChannel.type !== ChannelType.GuildText) {
    await interaction.reply({
      embeds: [buildMusicErrorEmbed('This command can only be used in a text channel', brandKit)],
      ephemeral: true,
    });
    return;
  }

  const query = interaction.options.getString('query', true);
  await interaction.deferReply();
  const outcome = await musicPlayer.executeInteractionOccurrence({
    interactionId: interaction.id,
    userId: member.id,
    action: 'play',
    mutate: () => musicPlayer.play(query, member.id, voiceChannel, textChannel),
  });

  switch (outcome.kind) {
    case 'replayed':
      await interaction.editReply({ embeds: [buildMusicInfoEmbed(outcome.message, brandKit)] });
      return;
    case 'unavailable':
      await interaction.editReply({ embeds: [buildMusicErrorEmbed(outcome.message, brandKit)] });
      return;
    case 'indeterminate':
      await interaction.editReply({ embeds: [buildMusicErrorEmbed(outcome.message, brandKit)] });
      return;
    case 'applied': {
      const result = outcome.value;
      if (!result.success) {
        await interaction.editReply({
          embeds: [buildMusicErrorEmbed(result.message ?? 'Failed to play track', brandKit)],
        });
        return;
      }
      if (result.count && result.count > 1 && result.playlistName) {
        await interaction.editReply({
          embeds: [buildPlaylistAddedEmbed(result.count, result.playlistName, brandKit)],
        });
      } else if (result.entry) {
        const queue = await musicPlayer.queueManager.getQueue(musicPlayer.guildId);
        const position = queue ? queue.entries.length - queue.currentIndex : 1;
        await interaction.editReply({ embeds: [buildAddedEmbed(result.entry, position, brandKit)] });
      } else {
        await interaction.editReply({
          embeds: [buildMusicInfoEmbed(`✅ Added **${result.count ?? 1}** track(s) to the queue`, brandKit)],
        });
      }
      return;
    }
    default:
      return assertNeverMusicOutcome(outcome);
  }
}

function assertNeverMusicOutcome(outcome: never): never {
  throw new TypeError(`Unexpected music occurrence outcome: ${String(outcome)}`);
}
