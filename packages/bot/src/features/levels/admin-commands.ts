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

      // Fetch current
      const { data: existing } = await client.supabase
        .from('member_levels')
        .select('xp, level')
        .eq('guild_id', guildId)
        .eq('member_id', targetUser.id)
        .maybeSingle();

      const oldXp = existing?.xp ?? 0;
      const newXp = oldXp + amount;
      const newLevel = calculateLevel(newXp);

      await client.supabase.from('member_levels').upsert(
        {
          guild_id: guildId,
          member_id: targetUser.id,
          xp: newXp,
          level: newLevel,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'guild_id,member_id' },
      );

      await interaction.editReply(
        `✅ Added **${amount.toLocaleString()} XP** to <@${targetUser.id}>. New total: **${newXp.toLocaleString()} XP** (Level ${newLevel}).`,
      );
      break;
    }

    case 'remove': {
      const amount = interaction.options.getInteger('amount', true);

      const { data: existing } = await client.supabase
        .from('member_levels')
        .select('xp, level')
        .eq('guild_id', guildId)
        .eq('member_id', targetUser.id)
        .maybeSingle();

      const oldXp = existing?.xp ?? 0;
      const newXp = Math.max(0, oldXp - amount);
      const newLevel = calculateLevel(newXp);

      await client.supabase.from('member_levels').upsert(
        {
          guild_id: guildId,
          member_id: targetUser.id,
          xp: newXp,
          level: newLevel,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'guild_id,member_id' },
      );

      await interaction.editReply(
        `✅ Removed **${amount.toLocaleString()} XP** from <@${targetUser.id}>. New total: **${newXp.toLocaleString()} XP** (Level ${newLevel}).`,
      );
      break;
    }

    case 'set': {
      const amount = interaction.options.getInteger('amount', true);
      const newLevel = calculateLevel(amount);

      await client.supabase.from('member_levels').upsert(
        {
          guild_id: guildId,
          member_id: targetUser.id,
          xp: amount,
          level: newLevel,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'guild_id,member_id' },
      );

      await interaction.editReply(
        `✅ Set <@${targetUser.id}>'s XP to **${amount.toLocaleString()}** (Level ${newLevel}).`,
      );
      break;
    }

    case 'reset': {
      await client.supabase.from('member_levels').upsert(
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

      await interaction.editReply(`✅ Reset <@${targetUser.id}>'s XP to zero.`);
      break;
    }
  }
}
