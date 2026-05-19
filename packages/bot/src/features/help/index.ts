/**
 * Help Command — /help
 *
 * Lists all available commands grouped by category with descriptions.
 * Adapts based on which features are enabled in guild config.
 */
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  type Interaction,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import { SOMNI_PALETTE } from '@somnibot/shared';

interface CommandCategory {
  name: string;
  emoji: string;
  description: string;
  commands: { name: string; description: string }[];
}

export function buildHelpCommand() {
  return new SlashCommandBuilder()
    .setName('help')
    .setDescription('View all available commands and features')
    .addStringOption((opt) =>
      opt
        .setName('command')
        .setDescription('Get detailed help for a specific command'),
    );
}

function getCategories(enabledFeatures: Record<string, boolean>): CommandCategory[] {
  const categories: CommandCategory[] = [];

  // General (always available)
  categories.push({
    name: 'General',
    emoji: '🤖',
    description: 'Basic bot commands',
    commands: [
      { name: '/help', description: 'View this help menu' },
      { name: '/setup', description: 'Set up optional services (owner only)' },
    ],
  });

  // Moderation
  categories.push({
    name: 'Moderation',
    emoji: '🛡️',
    description: 'Server moderation tools (requires Moderate Members or higher)',
    commands: [
      { name: '/warn', description: 'Issue a warning to a member' },
      { name: '/mute', description: 'Timeout a member for a specified duration' },
      { name: '/kick', description: 'Kick a member from the server' },
      { name: '/ban', description: 'Ban a member from the server' },
      { name: '/pardon', description: 'Pardon (remove) an active infraction' },
      { name: '/infractions', description: 'View infractions for a member' },
    ],
  });

  // Tickets
  categories.push({
    name: 'Tickets',
    emoji: '🎫',
    description: 'Support ticket management',
    commands: [
      { name: '/ticket close', description: 'Close the current ticket' },
      { name: '/ticket add', description: 'Add a user to the current ticket' },
      { name: '/ticket remove', description: 'Remove a user from the current ticket' },
    ],
  });

  // Levels
  if (enabledFeatures.levels !== false) {
    categories.push({
      name: 'Levels',
      emoji: '📊',
      description: 'XP and level system',
      commands: [
        { name: '/rank', description: 'View your or another member\'s rank card' },
        { name: '/leaderboard', description: 'View the server XP leaderboard' },
      ],
    });
  }

  // Music
  if (enabledFeatures.music !== false) {
    categories.push({
      name: 'Music',
      emoji: '🎵',
      description: 'Music playback controls',
      commands: [
        { name: '/play', description: 'Play a song or add to queue (search or URL)' },
        { name: '/skip', description: 'Skip the current track' },
        { name: '/stop', description: 'Stop playback and clear queue' },
        { name: '/pause', description: 'Pause or resume playback' },
        { name: '/queue', description: 'View the current queue' },
        { name: '/np', description: 'Show the now playing track' },
        { name: '/volume', description: 'Set playback volume (0-150)' },
        { name: '/loop', description: 'Toggle loop mode (off/track/queue)' },
        { name: '/shuffle', description: 'Shuffle the queue' },
        { name: '/seek', description: 'Seek to a position in the track' },
        { name: '/remove', description: 'Remove a track from the queue' },
        { name: '/filter', description: 'Apply audio filters (bass, nightcore, etc.)' },
      ],
    });
  }

  // Commerce
  if (enabledFeatures.commerce !== false) {
    categories.push({
      name: 'Store',
      emoji: '🛒',
      description: 'Server store and licensing',
      commands: [
        { name: '/store', description: 'Browse the server store' },
        { name: '/license', description: 'Manage your license keys' },
      ],
    });
  }

  // Giveaways
  if (enabledFeatures.giveaways !== false) {
    categories.push({
      name: 'Giveaways',
      emoji: '🎉',
      description: 'Giveaway management (requires Manage Server)',
      commands: [
        { name: '/giveaway start', description: 'Start a new giveaway' },
        { name: '/giveaway end', description: 'End a giveaway early' },
        { name: '/giveaway reroll', description: 'Reroll winners for a giveaway' },
        { name: '/giveaway list', description: 'List active giveaways' },
      ],
    });
  }

  // Temp Channels
  if (enabledFeatures.tempChannels !== false) {
    categories.push({
      name: 'Voice',
      emoji: '🔊',
      description: 'Temporary voice channel controls',
      commands: [
        { name: '/voice name', description: 'Rename your temp channel' },
        { name: '/voice limit', description: 'Set user limit for your temp channel' },
        { name: '/voice lock', description: 'Lock/unlock your temp channel' },
        { name: '/voice permit', description: 'Allow a user into your locked channel' },
        { name: '/voice reject', description: 'Remove a user from your channel' },
        { name: '/voice transfer', description: 'Transfer ownership of your channel' },
        { name: '/voice bitrate', description: 'Set the bitrate of your channel' },
      ],
    });
  }

  return categories;
}

