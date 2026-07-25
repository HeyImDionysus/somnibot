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
import { SOMNI_PALETTE, createLogger } from '@somnibot/shared';
import {
  WIZARD_STEPS,
  buildStepEmbed,
  buildStepComponents,
  buildStepModal,
  buildCompletionEmbed,
  paypalApiBase,
  type DashboardProbe,
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

// Every wizard interaction is logged (never credential values). The operator
// reports "setup is broken" from what they SEE; without these lines there was
// nothing on our side to line their report up against.
const log = createLogger('SetupWizard');

/* ------------------------------------------------------------------ */
/*  Slash command builder                                               */
/* ------------------------------------------------------------------ */

export function buildSetupCommand() {
  return new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Set up SomniBot — database, hosting and payments, guided step by step')
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

  log.info('/setup opened', {
    user: interaction.user.id,
    configured: [...configuredSet].join(','),
    allConfigured,
  });

  // ALWAYS open on an overview of every step.
  //
  // This used to jump straight to the first *unconfigured* step, which meant
  // any step whose values already existed in instance_settings was silently
  // skipped — and config-loader seeds instance_settings from .env, so an
  // operator with a populated .env was marched past steps they had never seen
  // and could not review or change. A setup wizard must never hide a step it
  // has decided is done on the operator's behalf; show the state and let them
  // choose.
  // Probes the saved dashboard URL rather than trusting that "we stored a value"
  // means "it works" — a green check next to an unreachable dashboard is the
  // single most misleading thing this screen can say.
  const statusLines = buildStatusLines(configuredSet, await probeLiveStatus(configuredSet));

  const embed = new EmbedBuilder()
    .setColor(SOMNI_PALETTE.HOT_PINK)
    .setTitle(allConfigured ? '🔧 Setup — All Services Connected' : '🔧 Setup')
    .setDescription(
      `${statusLines}\n\n`
      + (allConfigured
        ? 'Everything is configured. Pick any service below to review or change it.'
        : 'Pick any service below to configure it — including ones already marked '
          + 'configured, if you want to check or change what is stored.'),
    );

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('setup:reconfigure')
    .setPlaceholder('Select a service to configure...')
    .addOptions(
      WIZARD_STEPS.map((s) => ({
        label: s.title,
        value: s.id,
        emoji: s.emoji,
        description: configuredSet.has(s.id)
          ? `Review or change ${s.title}`
          : `Set up ${s.title}`,
      })),
    );

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
  ];

  // Keep the guided path available: continue from the first step still to do.
  // Guard on `next?.step` rather than `next`: a sentinel return value (e.g. -1)
  // is truthy and would blow up on property access.
  const next = getNextStep(progress);
  if (next?.step) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`setup:${next.step.id}:goto`)
          .setLabel(`Continue — ${next.step.title}`)
          .setEmoji('➡️')
          .setStyle(ButtonStyle.Primary),
      ),
    );
  }

  await interaction.editReply({ embeds: [embed], components: rows });
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
    log.warn('Button for unknown step', { customId: interaction.customId });
    await interaction.reply({ content: '❌ Unknown setup step.', ephemeral: true });
    return;
  }

  log.info('Button pressed', { step: step.id, action });

  if (action === 'credentials') {
    // Show the modal
    const modal = buildStepModal(step);
    await interaction.showModal(modal);
    return;
  }

  // Turn on a Tailscale Funnel and store the public URL it produces, so the
  // operator gets a working HTTPS callback address without leaving Discord.
  if (action === 'tailscale') {
    await interaction.deferUpdate();
    const { enableFunnel } = await import('./tailscale.js');
    const info = await enableFunnel();
    log.info('Tailscale funnel attempt', {
      state: info.state,
      publicUrl: info.publicUrl ?? 'none',
      detail: info.detail?.slice(0, 150) ?? 'none',
    });

    if (info.state === 'funnel-active' && info.publicUrl) {
      // Persist it exactly as if it had been typed into the step's field, so
      // the normal verification + Supabase auth wiring runs too.
      const values: Record<string, string> = { dashboard_url: info.publicUrl };
      const failure = await step.verify(values);
      if (!failure) {
        log.info('Funnel URL verified and stored', { step: step.id, url: info.publicUrl });
        await storeCredentials(client.supabase, step, values);
        const progress = await loadProgress(client.supabase);
        if (!progress.configured.includes(step.id)) progress.configured.push(step.id);
        await saveProgress(client.supabase, progress);

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x23a559)
              .setTitle('✅ Tailscale Funnel is on')
              .setDescription(
                `Your dashboard is now reachable at:\n\`${info.publicUrl}\`\n\n`
                + `${step.successNote?.(values) ?? ''}`,
              ),
          ],
          components: buildOverviewComponents(progress),
        });
        return;
      }
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(SOMNI_PALETTE.ORANGE)
            .setTitle('⚠️ Funnel started, but the URL did not verify')
            .setDescription(`\`${info.publicUrl}\`\n\n${failure}`),
        ],
        components: buildStepComponents(step),
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(SOMNI_PALETTE.ORANGE)
          .setTitle('Tailscale is not ready yet')
          .setDescription(
            info.detail
            ?? 'Could not start a Tailscale Funnel. Set a public HTTPS URL manually instead.',
          ),
      ],
      components: buildStepComponents(step),
    });
    return;
  }

  // "Continue" from the overview: open this step's instructions.
  if (action === 'goto') {
    await interaction.deferUpdate();
    const index = WIZARD_STEPS.findIndex((s) => s.id === stepId);
    await interaction.editReply({
      embeds: [buildStepEmbed(step, index, WIZARD_STEPS.length)],
      components: buildStepComponents(step),
    });
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
    // The exact text the operator is looking at, so a report of "it failed"
    // maps to a line here instead of a guessing game.
    log.warn('Step verification FAILED', { step: step.id, shown: error.slice(0, 200) });
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

  log.info('Step verified and stored', {
    step: step.id,
    warnings: [values.__auth_note, values.__paypal_note, values.__unreachable]
      .filter(Boolean).join(' | ') || 'none',
  });
  // Store credentials in instance_settings + process.env
  log.info('Step verified and stored', {
    step: step.id,
    warnings: [values.__auth_note, values.__paypal_note, values.__unreachable]
      .filter(Boolean).join(' | ') || 'none',
  });
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
  // A step may have follow-up the operator genuinely has to do by hand; show
  // it here, where it is actionable, rather than in the pre-step instructions.
  const note = step.successNote?.(values) ?? null;

  const configuredSet = new Set(progress.configured);
  const remaining = WIZARD_STEPS.filter((s) => !configuredSet.has(s.id));

  const successEmbed = new EmbedBuilder()
    .setColor(0x23a559) // Discord green
    .setTitle(`✅ ${step.title} — Connected!`)
    .setDescription(
      [
        'Credentials verified and stored.',
        note ? `\n${note}` : '',
        remaining.length > 0
          ? `\n**Still to set up:** ${remaining.map((s) => s.title).join(', ')}`
          : '\nEverything is configured.',
        '\nTake your time — pick the next service below when you are ready.',
      ].filter(Boolean).join('\n'),
    );

  // No auto-advance and no timer: the success screen (which may carry a
  // follow-up action) stays put until the operator chooses what to do next.
  // Previously this slept and then rendered the next step, so anything shown
  // here scrolled past before it could be read.
  await interaction.editReply({
    embeds: [successEmbed],
    components: buildOverviewComponents(progress),
  });
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

/**
 * Live status line for each step.
 *
 * "Configured" previously meant only "a value is stored", so the dashboard step
 * showed a green tick while the dashboard itself was not running and its URL
 * led nowhere — the operator was told everything was fine and then found a dead
 * link. Where a stored value can actually be checked, check it, and say plainly
 * when it is not working.
 */
/**
 * Ask the saved dashboard URL whether anything is actually there.
 *
 * `live: null` means we did not check (no URL saved, or the step is not done
 * yet) — which is different from "checked and it is down".
 */
export async function probeDashboard(configuredSet: Set<string>): Promise<DashboardProbe> {
  const url = process.env.DASHBOARD_URL?.trim().replace(/\/$/, '') || null;
  if (!url || !configuredSet.has('deployment')) return { url, live: null };

  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    return { url, live: res.status > 0 };
  } catch {
    return { url, live: false };
  }
}

