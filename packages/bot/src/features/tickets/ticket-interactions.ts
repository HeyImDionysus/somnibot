/**
 * Ticket Interactions — Handles button and dropdown interactions from ticket panels.
 *
 * Custom ID formats:
 *   panel:open:{panelId}:{typeId}    — Button click to open ticket
 *   panel:open:{panelId}             — Dropdown selection to open ticket (value = typeId)
 *   ticket:close:{ticketNumber}      — Close ticket button
 *   ticket:claim:{ticketNumber}      — Claim ticket button
 *   ticket:transcript:{ticketNumber} — Generate transcript button
 *   ticket:reopen:{ticketNumber}     — Reopen closed ticket button
 *   ticket:delete:{ticketNumber}     — Delete ticket button
 */

import {
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type Interaction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import type { DbTicketPanel, TicketTypeConfig } from '@somnibot/shared';
import { createTicket, claimTicket, closeTicket, reopenTicket, deleteTicket } from './ticket-service.js';
import { generateTranscript } from './transcript-generator.js';
import { SOMNI_PALETTE } from '@somnibot/shared';

// ── Main Router ──────────────────────────────────────────

export async function handleTicketInteraction(
  interaction: Interaction,
  client: SomniClient,
): Promise<boolean> {
  // Handle button interactions
  if (interaction.isButton()) {
    const customId = interaction.customId;

    if (customId.startsWith('panel:open:')) {
      await handlePanelButtonOpen(interaction, client);
      return true;
    }

    if (customId.startsWith('ticket:close:')) {
      await handleTicketClose(interaction, client);
      return true;
    }

    if (customId.startsWith('ticket:claim:')) {
      await handleTicketClaim(interaction, client);
      return true;
    }

    if (customId.startsWith('ticket:transcript:')) {
      await handleTicketTranscript(interaction, client);
      return true;
    }

    if (customId.startsWith('ticket:reopen:')) {
      await handleTicketReopen(interaction, client);
      return true;
    }

    if (customId.startsWith('ticket:delete:')) {
      await handleTicketDelete(interaction, client);
      return true;
    }
  }

  // Handle dropdown interactions
  if (interaction.isStringSelectMenu()) {
    const customId = interaction.customId;

    if (customId.startsWith('panel:open:')) {
      await handlePanelDropdownOpen(interaction, client);
      return true;
    }
  }

  return false;
}

// ── Panel Button Open ────────────────────────────────────

async function handlePanelButtonOpen(
  interaction: ButtonInteraction,
  client: SomniClient,
): Promise<void> {
  const parts = interaction.customId.split(':');
  // panel:open:{panelId}:{typeId}
  const panelId = parts[2];
  const typeId = parts[3];

  if (!panelId || !typeId) {
    await interaction.reply({ content: '❌ Invalid panel configuration.', ephemeral: true });
    return;
  }

  await openTicketFromPanel(interaction, client, panelId, typeId);
}

// ── Panel Dropdown Open ──────────────────────────────────

async function handlePanelDropdownOpen(
  interaction: StringSelectMenuInteraction,
  client: SomniClient,
): Promise<void> {
  const parts = interaction.customId.split(':');
  // panel:open:{panelId}
  const panelId = parts[2];
  const typeId = interaction.values[0];

  if (!panelId || !typeId) {
    await interaction.reply({ content: '❌ Invalid selection.', ephemeral: true });
    return;
  }

  await openTicketFromPanel(interaction, client, panelId, typeId);
}

// ── Open Ticket from Panel ───────────────────────────────

async function openTicketFromPanel(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  client: SomniClient,
  panelId: string,
  typeId: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply('❌ This command can only be used in a server.');
    return;
  }

  const member = await guild.members.fetch(interaction.user.id);

  // Fetch panel from DB
  const { data: panel, error: panelErr } = await client.supabase
    .from('ticket_panels')
    .select('*')
    .eq('id', panelId)
    .single();

  if (panelErr || !panel) {
    await interaction.editReply('❌ Ticket panel not found. It may have been deleted.');
    return;
  }

  if (!panel.active) {
    await interaction.editReply('❌ This ticket panel is currently disabled.');
    return;
  }

  // Find ticket type
  const ticketTypes = (panel.ticket_types || []) as TicketTypeConfig[];
  const ticketType = ticketTypes.find((t) => t.id === typeId);
  if (!ticketType) {
    await interaction.editReply('❌ Invalid ticket type.');
    return;
  }

  const result = await createTicket(
    guild,
    member,
    panel as DbTicketPanel,
    ticketType,
    client.supabase,
    client.eventBus,
  );

  if ('error' in result) {
    await interaction.editReply(`❌ ${result.error}`);
    return;
  }

  await interaction.editReply(
    `✅ Your ticket has been created: <#${result.channel.id}>`,
  );
}

