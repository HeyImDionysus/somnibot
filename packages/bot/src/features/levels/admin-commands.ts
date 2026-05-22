/**
 * Admin XP Commands — /xp add, /xp set, /xp remove, /xp reset
 *
 * V17 Behavioral Audit — Item 5
 *
 * Allows admins to manually adjust member XP.
 * Also adds No-XP role awareness to the XP tracker.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import { calculateLevel } from '@somnibot/shared';

/**
 * Build the /xp slash command with admin subcommands.
 */
export function buildXpAdminCommands() {
  return new SlashCommandBuilder()
    .setName('xp')
    .setDescription('Admin XP management commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add XP to a member')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Target member').setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt.setName('amount').setDescription('XP to add').setRequired(true).setMinValue(1).setMaxValue(1000000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove XP from a member')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Target member').setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt.setName('amount').setDescription('XP to remove').setRequired(true).setMinValue(1).setMaxValue(1000000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Set a member\'s XP to a specific value')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Target member').setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt.setName('amount').setDescription('XP value to set').setRequired(true).setMinValue(0).setMaxValue(10000000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Reset a member\'s XP to zero')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Target member').setRequired(true),
        ),
    );
}

/**
 * Handle /xp command — routes to the appropriate subcommand.
 */
export async function handleXpAdminCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();
  const targetUser = interaction.options.getUser('user', true);
  const guildId = client.guildId;

  switch (sub) {
    case 'add': {
      const amount = interaction.options.getInteger('amount', true);

      // V51: use atomic RPC instead of read-then-write to prevent race conditions
      const { data: result, error: rpcErr } = await client.supabase.rpc('increment_member_xp', {
        p_guild_id: guildId,
        p_member_id: targetUser.id,
        p_xp_amount: amount,
        p_increment_messages: false,
        p_voice_minutes: 0,
      });

      if (rpcErr || !result) {
        console.error('[XP Admin] increment_member_xp failed:', rpcErr?.message);
        await interaction.editReply('❌ Failed to add XP. Please try again.');
        break;
      }

      await interaction.editReply(
        `✅ Added **${amount.toLocaleString()} XP** to <@${targetUser.id}>. New total: **${(result.new_xp as number).toLocaleString()} XP** (Level ${result.new_level}).`,
      );
      break;
    }

    case 'remove': {
      const amount = interaction.options.getInteger('amount', true);

      // V51: use atomic RPC with negative amount to prevent race conditions
      const { data: result, error: rpcErr } = await client.supabase.rpc('increment_member_xp', {
        p_guild_id: guildId,
        p_member_id: targetUser.id,
        p_xp_amount: -amount,
        p_increment_messages: false,
        p_voice_minutes: 0,
      });

      if (rpcErr || !result) {
        console.error('[XP Admin] increment_member_xp failed:', rpcErr?.message);
        await interaction.editReply('❌ Failed to remove XP. Please try again.');
        break;
      }

      // Ensure XP doesn't go below 0 (RPC may handle this, but recalculate display)
      const newXp = Math.max(0, result.new_xp as number);
      const newLevel = result.new_level as number;

      await interaction.editReply(
        `✅ Removed **${amount.toLocaleString()} XP** from <@${targetUser.id}>. New total: **${newXp.toLocaleString()} XP** (Level ${newLevel}).`,
      );
      break;
    }

    case 'set': {
      const amount = interaction.options.getInteger('amount', true);
      const newLevel = calculateLevel(amount);

      // V51: check upsert error
      const { error: setErr } = await client.supabase.from('member_levels').upsert(
        {
          guild_id: guildId,
          member_id: targetUser.id,
          xp: amount,
          level: newLevel,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'guild_id,member_id' },
      );

      if (setErr) {
        console.error('[XP Admin] set upsert failed:', setErr.message);
        await interaction.editReply('❌ Failed to set XP. Please try again.');
        break;
      }

      await interaction.editReply(
        `✅ Set <@${targetUser.id}>'s XP to **${amount.toLocaleString()}** (Level ${newLevel}).`,
      );
      break;
    }

    case 'reset': {
      // V51: check upsert error
      const { error: resetErr } = await client.supabase.from('member_levels').upsert(
        {
          guild_id: guildId,
          member_id: targetUser.id,
          xp: 0,
          level: 0,
          total_messages: 0,
          voice_minutes: 0,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'guild_id,member_id' },
      );

      if (resetErr) {
        console.error('[XP Admin] reset upsert failed:', resetErr.message);
        await interaction.editReply('❌ Failed to reset XP. Please try again.');
        break;
      }

      await interaction.editReply(`✅ Reset <@${targetUser.id}>'s XP to zero.`);
      break;
    }
  }
}
