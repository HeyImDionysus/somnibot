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
import { writeAuditLog } from '../../services/audit.js';
import { calculateLevel , createLogger } from '@somnibot/shared';

const log = createLogger('XPAdmin');

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
  const guildId = interaction.guildId!;

  // Defense-in-depth authorization re-check. setDefaultMemberPermissions(ManageGuild)
  // is the primary gate for the default (un-overridden) case, but a guild owner can
  // override per-command permissions in Server Settings → Integrations and grant /xp
  // to arbitrary roles/members. Re-verify Manage-Guild in the handler so that override
  // cannot silently confer XP-mutation power, and record the denied attempt.
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await writeAuditLog(client.supabase, {
      guildId,
      actorType: 'discord',
      actorId: interaction.user.id,
      action: 'levels.xp_admin.denied',
      targetType: 'member',
      targetId: targetUser.id,
      success: false,
      details: { subcommand: sub, reason: 'missing_manage_guild' },
    });
    await interaction.editReply('🚫 You need the **Manage Server** permission to use `/xp` admin commands.');
    return;
  }

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
        log.error('increment_member_xp failed:', rpcErr?.message);
        await interaction.editReply('❌ Failed to add XP. Please try again.');
        break;
      }

      client.eventBus.emit('xp.admin_adjusted', guildId, {
        actorId: interaction.user.id,
        targetId: targetUser.id,
        operation: 'add',
        amount,
        newXp: result.new_xp as number,
        newLevel: result.new_level as number,
      });

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
        log.error('increment_member_xp failed:', rpcErr?.message);
        await interaction.editReply('❌ Failed to remove XP. Please try again.');
        break;
      }

      // Ensure XP doesn't go below 0 (RPC may handle this, but recalculate display)
      const newXp = Math.max(0, result.new_xp as number);
      const newLevel = result.new_level as number;

      client.eventBus.emit('xp.admin_adjusted', guildId, {
        actorId: interaction.user.id,
        targetId: targetUser.id,
        operation: 'remove',
        amount,
        newXp,
        newLevel,
      });

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
        log.error('set upsert failed:', setErr.message);
        await interaction.editReply('❌ Failed to set XP. Please try again.');
        break;
      }

      client.eventBus.emit('xp.admin_adjusted', guildId, {
        actorId: interaction.user.id,
        targetId: targetUser.id,
        operation: 'set',
        amount,
        newXp: amount,
        newLevel,
      });

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
        log.error('reset upsert failed:', resetErr.message);
        await interaction.editReply('❌ Failed to reset XP. Please try again.');
        break;
      }

      client.eventBus.emit('xp.admin_adjusted', guildId, {
        actorId: interaction.user.id,
        targetId: targetUser.id,
        operation: 'reset',
        amount: 0,
        newXp: 0,
        newLevel: 0,
      });

      await interaction.editReply(`✅ Reset <@${targetUser.id}>'s XP to zero.`);
      break;
    }
  }
}
