/**
 * Ticket Slash Commands — /ticket close, /ticket add, /ticket remove, etc.
 *
 * Architecture doc §19
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import { closeTicket, addUserToTicket, removeUserFromTicket } from './ticket-service.js';
import { canMemberManageTicket, emitTicketDenied, ticketDeniedMessage } from './ticket-authz.js';
import { generateTranscript } from './transcript-generator.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('TicketCmds');

// ── Command Definition ───────────────────────────────────

export const ticketCommand = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Manage tickets')
  .addSubcommand((sub) =>
    sub
      .setName('close')
      .setDescription('Close the current ticket')
      .addStringOption((opt) =>
        opt.setName('reason').setDescription('Reason for closing').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a user to this ticket')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('User to add').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a user from this ticket')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('User to remove').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('transcript')
      .setDescription('Generate a transcript of this ticket'),
  )
  .toJSON();

// ── Command Handler ──────────────────────────────────────

export async function handleTicketCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;

  const subcommand = interaction.options.getSubcommand();

  // Find the ticket for the current channel
  const { data: ticket } = await client.supabase
    .from('tickets')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('channel_id', interaction.channelId)
    .in('status', ['open', 'claimed'])
    .single();

  if (!ticket) {
    await interaction.reply({
      content: '❌ This channel is not an open ticket.',
      ephemeral: true,
    });
    return;
  }

  switch (subcommand) {
    case 'close': {
      // The creator may close their own ticket; anyone else must be a manager.
      if (!(await canMemberManageTicket(client.supabase, interaction.member, ticket, 'close', interaction.user.id))) {
        emitTicketDenied(client.eventBus, guild.id, ticket, interaction.user.id);
        await interaction.reply({ content: ticketDeniedMessage('close'), ephemeral: true });
        return;
      }

      await interaction.deferReply();
      const reason = interaction.options.getString('reason') || undefined;

      // Generate transcript before closing
      const transcriptResult = await generateTranscript(guild, ticket, client.supabase, client.eventBus);
      if (!transcriptResult.success) {
        log.warn('Transcript generation failed during close:', transcriptResult.error);
      }

      const result = await closeTicket(
        guild,
        client.supabase,
        client.eventBus,
        ticket.ticket_number,
        interaction.user.id,
        reason,
      );

      if (!result.success) {
        await interaction.editReply(`❌ ${result.error}`);
        return;
      }

      await interaction.editReply('✅ Ticket closed.');
      break;
    }

    case 'add': {
      if (!(await canMemberManageTicket(client.supabase, interaction.member, ticket, 'add', interaction.user.id))) {
        emitTicketDenied(client.eventBus, guild.id, ticket, interaction.user.id);
        await interaction.reply({ content: ticketDeniedMessage('add'), ephemeral: true });
        return;
      }

      const user = interaction.options.getUser('user', true);
      const result = await addUserToTicket(guild, client.supabase, ticket.ticket_number, user.id);

      if (!result.success) {
        await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        return;
      }

      await interaction.reply(`✅ Added <@${user.id}> to this ticket.`);
      break;
    }

    case 'remove': {
      if (!(await canMemberManageTicket(client.supabase, interaction.member, ticket, 'remove', interaction.user.id))) {
        emitTicketDenied(client.eventBus, guild.id, ticket, interaction.user.id);
        await interaction.reply({ content: ticketDeniedMessage('remove'), ephemeral: true });
        return;
      }

      const user = interaction.options.getUser('user', true);
      const result = await removeUserFromTicket(guild, client.supabase, ticket.ticket_number, user.id);

      if (!result.success) {
        await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        return;
      }

      await interaction.reply(`✅ Removed <@${user.id}> from this ticket.`);
      break;
    }

    case 'transcript': {
      await interaction.deferReply({ ephemeral: true });
      const result = await generateTranscript(guild, ticket, client.supabase, client.eventBus);

      if (!result.success) {
        await interaction.editReply(`❌ ${result.error}`);
        return;
      }

      await interaction.editReply('✅ Transcript generated and saved.');
      break;
    }
  }
}
