/**
 * Giveaway slash commands.
 *
 * /giveaway start — Start a new giveaway
 * /giveaway end   — End a giveaway early
 * /giveaway reroll — Reroll winners
 * /giveaway list  — List active giveaways
 */
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { GiveawayManager } from './giveaway-manager.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('GiveawayCmds');

export function buildGiveawayCommands() {
  const cmd = new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Manage giveaways')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Start a new giveaway')
        .addStringOption((opt) =>
          opt.setName('prize').setDescription('What the winner gets').setRequired(true))
        .addIntegerOption((opt) =>
          opt.setName('duration').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(43200))
        .addIntegerOption((opt) =>
          opt.setName('winners').setDescription('Number of winners (default: 1)').setMinValue(1).setMaxValue(50))
        .addRoleOption((opt) =>
          opt.setName('required_role').setDescription('Required role to enter'))
        .addIntegerOption((opt) =>
          opt.setName('required_level').setDescription('Minimum level to enter').setMinValue(1)))
    .addSubcommand((sub) =>
      sub
        .setName('end')
        .setDescription('End a giveaway early')
        .addStringOption((opt) =>
          opt.setName('id').setDescription('Giveaway ID').setRequired(true)))
    .addSubcommand((sub) =>
      sub
        .setName('reroll')
        .setDescription('Reroll giveaway winners')
        .addStringOption((opt) =>
          opt.setName('id').setDescription('Giveaway ID').setRequired(true))
        .addIntegerOption((opt) =>
          opt.setName('count').setDescription('Number of new winners').setMinValue(1).setMaxValue(50)))
    .addSubcommand((sub) =>
      sub
        .setName('pause')
        .setDescription('Pause an active giveaway')
        .addStringOption((opt) =>
          opt.setName('id').setDescription('Giveaway ID').setRequired(true)))
    .addSubcommand((sub) =>
      sub
        .setName('resume')
        .setDescription('Resume a paused giveaway')
        .addStringOption((opt) =>
          opt.setName('id').setDescription('Giveaway ID').setRequired(true)))
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List active giveaways'));

  return cmd;
}

export async function handleGiveawayCommand(
  interaction: ChatInputCommandInteraction,
  manager: GiveawayManager,
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case 'start': {
        const prize = interaction.options.getString('prize', true);
        const durationMin = interaction.options.getInteger('duration', true);
        const winners = interaction.options.getInteger('winners') ?? 1;
        const requiredRole = interaction.options.getRole('required_role');
        const requiredLevel = interaction.options.getInteger('required_level');

        await interaction.deferReply({ ephemeral: true });

        const giveaway = await manager.create({
          channelId: interaction.channelId,
          prize,
          winnerCount: winners,
          durationMs: durationMin * 60_000,
          creatorId: interaction.user.id,
          requiredRoleId: requiredRole?.id,
          requiredLevel: requiredLevel ?? undefined,
        });

        if (giveaway) {
          await interaction.editReply({
            content: `🎉 Giveaway started! Prize: **${prize}** • Duration: ${durationMin} minutes • ${winners} winner(s)`,
          });
        } else {
          await interaction.editReply({ content: '❌ Failed to create giveaway.' });
        }
        break;
      }

      case 'end': {
        const id = interaction.options.getString('id', true);
        await interaction.deferReply({ ephemeral: true });
        const winners = await manager.endGiveaway(id);
        await interaction.editReply({
          content: winners.length > 0
            ? `✅ Giveaway ended. Winners: ${winners.map((w) => `<@${w}>`).join(', ')}`
            : '✅ Giveaway ended. No entries.',
        });
        break;
      }

      case 'reroll': {
        const id = interaction.options.getString('id', true);
        const count = interaction.options.getInteger('count') ?? undefined;
        await interaction.deferReply({ ephemeral: true });
        const winners = await manager.reroll(id, count);
        await interaction.editReply({
          content: winners.length > 0
            ? `🎊 Rerolled! New winners: ${winners.map((w) => `<@${w}>`).join(', ')}`
            : '❌ No eligible entries for reroll.',
        });
        break;
      }

      case 'pause': {
        const id = interaction.options.getString('id', true);
        await interaction.deferReply({ ephemeral: true });
        const paused = await manager.pauseGiveaway(id);
        await interaction.editReply(
          paused
            ? '⏸️ Giveaway paused. Entries are blocked until resumed.'
            : '❌ Could not pause giveaway (it may not be active).',
        );
        break;
      }

      case 'resume': {
        const id = interaction.options.getString('id', true);
        await interaction.deferReply({ ephemeral: true });
        const resumed = await manager.resumeGiveaway(id);
        await interaction.editReply(
          resumed
            ? '▶️ Giveaway resumed! Entries are open again.'
            : '❌ Could not resume giveaway (it may not be paused).',
        );
        break;
      }

      case 'list': {
        await interaction.deferReply({ ephemeral: true });
        // We need supabase access — get it from the guild
        // This is a simplified list that fetches from the manager's context
        await interaction.editReply({
          content: 'Use the dashboard to view all giveaways, or check the giveaway channel.',
        });
        break;
      }
    }
  } catch (err) {
    log.error('Command error:', err);
    const content = '❌ An error occurred.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  }
}
