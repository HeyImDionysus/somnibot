/**
 * /rank, /rank customize, /leaderboard slash commands.
 *
 * Architecture doc §24.7–24.8
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  SlashCommandSubcommandBuilder,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import { generateRankCard, loadRankCardSettings } from './rank-card.js';
import { levelProgress } from '@somnibot/shared';

/**
 * Build the slash command definitions for levels.
 */
export function buildLevelCommands() {
  const rankCmd = new SlashCommandBuilder()
    .setName('rank')
    .setDescription('View or customize rank cards')
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub.setName('view').setDescription('View your or another member\'s rank card')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('User to check').setRequired(false),
        ),
    )
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub.setName('customize').setDescription('Customize your rank card')
        .addStringOption((opt) =>
          opt.setName('background').setDescription('Background image URL').setRequired(false),
        )
        .addStringOption((opt) =>
          opt.setName('accent').setDescription('Accent hex color (e.g. #FF1493)').setRequired(false),
        )
        .addStringOption((opt) =>
          opt.setName('progress_bar').setDescription('Progress bar hex color').setRequired(false),
        )
        .addNumberOption((opt) =>
          opt.setName('opacity').setDescription('Overlay opacity (0.0 - 1.0)').setMinValue(0).setMaxValue(1).setRequired(false),
        )
        .addBooleanOption((opt) =>
          opt.setName('reset').setDescription('Reset to server defaults').setRequired(false),
        )
        .addBooleanOption((opt) =>
          opt.setName('preview').setDescription('Preview without saving').setRequired(false),
        ),
    );

  const leaderboardCmd = new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the server XP leaderboard');

  return { rankCmd, leaderboardCmd };
}

/**
 * Handle /rank command — routes to view or customize.
 */
export async function handleRankCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'customize') {
    await handleRankCustomize(interaction, client);
    return;
  }

  // Default: view
  await handleRankView(interaction, client);
}

/**
 * Handle /rank view subcommand.
 */
async function handleRankView(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  await interaction.deferReply();

  const targetUser = interaction.options.getUser('user') ?? interaction.user;
  const guildId = client.guildId;

  // Fetch user data
  const { data: levelData } = await client.supabase
    .from('member_levels')
    .select('*')
    .eq('guild_id', guildId)
    .eq('member_id', targetUser.id)
    .maybeSingle();

  if (!levelData) {
    await interaction.editReply({
      content: `${targetUser.id === interaction.user.id ? 'You don\'t' : `<@${targetUser.id}> doesn't`} have any XP yet. Start chatting to earn XP!`,
    });
    return;
  }

  // Calculate rank
  const { count: rankCount } = await client.supabase
    .from('member_levels')
    .select('member_id', { count: 'exact', head: true })
    .eq('guild_id', guildId)
    .gt('xp', levelData.xp);

  const rank = (rankCount ?? 0) + 1;

  // Load card settings
  const cardSettings = await loadRankCardSettings(client.supabase, guildId, targetUser.id);

  const member = interaction.guild?.members.cache.get(targetUser.id);
  const displayName = member?.displayName ?? targetUser.username;
  const avatarUrl = targetUser.displayAvatarURL({ extension: 'png', size: 256 });

  const cardBuffer = await generateRankCard({
    username: displayName,
    avatarUrl,
    level: levelData.level,
    xp: levelData.xp,
    rank,
    totalMessages: levelData.total_messages ?? 0,
    accentColor: cardSettings.accentColor,
    progressBarColor: cardSettings.progressBarColor,
    overlayOpacity: cardSettings.overlayOpacity,
    backgroundImageUrl: cardSettings.backgroundUrl ?? undefined,
  });

  const attachment = new AttachmentBuilder(cardBuffer, { name: 'rank-card.png' });
  await interaction.editReply({ files: [attachment] });
}

/**
 * Handle /rank customize subcommand.
 */
