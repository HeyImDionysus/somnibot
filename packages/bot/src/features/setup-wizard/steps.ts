/**
 * Setup Wizard — Step definitions.
 *
 * Each step has:
 * - id: unique key used in custom IDs and progress tracking
 * - title/description: shown in the embed
 * - url: "Open X" button destination
 * - urlLabel: button text
 * - instructions: step-by-step in the embed
 * - modalFields: text input fields for the credentials modal
 * - instanceSettingsKeys: which instance_settings keys this step writes
 * - verify: function that validates the submitted values
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { SOMNI_PALETTE } from '@somnibot/shared';

/* ------------------------------------------------------------------ */
/*  Step type                                                          */
/* ------------------------------------------------------------------ */

export interface WizardStep {
  id: string;
  title: string;
  emoji: string;
  description: string;
  url: string;
  urlLabel: string;
  instructions: string;
  modalFields: {
    customId: string;
    label: string;
    placeholder: string;
    required: boolean;
    style: TextInputStyle;
    minLength?: number;
    maxLength?: number;
  }[];
  /** Map modal field customId → instance_settings key */
  fieldToSettingsKey: Record<string, string>;
  /** Verify submitted credentials. Returns null if valid, error string if not. */
  verify: (values: Record<string, string>) => Promise<string | null>;
  /** Feature flag key in guild_config to enable on success (optional) */
  enableFlag?: string;
}

/* ------------------------------------------------------------------ */
/*  PayPal step                                                        */
/* ------------------------------------------------------------------ */

async function verifyPayPal(values: Record<string, string>): Promise<string | null> {
  const clientId = values['paypal_client_id']?.trim();
  const clientSecret = values['paypal_client_secret']?.trim();
  if (!clientId || !clientSecret) return 'Both Client ID and Client Secret are required.';

  // Detect sandbox vs live from client ID prefix
  const isSandbox = clientId.startsWith('A') || clientId.length < 80;
  const baseUrl = isSandbox
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401) return 'Invalid credentials — double-check the Client ID and Secret.';
      return `PayPal returned ${res.status}: ${body.slice(0, 200)}`;
    }

    return null; // Valid
  } catch (err) {
    return `Could not reach PayPal API: ${(err as Error).message}`;
  }
}

export const PAYPAL_STEP: WizardStep = {
  id: 'paypal',
  title: 'PayPal (Commerce)',
  emoji: '💳',
  description: 'Connect PayPal to enable the server store, paid roles, and digital product sales.',
  url: 'https://developer.paypal.com/dashboard/applications',
  urlLabel: 'Open PayPal Developer Dashboard',
  instructions: [
    '1. Log in (or create a PayPal developer account)',
    '2. Go to **Apps & Credentials**',
    '3. Click **Create App** → name it anything (e.g. "SomniBot")',
    '4. Copy the **Client ID** and **Secret**',
    '5. Click "I have my credentials" below and paste them in',
  ].join('\n'),
  modalFields: [
    {
      customId: 'paypal_client_id',
      label: 'PayPal Client ID',
      placeholder: 'AaBbCcDd...',
      required: true,
      style: TextInputStyle.Short,
    },
    {
      customId: 'paypal_client_secret',
      label: 'PayPal Client Secret',
      placeholder: 'EeFfGgHh...',
      required: true,
      style: TextInputStyle.Short,
    },
  ],
  fieldToSettingsKey: {
    paypal_client_id: 'paypal_client_id',
    paypal_client_secret: 'paypal_client_secret',
  },
  verify: verifyPayPal,
  enableFlag: 'paypal_enabled',
};

/* ------------------------------------------------------------------ */
/*  Lavalink step                                                      */
/* ------------------------------------------------------------------ */

async function verifyLavalink(values: Record<string, string>): Promise<string | null> {
  const host = values['lavalink_host']?.trim();
  const port = values['lavalink_port']?.trim();
  const password = values['lavalink_password']?.trim();
  if (!host || !port || !password) return 'Host, port, and password are all required.';

  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) return 'Port must be a number between 1 and 65535.';

  try {
    const protocol = host.startsWith('https') ? 'https' : 'http';
    const cleanHost = host.replace(/^https?:\/\//, '');
    const url = `${protocol}://${cleanHost}:${portNum}/v4/info`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      headers: { 'Authorization': password },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) return null; // Valid
    if (res.status === 401) return 'Invalid password — the server rejected the authorization.';
    return `Lavalink returned ${res.status}. Make sure the server is running.`;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('abort')) return 'Connection timed out — make sure the host and port are correct.';
    return `Could not reach Lavalink: ${msg}`;
  }
}

