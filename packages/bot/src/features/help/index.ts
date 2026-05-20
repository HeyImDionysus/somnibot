/**
 * Help Command — /help
 *
 * V17 Behavioral Audit — Item 13
 *
 * Lists all available commands grouped by category with descriptions.
 * Auto-syncs from the registered command registry instead of hardcoding.
 *
 * The categories and command descriptions are derived from the actual
 * registered SlashCommandBuilder data stored on the client.
 */
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type RESTPostAPIApplicationCommandsJSONBody,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  ApplicationCommandType,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import { SOMNI_PALETTE } from '@somnibot/shared';

interface CommandCategory {
  name: string;
  emoji: string;
  description: string;
  commands: { name: string; description: string }[];
}

// ── Category classification ──────────────────────────────

// Map command names to their category
const COMMAND_CATEGORY_MAP: Record<string, { category: string; emoji: string; description: string }> = {
  help: { category: 'General', emoji: '🤖', description: 'Basic bot commands' },
  setup: { category: 'General', emoji: '🤖', description: 'Basic bot commands' },
  warn: { category: 'Moderation', emoji: '🛡️', description: 'Server moderation tools' },
  mute: { category: 'Moderation', emoji: '🛡️', description: 'Server moderation tools' },
  kick: { category: 'Moderation', emoji: '🛡️', description: 'Server moderation tools' },
  ban: { category: 'Moderation', emoji: '🛡️', description: 'Server moderation tools' },
  pardon: { category: 'Moderation', emoji: '🛡️', description: 'Server moderation tools' },
  infractions: { category: 'Moderation', emoji: '🛡️', description: 'Server moderation tools' },
  purge: { category: 'Moderation', emoji: '🛡️', description: 'Server moderation tools' },
  rank: { category: 'Levels', emoji: '📊', description: 'XP and level system' },
  leaderboard: { category: 'Levels', emoji: '📊', description: 'XP and level system' },
  xp: { category: 'Levels', emoji: '📊', description: 'XP and level system' },
  play: { category: 'Music', emoji: '🎵', description: 'Music playback controls' },
  skip: { category: 'Music', emoji: '🎵', description: 'Music playback controls' },
  stop: { category: 'Music', emoji: '🎵', description: 'Music playback controls' },
  pause: { category: 'Music', emoji: '🎵', description: 'Music playback controls' },
  queue: { category: 'Music', emoji: '🎵', description: 'Music playback controls' },
  np: { category: 'Music', emoji: '🎵', description: 'Music playback controls' },
  volume: { category: 'Music', emoji: '🎵', description: 'Music playback controls' },
  loop: { category: 'Music', emoji: '🎵', description: 'Music playback controls' },
  shuffle: { category: 'Music', emoji: '🎵', description: 'Music playback controls' },
  seek: { category: 'Music', emoji: '🎵', description: 'Music playback controls' },
  remove: { category: 'Music', emoji: '🎵', description: 'Music playback controls' },
  filter: { category: 'Music', emoji: '🎵', description: 'Music playback controls' },
  store: { category: 'Store', emoji: '🛒', description: 'Server store and licensing' },
  license: { category: 'Store', emoji: '🛒', description: 'Server store and licensing' },
  giveaway: { category: 'Giveaways', emoji: '🎉', description: 'Giveaway management' },
  voice: { category: 'Voice', emoji: '🔊', description: 'Temporary voice channel controls' },
  ticket: { category: 'Tickets', emoji: '🎫', description: 'Support ticket management' },
};

const CATEGORY_ORDER = ['General', 'Moderation', 'Tickets', 'Levels', 'Music', 'Store', 'Giveaways', 'Voice'];

/**
 * Build categories from the actual registered command JSON bodies.
 */
function buildCategoriesFromRegistry(
  commands: RESTPostAPIApplicationCommandsJSONBody[],
): CommandCategory[] {
  const categoryMap = new Map<string, CommandCategory>();

  for (const cmd of commands) {
    // Skip context menu commands (they have type 2 or 3)
    if (cmd.type && cmd.type !== ApplicationCommandType.ChatInput) continue;

    const name = cmd.name;
    const mapping = COMMAND_CATEGORY_MAP[name];
    const catName = mapping?.category ?? 'Other';
    const emoji = mapping?.emoji ?? '📦';
    const catDesc = mapping?.description ?? 'Other commands';

    if (!categoryMap.has(catName)) {
      categoryMap.set(catName, {
        name: catName,
        emoji,
        description: catDesc,
        commands: [],
      });
    }

    const category = categoryMap.get(catName)!;

    // If the command has subcommands, list each subcommand
    const options = cmd.options ?? [];
    const subcommands = options.filter(
      (o) => o.type === 1, // SUB_COMMAND
    );

    if (subcommands.length > 0) {
      for (const sub of subcommands) {
        category.commands.push({
          name: `/${name} ${sub.name}`,
          description: sub.description,
        });
      }
    } else {
      category.commands.push({
        name: `/${name}`,
        description: cmd.description ?? 'No description',
      });
    }
  }

  // Sort categories by defined order
  const sorted: CommandCategory[] = [];
  for (const catName of CATEGORY_ORDER) {
    const cat = categoryMap.get(catName);
    if (cat) sorted.push(cat);
  }
  // Append any categories not in the predefined order
  for (const [catName, cat] of categoryMap) {
    if (!CATEGORY_ORDER.includes(catName)) {
      sorted.push(cat);
    }
  }

  return sorted;
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

export async function handleHelpCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  const specificCommand = interaction.options.getString('command');

  // Read command registry from client (set during boot)
  const registeredCommands =
    ((client as unknown as Record<string, unknown>)._registeredCommands as RESTPostAPIApplicationCommandsJSONBody[]) ?? [];

  const categories = buildCategoriesFromRegistry(registeredCommands);

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

  const registeredCommands =
    ((client as unknown as Record<string, unknown>)._registeredCommands as RESTPostAPIApplicationCommandsJSONBody[]) ?? [];

  const categories = buildCategoriesFromRegistry(registeredCommands);
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
