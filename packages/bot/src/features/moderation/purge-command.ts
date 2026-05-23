/**
 * /purge command — Bulk delete messages from a channel.
 *
 * V17 Behavioral Audit — Item 9
 *
 * Supports filters: from user, bots only, containing text.
 * Discord API limits: can only bulk-delete messages < 14 days old.
 */

import {
import { createLogger } from '@somnibot/shared';

const log = createLogger('PurgeCmd');
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type TextChannel,
  type Collection,
  type Message,
} from 'discord.js';

export function buildPurgeCommand() {
  return new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Bulk delete messages from this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((opt) =>
      opt
        .setName('count')
        .setDescription('Number of messages to delete (1-100)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100),
    )
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Only delete messages from this user'),
    )
    .addBooleanOption((opt) =>
      opt.setName('bots').setDescription('Only delete bot messages'),
    )
    .addStringOption((opt) =>
      opt.setName('contains').setDescription('Only delete messages containing this text'),
    );
}

export async function handlePurgeCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const count = interaction.options.getInteger('count', true);
  const targetUser = interaction.options.getUser('user');
  const botsOnly = interaction.options.getBoolean('bots');
  const contains = interaction.options.getString('contains');

  const channel = interaction.channel as TextChannel;
  if (!channel || !('bulkDelete' in channel)) {
    await interaction.editReply('❌ This command can only be used in text channels.');
    return;
  }

  try {
    // Fetch more messages than needed to account for filtering
    const fetchLimit = Math.min(count * 3, 100);
    const messages: Collection<string, Message> = await channel.messages.fetch({
      limit: fetchLimit,
      before: interaction.id,
    });

    let filtered = [...messages.values()];

    // Apply filters
    if (targetUser) {
      filtered = filtered.filter((m) => m.author.id === targetUser.id);
    }
    if (botsOnly) {
      filtered = filtered.filter((m) => m.author.bot);
    }
    if (contains) {
      const lower = contains.toLowerCase();
      filtered = filtered.filter((m) => m.content.toLowerCase().includes(lower));
    }

    // Only keep messages < 14 days old (Discord API limitation)
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    filtered = filtered.filter((m) => m.createdTimestamp > twoWeeksAgo);

    // Limit to requested count
    filtered = filtered.slice(0, count);

    if (filtered.length === 0) {
      await interaction.editReply('❌ No messages matched your filters (messages must be < 14 days old).');
      return;
    }

    const deleted = await channel.bulkDelete(filtered, true);

    const filterDesc: string[] = [];
    if (targetUser) filterDesc.push(`from <@${targetUser.id}>`);
    if (botsOnly) filterDesc.push('bots only');
    if (contains) filterDesc.push(`containing "${contains}"`);

    await interaction.editReply(
      `✅ Deleted **${deleted.size}** message${deleted.size !== 1 ? 's' : ''}${filterDesc.length > 0 ? ` (${filterDesc.join(', ')})` : ''}.`,
    );
  } catch (err) {
    log.error('Failed to bulk delete:', err);
    await interaction.editReply('❌ Failed to delete messages. Check bot permissions.');
  }
}