export const LAVALINK_STEP: WizardStep = {
  id: 'lavalink',
  title: 'Lavalink (Music)',
  emoji: '🎵',
  description: 'Connect a Lavalink server to enable music playback. If you\'re running Lavalink locally, the defaults usually work.',
  url: 'https://lavalink.dev/getting-started/',
  urlLabel: 'Lavalink Setup Guide',
  instructions: [
    '1. If you haven\'t set up Lavalink yet, follow the guide above',
    '2. Once running, you need the **host**, **port**, and **password**',
    '3. Default: `localhost:2333` with password `youshallnotpass`',
    '4. Click "I have my credentials" and enter them',
  ].join('\n'),
  modalFields: [
    {
      customId: 'lavalink_host',
      label: 'Lavalink Host',
      placeholder: 'localhost',
      required: true,
      style: TextInputStyle.Short,
    },
    {
      customId: 'lavalink_port',
      label: 'Lavalink Port',
      placeholder: '2333',
      required: true,
      style: TextInputStyle.Short,
      maxLength: 5,
    },
    {
      customId: 'lavalink_password',
      label: 'Lavalink Password',
      placeholder: 'youshallnotpass',
      required: true,
      style: TextInputStyle.Short,
    },
  ],
  fieldToSettingsKey: {
    lavalink_host: 'lavalink_host',
    lavalink_port: 'lavalink_port',
    lavalink_password: 'lavalink_password',
  },
  verify: verifyLavalink,
  enableFlag: 'music_enabled',
};

/* ------------------------------------------------------------------ */
/*  Ordered step list                                                  */
/* ------------------------------------------------------------------ */

export const WIZARD_STEPS: WizardStep[] = [PAYPAL_STEP, LAVALINK_STEP];

/* ------------------------------------------------------------------ */
/*  Embed / component builders                                         */
/* ------------------------------------------------------------------ */

export function buildStepEmbed(step: WizardStep, stepIndex: number, totalSteps: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(SOMNI_PALETTE.CYAN)
    .setTitle(`${step.emoji} Setup — ${step.title}  (${stepIndex + 1}/${totalSteps})`)
    .setDescription(step.description)
    .addFields({ name: 'Instructions', value: step.instructions })
    .setFooter({ text: 'You can skip any step and come back later with /setup' });
}

export function buildStepComponents(step: WizardStep): ActionRowBuilder<ButtonBuilder>[] {
  const urlButton = new ButtonBuilder()
    .setLabel(step.urlLabel)
    .setStyle(ButtonStyle.Link)
    .setURL(step.url);

  const credentialsButton = new ButtonBuilder()
    .setCustomId(`setup:${step.id}:credentials`)
    .setLabel('I have my credentials')
    .setStyle(ButtonStyle.Primary);

  const skipButton = new ButtonBuilder()
    .setCustomId(`setup:${step.id}:skip`)
    .setLabel('Skip')
    .setStyle(ButtonStyle.Secondary);

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(urlButton, credentialsButton, skipButton),
  ];
}

export function buildStepModal(step: WizardStep): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`setup:modal:${step.id}`)
    .setTitle(`${step.emoji} ${step.title} — Credentials`);

  for (const field of step.modalFields) {
    const input = new TextInputBuilder()
      .setCustomId(field.customId)
      .setLabel(field.label)
      .setPlaceholder(field.placeholder)
      .setRequired(field.required)
      .setStyle(field.style);

    if (field.minLength != null) input.setMinLength(field.minLength);
    if (field.maxLength != null) input.setMaxLength(field.maxLength);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
  }

  return modal;
}

export function buildStatusEmbed(
  configuredSteps: Set<string>,
  skippedSteps: Set<string>,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(SOMNI_PALETTE.HOT_PINK)
    .setTitle('🔧 Setup Status');

  const lines: string[] = [];
  for (const step of WIZARD_STEPS) {
    if (configuredSteps.has(step.id)) {
      lines.push(`✅ **${step.title}** — connected`);
    } else if (skippedSteps.has(step.id)) {
      lines.push(`⏭️ **${step.title}** — skipped`);
    } else {
      lines.push(`❌ **${step.title}** — not configured`);
    }
  }

  embed.setDescription(lines.join('\n'));
  return embed;
}

export function buildCompletionEmbed(configuredSteps: Set<string>): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(SOMNI_PALETTE.HOT_PINK)
    .setTitle('🎉 Setup Complete!')
    .setDescription(
      'All steps have been reviewed. Here\'s what\'s configured:',
    );

  const lines: string[] = [];
  for (const step of WIZARD_STEPS) {
    if (configuredSteps.has(step.id)) {
      lines.push(`✅ **${step.title}** — connected`);
    } else {
      lines.push(`⏭️ **${step.title}** — skipped (configure anytime with \`/setup\`)`);
    }
  }

  embed.addFields({ name: 'Services', value: lines.join('\n') });
  embed.addFields({
    name: 'Next Steps',
    value: 'Open the **dashboard** to configure moderation, levels, welcome messages, and everything else. Run `/setup` again anytime to reconfigure services.',
  });
  embed.setFooter({ text: 'SomniBot — The wizard is the front door, the dashboard is the house.' });

  return embed;
}
