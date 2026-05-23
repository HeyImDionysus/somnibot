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
  type ModalSubmitInteraction,
  type Interaction,
  EmbedBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type ModalActionRowComponentBuilder,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import type { DbTicketPanel, TicketTypeConfig } from '@somnibot/shared';
import { createTicket, claimTicket, closeTicket, reopenTicket, deleteTicket } from './ticket-service.js';
import { generateTranscript } from './transcript-generator.js';
import { SOMNI_PALETTE , createLogger } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';

const log = createLogger('TicketInteractions');

interface IntakeFormField {
  label: string;
  placeholder?: string;
  style?: 'short' | 'paragraph';
  required?: boolean;
  min_length?: number;
  max_length?: number;
}

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

    if (customId.startsWith('ticket:feedback:')) {
      await handleTicketFeedback(interaction, client);
      return true;
    }
  }

  // Handle modal submissions for ticket intake
  if (interaction.isModalSubmit()) {
    const customId = interaction.customId;
    if (customId.startsWith('ticket_intake:')) {
      await handleIntakeModalSubmit(interaction, client);
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
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
    return;
  }

  // Fetch panel from DB
  const { data: panel, error: panelErr } = await client.supabase
    .from('ticket_panels')
    .select('*')
    .eq('id', panelId)
    .single();

  if (panelErr || !panel) {
    await interaction.reply({ content: '❌ Ticket panel not found. It may have been deleted.', ephemeral: true });
    return;
  }

  if (!panel.active) {
    await interaction.reply({ content: '❌ This ticket panel is currently disabled.', ephemeral: true });
    return;
  }

  // Find ticket type
  const ticketTypes = (panel.ticket_types || []) as TicketTypeConfig[];
  const ticketType = ticketTypes.find((t) => t.id === typeId);
  if (!ticketType) {
    await interaction.reply({ content: '❌ Invalid ticket type.', ephemeral: true });
    return;
  }

  // Check if intake form is enabled
  const intakeFields = (panel.intake_form_fields || []) as IntakeFormField[];
  if (panel.intake_form_enabled && intakeFields.length > 0) {
    // Show intake modal instead of immediately creating the ticket
    const modal = new ModalBuilder()
      .setCustomId(`ticket_intake:${panelId}:${typeId}`)
      .setTitle(`${ticketType.label} — Details`);

    // Add up to 5 fields (Discord modal limit)
    const fieldsToShow = intakeFields.slice(0, 5);
    for (let i = 0; i < fieldsToShow.length; i++) {
      const field = fieldsToShow[i]!;
      const input = new TextInputBuilder()
        .setCustomId(`field_${i}`)
        .setLabel(field.label.slice(0, 45))
        .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(field.required !== false)
        .setPlaceholder(field.placeholder || '');

      if (field.min_length) input.setMinLength(field.min_length);
      if (field.max_length) input.setMaxLength(field.max_length);

      const row = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(input);
      modal.addComponents(row);
    }

    await interaction.showModal(modal);
    return;
  }

  // No intake form — create ticket directly (original flow)
  await interaction.deferReply({ ephemeral: true });

  const member = await guild.members.fetch(interaction.user.id);

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
    log.warn(`Delete ticket #${ticketNumber} result: ${result.error}`);
  }
}

// ── Intake Modal Submit ──────────────────────────────────

async function handleIntakeModalSubmit(
  interaction: ModalSubmitInteraction,
  client: SomniClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply('❌ This command can only be used in a server.');
    return;
  }

  // Parse panelId and typeId from customId: ticket_intake:{panelId}:{typeId}
  const parts = interaction.customId.split(':');
  const panelId = parts[1];
  const typeId = parts[2];

  if (!panelId || !typeId) {
    await interaction.editReply('❌ Invalid form submission.');
    return;
  }

  const member = await guild.members.fetch(interaction.user.id);

  // Fetch panel
  const { data: panel, error: panelErr } = await client.supabase
    .from('ticket_panels')
    .select('*')
    .eq('id', panelId)
    .single();

  if (panelErr || !panel) {
    await interaction.editReply('❌ Ticket panel not found.');
    return;
  }

  const ticketTypes = (panel.ticket_types || []) as TicketTypeConfig[];
  const ticketType = ticketTypes.find((t) => t.id === typeId);
  if (!ticketType) {
    await interaction.editReply('❌ Invalid ticket type.');
    return;
  }

  // Create the ticket
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

  // Post the intake form responses into the ticket channel
  const intakeFields = (panel.intake_form_fields || []) as IntakeFormField[];
  const responses: string[] = [];

  for (let i = 0; i < intakeFields.length; i++) {
    const field = intakeFields[i]!;
    const value = interaction.fields.getTextInputValue(`field_${i}`).trim();
    if (value) {
      responses.push(`**${field.label}:**\n${value}`);
    }
  }

  if (responses.length > 0) {
    const intakeEmbed = new EmbedBuilder()
      .setColor(SOMNI_PALETTE.CYAN)
      .setTitle('📝 Intake Form Responses')
      .setDescription(responses.join('\n\n'))
      .setTimestamp()
      .setFooter({ text: `Submitted by ${interaction.user.tag}` });

    await result.channel.send({ embeds: [intakeEmbed] });
  }

  await interaction.editReply(
    `✅ Your ticket has been created: <#${result.channel.id}>`,
  );
}

// ── Ticket Feedback ──────────────────────────────────────

async function handleTicketFeedback(
  interaction: ButtonInteraction,
  client: SomniClient,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;

  // Format: ticket:feedback:{ticketNumber}:{rating}
  const parts = interaction.customId.split(':');
  const ticketNumber = parseInt(parts[2], 10);
  const rating = parseInt(parts[3], 10);

  if (isNaN(ticketNumber) || isNaN(rating) || rating < 1 || rating > 5) {
    await interaction.reply({ content: '❌ Invalid feedback.', ephemeral: true });
    return;
  }

  // Verify this is the ticket creator
  const { data: ticket } = await client.supabase
    .from('tickets')
    .select('creator_id')
    .eq('guild_id', guild.id)
    .eq('ticket_number', ticketNumber)
    .single();

  if (!ticket || ticket.creator_id !== interaction.user.id) {
    await interaction.reply({ content: '❌ Only the ticket creator can leave feedback.', ephemeral: true });
    return;
  }

  // Save feedback
  await client.supabase
    .from('tickets')
    .update({
      feedback_rating: rating,
    })
    .eq('guild_id', guild.id)
    .eq('ticket_number', ticketNumber);

  const stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
  await interaction.reply({ content: `Thank you for your feedback! ${stars}`, ephemeral: true });

  // Disable the feedback buttons by editing the original message
  try {
    await interaction.message.edit({ components: [] });
  } catch {
    // Message may not be editable
  }
}