/**
 * Per-step liveness. `true` = proven working just now, `false` = the service
 * REJECTED the stored credential, `null` = not checked (step unconfigured, or
 * the probe was inconclusive — e.g. a network blip, which must not be reported
 * as broken credentials).
 */
export interface LiveStatus {
  dashboard: DashboardProbe;
  supabase: boolean | null;
  paypal: boolean | null;
}

/** Does the stored Supabase access token still work? */
async function probeSupabaseToken(configuredSet: Set<string>): Promise<boolean | null> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token || !configuredSet.has('supabase_mgmt')) return null;
  try {
    const res = await fetch('https://api.supabase.com/v1/projects', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) return false;
    return null;
  } catch {
    return null;
  }
}

/** Do the stored PayPal credentials still authenticate? */
async function probePayPalCreds(configuredSet: Set<string>): Promise<boolean | null> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret || !configuredSet.has('paypal')) return null;
  try {
    const res = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return true;
    if (res.status === 401) return false;
    return null;
  } catch {
    return null;
  }
}

/** Probe everything the overview is about to make claims about, in parallel. */
export async function probeLiveStatus(configuredSet: Set<string>): Promise<LiveStatus> {
  const [dashboard, supabase, paypal] = await Promise.all([
    probeDashboard(configuredSet),
    probeSupabaseToken(configuredSet),
    probePayPalCreds(configuredSet),
  ]);
  return { dashboard, supabase, paypal };
}