// ── Ticket Close ─────────────────────────────────────────

async function handleTicketClose(
  interaction: ButtonInteraction,
  client: SomniClient,
): Promise<void> {
  await interaction.deferReply();

  const guild = interaction.guild;
  if (!guild) return;

  const ticketNumber = parseInt(interaction.customId.split(':')[2], 10);
  if (isNaN(ticketNumber)) {
    await interaction.editReply('❌ Invalid ticket.');
    return;
  }

  // Fetch ticket to generate transcript before closing
  const { data: ticket } = await client.supabase
    .from('tickets')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('ticket_number', ticketNumber)
    .single();

  if (ticket && (ticket.status === 'open' || ticket.status === 'claimed')) {
    // Generate transcript before closing
    await generateTranscript(guild, ticket, client.supabase);
  }

  const result = await closeTicket(
    guild,
    client.supabase,
    client.eventBus,
    ticketNumber,
    interaction.user.id,
  );

  if (!result.success) {
    await interaction.editReply(`❌ ${result.error}`);
    return;
  }

  await interaction.editReply('✅ Ticket closed. Transcript saved.');
}

// ── Ticket Claim ─────────────────────────────────────────

async function handleTicketClaim(
  interaction: ButtonInteraction,
  client: SomniClient,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;

  const ticketNumber = parseInt(interaction.customId.split(':')[2], 10);
  if (isNaN(ticketNumber)) {
    await interaction.reply({ content: '❌ Invalid ticket.', ephemeral: true });
    return;
  }

  const result = await claimTicket(
    client.supabase,
    client.eventBus,
    guild.id,
    ticketNumber,
    interaction.user.id,
  );

  if (!result.success) {
    await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
    return;
  }

  const claimEmbed = new EmbedBuilder()
    .setColor(SOMNI_PALETTE.CYAN)
    .setDescription(`🙋 **Ticket claimed by <@${interaction.user.id}>**`)
    .setTimestamp();

  await interaction.reply({ embeds: [claimEmbed] });
}

// ── Ticket Transcript ────────────────────────────────────

async function handleTicketTranscript(
  interaction: ButtonInteraction,
  client: SomniClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  if (!guild) return;

  const ticketNumber = parseInt(interaction.customId.split(':')[2], 10);
  if (isNaN(ticketNumber)) {
    await interaction.editReply('❌ Invalid ticket.');
    return;
  }

  const { data: ticket } = await client.supabase
    .from('tickets')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('ticket_number', ticketNumber)
    .single();

  if (!ticket) {
    await interaction.editReply('❌ Ticket not found.');
    return;
  }

  const result = await generateTranscript(guild, ticket, client.supabase);

  if (!result.success) {
    await interaction.editReply(`❌ ${result.error}`);
    return;
  }

  await interaction.editReply('✅ Transcript generated and saved.');
}

// ── Ticket Reopen ────────────────────────────────────────

async function handleTicketReopen(
  interaction: ButtonInteraction,
  client: SomniClient,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;

  const ticketNumber = parseInt(interaction.customId.split(':')[2], 10);
  if (isNaN(ticketNumber)) {
    await interaction.reply({ content: '❌ Invalid ticket.', ephemeral: true });
    return;
  }

  const result = await reopenTicket(
    guild,
    client.supabase,
    client.eventBus,
    ticketNumber,
    interaction.user.id,
  );

  if (!result.success) {
    await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
    return;
  }

  await interaction.reply('✅ Ticket reopened.');
}

// ── Ticket Delete ────────────────────────────────────────

async function handleTicketDelete(
  interaction: ButtonInteraction,
  client: SomniClient,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;

  // Only allow managers to delete
  const member = await guild.members.fetch(interaction.user.id);
  if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: '❌ Only staff with Manage Channels permission can delete tickets.',
      ephemeral: true,
    });
    return;
  }

  const ticketNumber = parseInt(interaction.customId.split(':')[2], 10);
  if (isNaN(ticketNumber)) {
    await interaction.reply({ content: '❌ Invalid ticket.', ephemeral: true });
    return;
  }

  await interaction.reply('🗑️ Deleting ticket...');

  const result = await deleteTicket(guild, client.supabase, ticketNumber);

  if (!result.success) {
    // Channel might already be deleted
    console.warn(`[Tickets] Delete ticket #${ticketNumber} result: ${result.error}`);
  }
}
