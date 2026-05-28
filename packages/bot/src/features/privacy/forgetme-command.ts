/**
 * /forgetme — GDPR-style right-to-erasure command.
 *
 * V53 Phase 1.7 — S-5
 *
 * Allows any member to request deletion of ALL their personal data
 * from the guild's database. This is irreversible and includes:
 * - Economy data (wallet, inventory, transactions, market listings)
 * - Level/XP data
 * - Quest progress, achievements, pets, profiles
 * - Farm plots, fish catches, adventure sessions
 * - Member record
 *
 * Tickets and audit logs are anonymized (not deleted) to preserve
 * operational integrity.
 *
 * Requires confirmation via a button click to prevent accidental use.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeAuditLog } from '../../services/audit.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('ForgetMe');

export function buildForgetMeCommand() {
  return new SlashCommandBuilder()
    .setName('forgetme')
    .setDescription('Permanently delete ALL your data from this server (irreversible)');
}

export async function handleForgetMeCommand(
  interaction: ChatInputCommandInteraction,
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const userId = interaction.user.id;

  // Show confirmation prompt
  const confirmEmbed = new EmbedBuilder()
    .setTitle('⚠️ Permanent Data Deletion')
    .setDescription(
      'This will **permanently and irreversibly** delete all of your data from this server:\n\n' +
      '• 💰 Economy — wallet, bank, inventory, transactions\n' +
      '• 📊 Levels — XP, level, rank, voice minutes\n' +
      '• 🎯 Progress — quests, achievements, prestige\n' +
      '• 🐾 Pets — all owned pets and battle history\n' +
      '• 🌾 Activities — farm plots, fish catches, adventures\n' +
      '• 🏪 Market — all listings (active ones will be cancelled)\n' +
      '• 🔑 Licenses — all license keys revoked, sessions deactivated\n' +
      '• 🎟️ Entitlements — active entitlements cancelled\n' +
      '• 👤 Profile — custom profile and member record\n' +
      '• 🎫 Tickets — creator info anonymized (transcripts preserved)\n\n' +
      '**This cannot be undone.** Are you sure?',
    )
    .setColor(0xff0000)
    .setFooter({ text: 'This button expires in 30 seconds' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('forgetme_confirm')
      .setLabel('Yes, delete everything')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️'),
    new ButtonBuilder()
      .setCustomId('forgetme_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  const reply = await interaction.editReply({
    embeds: [confirmEmbed],
    components: [row],
  });

  // Wait for confirmation
  try {
    const buttonInteraction = await reply.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === userId,
      time: 30_000,
    });

    if (buttonInteraction.customId === 'forgetme_cancel') {
      await buttonInteraction.update({
        embeds: [
          new EmbedBuilder()
            .setDescription('✅ Cancelled — your data has not been changed.')
            .setColor(0x00ff00),
        ],
        components: [],
      });
      return;
    }

    // User confirmed — execute the purge
    await buttonInteraction.update({
      embeds: [
        new EmbedBuilder()
          .setDescription('🔄 Deleting your data... this may take a moment.')
          .setColor(0xffaa00),
      ],
      components: [],
    });

    // Call the purge RPC
    const { data: result, error } = await supabase.rpc('purge_member_data', {
      p_guild_id: guildId,
      p_user_id: userId,
    });

    if (error) {
      log.error(`purge_member_data failed for ${userId}:`, error.message);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setDescription('❌ An error occurred while deleting your data. Please contact a server administrator.')
            .setColor(0xff0000),
        ],
        components: [],
      });
      return;
    }

    // Build summary of what was deleted
    const summary = result as Record<string, number>;
    const deletedItems = Object.entries(summary)
      .filter(([, count]) => count > 0)
      .map(([table, count]) => `• ${formatTableName(table)}: ${count} record(s)`)
      .join('\n');

    const successEmbed = new EmbedBuilder()
      .setTitle('🗑️ Data Deleted')
      .setDescription(
        'All of your personal data has been permanently deleted from this server.\n\n' +
        (deletedItems
          ? `**Deleted:**\n${deletedItems}`
          : 'No data was found to delete.'),
      )
      .setColor(0x00ff00)
      .setFooter({ text: 'This action is irreversible' });

    await interaction.editReply({
      embeds: [successEmbed],
      components: [],
    });

    // Audit log (anonymized — just records that a purge happened)
    await writeAuditLog(supabase, {
      guildId,
      actorType: 'bot',
      actorId: 'purged_user', // Don't store the user ID — they asked to be forgotten
      action: 'member.data_purged',
      targetType: 'member',
      targetId: 'purged_user',
      details: {
        tables_affected: Object.keys(summary).filter((k) => summary[k]! > 0),
        total_records: Object.values(summary).reduce((a, b) => a + b, 0),
      },
    });

    log.info(`Data purge completed for user in guild ${guildId}`);
  } catch {
    // Timeout — no confirmation received
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setDescription('⏰ Confirmation timed out — your data has not been changed.')
          .setColor(0x808080),
      ],
      components: [],
    });
  }
}

/**
 * Format table names for user-friendly display.
 */
function formatTableName(table: string): string {
  const map: Record<string, string> = {
    economy_wallets: '💰 Wallet',
    economy_transactions: '📝 Transactions',
    economy_inventory: '🎒 Inventory',
    economy_streaks: '🔥 Streaks',
    economy_market_listings: '🏪 Market Listings',
    economy_farm_plots: '🌾 Farm Plots',
    economy_fish_catches: '🐟 Fish Catches',
    economy_adventure_sessions: '⚔️ Adventures',
    // economy_trivia_sessions dropped in v53 (table was unused — trivia uses Valkey)
    economy_lottery_tickets: '🎰 Lottery Tickets',
    economy_pets: '🐾 Pets',
    economy_quest_progress: '🎯 Quest Progress',
    economy_user_achievements: '🏆 Achievements',
    economy_prestige: '⭐ Prestige',
    economy_profiles: '👤 Profile',
    economy_heist_participants: '🏴‍☠️ Heist Participation',
    economy_daily_losses: '📉 Daily Loss Records',
    member_levels: '📊 Level/XP Data',
    members: '👤 Member Record',
    license_keys_revoked: '🔑 License Keys (revoked)',
    entitlements_revoked: '🎟️ Entitlements (cancelled)',
    tickets_anonymized: '🎫 Tickets (anonymized)',
    poll_votes: '🗳️ Poll Votes',
    economy_pet_battles_anonymized: '⚔️ Pet Battles (anonymized)',
    infractions_anonymized: '⚖️ Infractions (anonymized)',
  };
  return map[table] ?? table;
}