async function handleRankCustomize(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const userId = interaction.user.id;
  const guildId = client.guildId;

  const reset = interaction.options.getBoolean('reset');
  const preview = interaction.options.getBoolean('preview');
  const background = interaction.options.getString('background');
  const accent = interaction.options.getString('accent');
  const progressBar = interaction.options.getString('progress_bar');
  const opacity = interaction.options.getNumber('opacity');

  if (reset) {
    await client.supabase
      .from('member_rank_settings')
      .delete()
      .eq('guild_id', guildId)
      .eq('member_id', userId);

    await interaction.editReply({ content: '✅ Rank card settings reset to server defaults.' });
    return;
  }

  // Parse hex colors
  const parseHex = (str: string | null): number | undefined => {
    if (!str) return undefined;
    const clean = str.replace('#', '');
    const val = parseInt(clean, 16);
    return isNaN(val) ? undefined : val;
  };

  const accentNum = parseHex(accent);
  const progressNum = parseHex(progressBar);

  if (!preview) {
    // Build update object
    const updates: Record<string, unknown> = {
      guild_id: guildId,
      member_id: userId,
      updated_at: new Date().toISOString(),
    };

    if (background !== null) updates.background_url = background;
    if (accentNum !== undefined) updates.accent_color = accentNum;
    if (progressNum !== undefined) updates.progress_bar_color = progressNum;
    if (opacity !== null) updates.overlay_opacity = opacity;

    await client.supabase
      .from('member_rank_settings')
      .upsert(updates, { onConflict: 'guild_id,member_id' });

    await interaction.editReply({ content: '✅ Rank card customization saved! Use `/rank view` to see it.' });
  } else {
    // Generate preview
    const cardSettings = await loadRankCardSettings(client.supabase, guildId, userId);

    // Apply preview overrides
    if (background) cardSettings.backgroundUrl = background;
    if (accent) cardSettings.accentColor = accent;
    if (progressBar) cardSettings.progressBarColor = progressBar;
    if (opacity !== null) cardSettings.overlayOpacity = opacity;

    const { data: levelData } = await client.supabase
      .from('member_levels')
      .select('*')
      .eq('guild_id', guildId)
      .eq('member_id', userId)
      .maybeSingle();

    const cardBuffer = await generateRankCard({
      username: interaction.user.username,
      avatarUrl: interaction.user.displayAvatarURL({ extension: 'png', size: 256 }),
      level: levelData?.level ?? 0,
      xp: levelData?.xp ?? 0,
      rank: 1,
      totalMessages: levelData?.total_messages ?? 0,
      accentColor: cardSettings.accentColor,
      progressBarColor: cardSettings.progressBarColor,
      overlayOpacity: cardSettings.overlayOpacity,
      backgroundImageUrl: cardSettings.backgroundUrl ?? undefined,
    });

    const attachment = new AttachmentBuilder(cardBuffer, { name: 'rank-preview.png' });
    await interaction.editReply({ content: '📋 Preview (not saved):', files: [attachment] });
  }
}

/**
 * Handle /leaderboard command.
 */
export async function handleLeaderboardCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  await interaction.deferReply();

  const guildId = client.guildId;
  const pageSize = 10;

  // Fetch first page
  const { data, count } = await client.supabase
    .from('member_levels')
    .select('member_id, xp, level', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('xp', { ascending: false })
    .range(0, pageSize - 1);

  if (!data || data.length === 0) {
    await interaction.editReply({ content: 'No one has earned XP yet!' });
    return;
  }

  const totalPages = Math.ceil((count ?? 0) / pageSize);
  let currentPage = 0;

  const buildLeaderboardContent = async (page: number): Promise<string> => {
    const offset = page * pageSize;
    const { data: pageData } = await client.supabase
      .from('member_levels')
      .select('member_id, xp, level')
      .eq('guild_id', guildId)
      .order('xp', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (!pageData || pageData.length === 0) return 'No data.';

    const medals = ['🥇', '🥈', '🥉'];
    const lines = pageData.map((entry, i) => {
      const pos = offset + i + 1;
      const medal = pos <= 3 ? medals[pos - 1] : `**${pos}.**`;
      return `${medal} <@${entry.member_id}> — Level ${entry.level} (${entry.xp.toLocaleString()} XP)`;
    });

    return `🏆 **Server Leaderboard**\n\n${lines.join('\n')}\n\nPage ${page + 1}/${totalPages}`;
  };

  const content = await buildLeaderboardContent(0);

  if (totalPages <= 1) {
    await interaction.editReply({ content });
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('lb_prev')
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('lb_next')
      .setLabel('▶ Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(totalPages <= 1),
  );

  const reply = await interaction.editReply({ content, components: [row] });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 120_000,
  });

  collector.on('collect', async (btnInteraction) => {
    if (btnInteraction.user.id !== interaction.user.id) {
      await btnInteraction.reply({ content: 'Only the command user can navigate.', ephemeral: true });
      return;
    }

    if (btnInteraction.customId === 'lb_prev') currentPage--;
    if (btnInteraction.customId === 'lb_next') currentPage++;

    const newContent = await buildLeaderboardContent(currentPage);
    const newRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('lb_prev')
        .setLabel('◀ Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId('lb_next')
        .setLabel('▶ Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= totalPages - 1),
    );

    await btnInteraction.update({ content: newContent, components: [newRow] });
  });

  collector.on('end', async () => {
    try {
      await interaction.editReply({ components: [] });
    } catch {
      // Message may have been deleted
    }
  });
}
