/**
 * Setup Wizard — /setup command + interaction handlers.
 *
 * Single sequential flow: `/setup` → step 1 → step 2 → ... → done.
 * Guild owner only. Progress persisted in Supabase.
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import { SOMNI_PALETTE } from '@somnibot/shared';
import {
  WIZARD_STEPS,
  buildStepEmbed,
  buildStepComponents,
  buildStepModal,
  buildCompletionEmbed,
} from './steps.js';
import {
  loadProgress,
  saveProgress,
  getNextStep,
  detectConfigured,
  storeCredentials,
  enableFeatureFlag,
  type WizardProgress,
} from './wizard-engine.js';

/* ------------------------------------------------------------------ */
/*  Slash command builder                                               */
/* ------------------------------------------------------------------ */

export function buildSetupCommand() {
  return new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Walk through setting up optional services (PayPal, Lavalink, etc.)')
    .setDMPermission(false);
}

/* ------------------------------------------------------------------ */
/*  /setup command handler                                             */
/* ------------------------------------------------------------------ */

export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  // Owner-only gate
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
    return;
  }

  if (interaction.user.id !== guild.ownerId) {
    await interaction.reply({
      content: '🔒 Only the server owner can run `/setup`.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Load progress + detect what's already configured in instance_settings
  const [progress, alreadyConfigured] = await Promise.all([
    loadProgress(client.supabase),
    detectConfigured(client.supabase),
  ]);

  // Merge: anything detected in instance_settings counts as configured
  for (const stepId of alreadyConfigured) {
    if (!progress.configured.includes(stepId)) {
      progress.configured.push(stepId);
    }
  }

  progress.lastRun = new Date().toISOString();
  await saveProgress(client.supabase, progress);

  const configuredSet = new Set(progress.configured);
  const allConfigured = WIZARD_STEPS.every((s) => configuredSet.has(s.id));

  // If everything is already configured, show status + reconfigure option
  if (allConfigured) {
    const statusLines = WIZARD_STEPS.map(
      (s) => `✅ **${s.title}** — connected`,
    ).join('\n');

    const embed = new EmbedBuilder()
      .setColor(SOMNI_PALETTE.HOT_PINK)
      .setTitle('🔧 Setup — All Services Connected')
      .setDescription(`${statusLines}\n\nEverything is configured! Select a service below to reconfigure it.`);

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('setup:reconfigure')
      .setPlaceholder('Select a service to reconfigure...')
      .addOptions(
        WIZARD_STEPS.map((s) => ({
          label: s.title,
          value: s.id,
          emoji: s.emoji,
          description: `Reconfigure ${s.title} credentials`,
        })),
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  // Find next unconfigured step and show it
  const next = getNextStep(progress);
  if (!next) {
    // All done (shouldn't reach here due to check above, but just in case)
    await interaction.editReply({ embeds: [buildCompletionEmbed(configuredSet)] });
    return;
  }

  const embed = buildStepEmbed(next.step, next.index, WIZARD_STEPS.length);
  const components = buildStepComponents(next.step);
  await interaction.editReply({ embeds: [embed], components });
}

/* ------------------------------------------------------------------ */
/*  Button handlers (credentials / skip)                               */
/* ------------------------------------------------------------------ */

export async function handleSetupButton(
  interaction: ButtonInteraction,
  client: SomniClient,
): Promise<void> {
  // Owner-only
  const guild = interaction.guild;
  if (!guild || interaction.user.id !== guild.ownerId) {
    await interaction.reply({ content: '🔒 Only the server owner can use setup.', ephemeral: true });
    return;
  }

  const parts = interaction.customId.split(':'); // setup:<stepId>:<action>
  const stepId = parts[1];
  const action = parts[2];

  const step = WIZARD_STEPS.find((s) => s.id === stepId);
  if (!step) {
    await interaction.reply({ content: '❌ Unknown setup step.', ephemeral: true });
    return;
  }

  if (action === 'credentials') {
    // Show the modal
    const modal = buildStepModal(step);
    await interaction.showModal(modal);
    return;
  }

  if (action === 'skip') {
    await interaction.deferUpdate();

    const progress = await loadProgress(client.supabase);
    if (!progress.skipped.includes(stepId)) {
      progress.skipped.push(stepId);
    }
    await saveProgress(client.supabase, progress);

    // Advance to next step
    await advanceToNextStep(interaction, client, progress);
    return;
  }
}

/* ------------------------------------------------------------------ */
/*  Modal submit handler                                               */
/* ------------------------------------------------------------------ */

export async function handleSetupModal(
  interaction: ModalSubmitInteraction,
  client: SomniClient,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild || interaction.user.id !== guild.ownerId) {
    await interaction.reply({ content: '🔒 Only the server owner can use setup.', ephemeral: true });
    return;
  }

  const parts = interaction.customId.split(':'); // setup:modal:<stepId>
  const stepId = parts[2];

  const step = WIZARD_STEPS.find((s) => s.id === stepId);
  if (!step) {
    await interaction.reply({ content: '❌ Unknown setup step.', ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  // Collect submitted values
  const values: Record<string, string> = {};
  for (const field of step.modalFields) {
    values[field.customId] = interaction.fields.getTextInputValue(field.customId) ?? '';
  }

  // Verify credentials
  const error = await step.verify(values);
  if (error) {
    // Show error embed with retry button (same step)
    const errorEmbed = new EmbedBuilder()
      .setColor(SOMNI_PALETTE.ORANGE)
      .setTitle(`❌ ${step.title} — Verification Failed`)
      .setDescription(error)
      .setFooter({ text: 'Click "I have my credentials" to try again, or skip this step.' });

    const components = buildStepComponents(step);
    await interaction.editReply({ embeds: [errorEmbed], components });
    return;
  }

  // Store credentials in instance_settings + process.env
  await storeCredentials(client.supabase, step, values);

  // Enable feature flag if applicable
  if (step.enableFlag) {
    await enableFeatureFlag(client.supabase, interaction.guildId!, step.enableFlag);
  }

  // Mark step as configured
  const progress = await loadProgress(client.supabase);
  if (!progress.configured.includes(stepId)) {
    progress.configured.push(stepId);
  }
  // Remove from skipped if it was previously skipped then reconfigured
  progress.skipped = progress.skipped.filter((s) => s !== stepId);
  await saveProgress(client.supabase, progress);

  // Quick success acknowledgment, then advance
  const successEmbed = new EmbedBuilder()
    .setColor(0x23a559) // Discord green
    .setTitle(`✅ ${step.title} — Connected!`)
    .setDescription('Credentials verified and stored. Moving on...');

  await interaction.editReply({ embeds: [successEmbed], components: [] });

  // Brief pause so the user sees the success message, then advance
  await new Promise((r) => setTimeout(r, 1500));
  await advanceToNextStep(interaction, client, progress);
}

/* ------------------------------------------------------------------ */
/*  Reconfigure select menu handler                                    */
/* ------------------------------------------------------------------ */

export async function handleReconfigureSelect(
  interaction: StringSelectMenuInteraction,
  client: SomniClient,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild || interaction.user.id !== guild.ownerId) {
    await interaction.reply({ content: '🔒 Only the server owner can use setup.', ephemeral: true });
    return;
  }

  const stepId = interaction.values[0];
  const step = WIZARD_STEPS.find((s) => s.id === stepId);
  if (!step) {
    await interaction.reply({ content: '❌ Unknown step.', ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  // Remove from configured/skipped so it appears as a fresh step
  const progress = await loadProgress(client.supabase);
  progress.configured = progress.configured.filter((s) => s !== stepId);
  progress.skipped = progress.skipped.filter((s) => s !== stepId);
  await saveProgress(client.supabase, progress);

  // Show the step
  const stepIndex = WIZARD_STEPS.findIndex((s) => s.id === stepId);
  const embed = buildStepEmbed(step, stepIndex, WIZARD_STEPS.length);
  const components = buildStepComponents(step);
  await interaction.editReply({ embeds: [embed], components });
}

/* ------------------------------------------------------------------ */
/*  Internal: advance to next step or show completion                   */
/* ------------------------------------------------------------------ */

async function advanceToNextStep(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  client: SomniClient,
  progress: WizardProgress,
): Promise<void> {
  const next = getNextStep(progress);

  if (!next) {
    // All steps done — show completion
    const configuredSet = new Set(progress.configured);
    const embed = buildCompletionEmbed(configuredSet);

    // Add a reconfigure option after completion too
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('setup:reconfigure')
      .setPlaceholder('Reconfigure a service...')
      .addOptions(
        WIZARD_STEPS.map((s) => ({
          label: s.title,
          value: s.id,
          emoji: s.emoji,
          description: `Reconfigure ${s.title} credentials`,
        })),
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  const embed = buildStepEmbed(next.step, next.index, WIZARD_STEPS.length);
  const components = buildStepComponents(next.step);
  await interaction.editReply({ embeds: [embed], components });
}