export async function handleHelpCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  const specificCommand = interaction.options.getString('command');

  // Load feature flags
  const { data: config } = await client.supabase
    .from('guild_config')
    .select('levels_enabled, music_enabled, paypal_enabled, giveaways_enabled, temp_channels_enabled')
    .eq('guild_id', client.guildId)
    .maybeSingle();

  const enabledFeatures = {
    levels: config?.levels_enabled ?? true,
    music: config?.music_enabled ?? true,
    commerce: config?.paypal_enabled ?? true,
    giveaways: config?.giveaways_enabled ?? true,
    tempChannels: config?.temp_channels_enabled ?? true,
  };

  const categories = getCategories(enabledFeatures);

  if (specificCommand) {
    // Find the specific command
    const cmdName = specificCommand.startsWith('/') ? specificCommand : `/${specificCommand}`;
    for (const cat of categories) {
      const found = cat.commands.find((c) => c.name === cmdName || c.name.startsWith(cmdName));
      if (found) {
        const embed = new EmbedBuilder()
          .setColor(SOMNI_PALETTE.CYAN)
          .setTitle(`${cat.emoji} ${found.name}`)
          .setDescription(found.description)
          .addFields({ name: 'Category', value: cat.name, inline: true })
          .setFooter({ text: 'Use /help to see all commands' });
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }
    }
    await interaction.reply({ content: `❌ Command \`${specificCommand}\` not found. Use \`/help\` to see all commands.`, ephemeral: true });
    return;
  }

  // Build overview embed
  const totalCommands = categories.reduce((sum, cat) => sum + cat.commands.length, 0);

  const overviewEmbed = new EmbedBuilder()
    .setColor(SOMNI_PALETTE.CYAN)
    .setTitle('🤖 SomniBot Commands')
    .setDescription(
      `**${totalCommands}** commands across **${categories.length}** categories.\n\nSelect a category below or use \`/help <command>\` for details.`,
    );

  for (const cat of categories) {
    const cmdList = cat.commands.map((c) => `\`${c.name}\``).join(', ');
    overviewEmbed.addFields({
      name: `${cat.emoji} ${cat.name} (${cat.commands.length})`,
      value: cmdList,
      inline: false,
    });
  }

  overviewEmbed.setFooter({
    text: 'SomniBot • Right-click users/messages for context menu actions',
  });

  // Category selector dropdown
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('help:category')
    .setPlaceholder('Select a category for details...')
    .addOptions(
      categories.map((cat) => ({
        label: cat.name,
        description: cat.description.slice(0, 100),
        value: cat.name,
        emoji: cat.emoji,
      })),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

  await interaction.reply({ embeds: [overviewEmbed], components: [row], ephemeral: true });
}

/**
 * Handle the category selector dropdown from /help.
 */
export async function handleHelpCategorySelect(
  interaction: StringSelectMenuInteraction,
  client: SomniClient,
): Promise<void> {
  const categoryName = interaction.values[0];

  const { data: config } = await client.supabase
    .from('guild_config')
    .select('levels_enabled, music_enabled, paypal_enabled, giveaways_enabled, temp_channels_enabled')
    .eq('guild_id', client.guildId)
    .maybeSingle();

  const enabledFeatures = {
    levels: config?.levels_enabled ?? true,
    music: config?.music_enabled ?? true,
    commerce: config?.paypal_enabled ?? true,
    giveaways: config?.giveaways_enabled ?? true,
    tempChannels: config?.temp_channels_enabled ?? true,
  };

  const categories = getCategories(enabledFeatures);
  const category = categories.find((c) => c.name === categoryName);

  if (!category) {
    await interaction.reply({ content: '❌ Category not found.', ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(SOMNI_PALETTE.CYAN)
    .setTitle(`${category.emoji} ${category.name}`)
    .setDescription(category.description);

  for (const cmd of category.commands) {
    embed.addFields({ name: cmd.name, value: cmd.description, inline: true });
  }

  embed.setFooter({ text: 'Use /help to go back to the overview' });

  await interaction.update({ embeds: [embed] });
}
