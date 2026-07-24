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
import type { SomniClient } from '../../client.js';
import { resolveBrandKit } from '../branding/brand-kit.js';
import { createLogger } from '@somnibot/shared';
import { codePointSlice } from '../../utils/prize-snapshot.js';

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
          opt.setName('prize').setDescription('What the winner gets').setRequired(true).setMaxLength(1_000))
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
        // Canonical prize form — the winner-notification contract compares
        // btrim(left(btrim(prize), 1000)) snapshots; slice by code points so
        // an astral-heavy prize is never cut mid-surrogate.
        const prize = codePointSlice(
          interaction.options.getString('prize', true).trim(), 1_000,
        ).trim();
        if (prize.length === 0) {
          await interaction.reply({ content: '❌ Prize cannot be empty.', ephemeral: true });
          return;
        }
        const durationMin = interaction.options.getInteger('duration', true);
        // Fall back to the owner-configured default winner count when omitted.
        const winners = interaction.options.getInteger('winners') ?? (await manager.getDefaultWinnerCount());
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
        if (winners === null) {
          // The database was unreachable — the draw did NOT run. Never claim
          // "ended / no entries" from a failed read; degrade with the branded
          // unavailable notice (the brand read is itself outage-safe: it never
          // throws and falls back to the guild name).
          const supabase = (interaction.client as SomniClient).supabase;
          const brandKit = await resolveBrandKit(supabase, interaction.guildId!, {
            fallbackName: interaction.guild?.name,
          }).catch(() => null);
          const name = brandKit?.brandName ?? interaction.guild?.name ?? 'this server';
          await interaction.editReply({
            content: `⚠️ ${name}'s giveaways are temporarily unavailable — the draw was not run and the giveaway is untouched. Please try again in a moment.`,
          });
          break;
        }
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
        const winners = await manager.reroll(id, count, interaction.user.id);
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
        const paused = await manager.pauseGiveaway(id, interaction.user.id);
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
        const resumed = await manager.resumeGiveaway(id, interaction.user.id);
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
    log.error('Command error:', { error: String(err) });
    const content = '❌ An error occurred.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  }
}