/**
 * One line per step, and the line must be earned: "working" only appears when
 * the probe just succeeded, and a stored-but-rejected credential is called out
 * rather than sitting behind the same green as everything else. A checkmark
 * that only means "a value was saved" is the exact lie this screen used to
 * tell.
 */
function buildStatusLines(configuredSet: Set<string>, live: LiveStatus): string {
  return WIZARD_STEPS.map((s) => {
    if (!configuredSet.has(s.id)) {
      return `⬜ ${s.emoji} **${s.title}** — not configured yet`;
    }
    if (s.id === 'deployment' && live.dashboard.live === false) {
      return `⚠️ ${s.emoji} **${s.title}** — saved, but nothing is answering at `
        + `\`${live.dashboard.url}\`. Start the dashboard (see the step for how).`;
    }
    if (s.id === 'supabase_mgmt' && live.supabase === false) {
      return `⚠️ ${s.emoji} **${s.title}** — saved, but Supabase rejected the stored `
        + 'access token. Open this step and paste a fresh `sbp_` token.';
    }
    if (s.id === 'paypal' && live.paypal === false) {
      return `⚠️ ${s.emoji} **${s.title}** — saved, but PayPal rejected the stored `
        + 'credentials. Open this step and re-enter them.';
    }
    const proven =
      (s.id === 'deployment' && live.dashboard.live === true)
      || (s.id === 'supabase_mgmt' && live.supabase === true)
      || (s.id === 'paypal' && live.paypal === true);
    return proven
      ? `✅ ${s.emoji} **${s.title}** — working (checked just now)`
      : `✅ ${s.emoji} **${s.title}** — configured`;
  }).join('\n');
}

/**
 * The step picker: current status plus controls to open any step.
 *
 * Shared by `/setup` and by the screen shown after a step completes, so the
 * operator always lands somewhere they can read and choose from — never inside
 * a step they did not pick.
 */
export function buildOverviewComponents(
  progress: WizardProgress,
): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const configuredSet = new Set(progress.configured);

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('setup:reconfigure')
    .setPlaceholder('Select a service to configure...')
    .addOptions(
      WIZARD_STEPS.map((s) => ({
        label: s.title,
        value: s.id,
        emoji: s.emoji,
        description: configuredSet.has(s.id) ? `Review or change ${s.title}` : `Set up ${s.title}`,
      })),
    );

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
  ];

  const next = getNextStep(progress);
  if (next?.step) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`setup:${next.step.id}:goto`)
          .setLabel(`Continue — ${next.step.title}`)
          .setEmoji('➡️')
          .setStyle(ButtonStyle.Primary),
      ),
    );
  }

  return rows;
}

async function advanceToNextStep(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  client: SomniClient,
  progress: WizardProgress,
): Promise<void> {
  // Deliberately does NOT jump into the next step's form.
  //
  // It used to render the next step immediately (on a timer), so finishing one
  // step catapulted the operator into an unrelated one — e.g. saving a
  // dashboard URL dumped them straight into PayPal webhook configuration,
  // faster than the previous screen could be read. Land on the picker instead
  // and let them choose when to continue.
  const configuredSet = new Set(progress.configured);
  const allConfigured = WIZARD_STEPS.every((s) => configuredSet.has(s.id));

  const live = await probeLiveStatus(configuredSet);
  const embed = allConfigured
    ? buildCompletionEmbed(configuredSet, live.dashboard)
    : new EmbedBuilder()
      .setColor(SOMNI_PALETTE.HOT_PINK)
      .setTitle('🔧 Setup')
      .setDescription(
        `${buildStatusLines(configuredSet, live)}\n\n`
        + 'Pick a service below when you are ready to continue.',
      );

  await interaction.editReply({ embeds: [embed], components: buildOverviewComponents(progress) });
}
