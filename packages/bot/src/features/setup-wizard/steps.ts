/**
 * Setup Wizard — Step definitions.
 *
 * Three steps covering external infrastructure the user must configure:
 *  1. PayPal  — credentials for commerce features
 *  2. Deployment — local vs remote (Vercel walkthrough for remote)
 *  3. Supabase Management — optional auto-migration credentials
 *
 * Self-managing services (Lavalink, Valkey, YouTube OAuth) are NOT
 * wizard steps — they use defaults and self-heal.
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
  /** Unique key used in custom IDs and progress tracking. */
  id: string;
  /** Human-friendly title shown in embeds. */
  title: string;
  /** Emoji shown in embeds and select menus. */
  emoji: string;
  /** Short description of what this step configures. */
  description: string;
  /** Step-by-step instructions shown in the embed body. */
  instructions: string;
  /** URL the "Open X" button links to (null = no link button). */
  url: string | null;
  /** Label for the URL button. */
  urlLabel: string;
  /** Label for the "I have my credentials" / configure button. */
  credentialsLabel: string;
  /** Modal fields to show when the user clicks the credentials button. */
  modalFields: {
    customId: string;
    label: string;
    placeholder: string;
    style: 'short' | 'paragraph';
    required: boolean;
    /** Pre-filled default value. */
    value?: string;
    /** Max length for the input. */
    maxLength?: number;
  }[];
  /**
   * Maps modal field customId → instance_settings key.
   * Only fields present here get written to instance_settings.
   */
  fieldToSettingsKey: Record<string, string>;
  /**
   * Verify the submitted values.
   * Returns null on success, or an error message string on failure.
   */
  verify: (values: Record<string, string>) => Promise<string | null>;
  /**
   * guild_config flag to enable when this step is configured.
   * Null = no feature flag to set.
   */
  enableFlag: string | null;
}

/* ------------------------------------------------------------------ */
/*  Step 1: PayPal                                                     */
/* ------------------------------------------------------------------ */

const paypalStep: WizardStep = {
  id: 'paypal',
  title: 'PayPal',
  emoji: '💳',
  description: 'Connect PayPal for commerce features (store, payments, orders).',
  instructions: [
    '1. Go to the PayPal Developer Dashboard (button below)',
    '2. Log in or create a PayPal developer account',
    '3. Go to **Apps & Credentials**',
    '4. Create a new app (or use an existing one)',
    '5. Copy the **Client ID** and **Secret**',
    '6. Note your **Webhook ID** if you have webhooks configured',
    '7. Click "I have my credentials" and paste them in',
    '',
    '> Set sandbox to `true` for testing, `false` for live payments.',
    '> Without PayPal, all commerce/store features are disabled.',
  ].join('\n'),
  url: 'https://developer.paypal.com/dashboard/applications/live',
  urlLabel: 'Open PayPal Developer Dashboard',
  credentialsLabel: 'I have my credentials',
  modalFields: [
    {
      customId: 'paypal_client_id',
      label: 'Client ID',
      placeholder: 'AaBbCcDdEeFf...',
      style: 'short',
      required: true,
    },
    {
      customId: 'paypal_client_secret',
      label: 'Client Secret',
      placeholder: 'EHJk1234...',
      style: 'short',
      required: true,
    },
    {
      customId: 'paypal_sandbox',
      label: 'Sandbox Mode (true / false)',
      placeholder: 'true',
      style: 'short',
      required: true,
      value: 'true',
    },
    {
      customId: 'paypal_webhook_id',
      label: 'Webhook ID (leave blank if none yet)',
      placeholder: 'WH-1AB23456CD789012E-3FG45678HI901234J',
      style: 'short',
      required: false,
    },
  ],
  fieldToSettingsKey: {
    paypal_client_id: 'paypal_client_id',
    paypal_client_secret: 'paypal_client_secret',
    paypal_sandbox: 'paypal_sandbox',
    paypal_webhook_id: 'paypal_webhook_id',
  },
  verify: async (values) => {
    const clientId = values.paypal_client_id?.trim();
    const clientSecret = values.paypal_client_secret?.trim();
    const sandbox = values.paypal_sandbox?.trim().toLowerCase();

    if (!clientId || !clientSecret) {
      return 'Client ID and Client Secret are both required.';
    }

    if (sandbox !== 'true' && sandbox !== 'false') {
      return 'Sandbox must be "true" or "false".';
    }

    const apiBase = sandbox === 'true'
      ? 'https://api-m.sandbox.paypal.com'
      : 'https://api-m.paypal.com';

    try {
      const res = await fetch(`${apiBase}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return `PayPal returned ${res.status}. Double-check your Client ID and Secret. Make sure you're using the right mode (sandbox: ${sandbox}).${text ? `\n\`\`\`${text.slice(0, 200)}\`\`\`` : ''}`;
      }

      return null;
    } catch (err) {
      return `Could not reach PayPal API (${apiBase}). Check your internet connection.\n\`${String(err)}\``;
    }
  },
  enableFlag: 'paypal_enabled',
};

/* ------------------------------------------------------------------ */
/*  Step 2: Deployment Preferences                                     */
/* ------------------------------------------------------------------ */

const deploymentStep: WizardStep = {
  id: 'deployment',
  title: 'Deployment',
  emoji: '🚀',
  description: 'Choose how you run the dashboard — locally or remotely via Vercel.',
  instructions: [
    '**Option A — Local (Electron Launcher)**',
    'Dashboard runs on `http://localhost:3456`. Already configured if you\'re',
    'using the desktop app. Just click "Configure" and accept the default.',
    '',
    '**Option B — Remote (Vercel)**',
    'Deploy the dashboard to Vercel so it\'s accessible from anywhere.',
    'You\'ll need to:',
    '1. Create a Vercel account and import the GitHub repo',
    '2. Set the **Root Directory** to `packages/dashboard`',
    '3. Add these env vars in Vercel → Settings → Environment Variables:',
    '   • `NEXT_PUBLIC_SUPABASE_URL` — your Supabase project URL',
    '   • `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — your Supabase anon/publishable key',
    '   • `SUPABASE_SECRET_KEY` — your Supabase service role / secret key',
    '   • `DISCORD_APPLICATION_ID` — your Discord app ID',
    '   • `DISCORD_CLIENT_SECRET` — your Discord OAuth client secret',
    '   • `DISCORD_GUILD_ID` — your server ID',
    '   • `NEXT_PUBLIC_APP_URL` — your Vercel deployment URL (e.g. `https://somnibot.vercel.app`)',
    '4. Deploy and grab the live URL',
    '',
    'Click "Open Vercel" to get started, then "Configure" to enter your dashboard URL.',
  ].join('\n'),
  url: 'https://vercel.com/new',
  urlLabel: 'Open Vercel',
  credentialsLabel: 'Configure',
  modalFields: [
    {
      customId: 'dashboard_url',
      label: 'Dashboard URL',
      placeholder: 'http://localhost:3456',
      style: 'short',
      required: true,
      value: 'http://localhost:3456',
    },
  ],
  fieldToSettingsKey: {
    dashboard_url: 'dashboard_url',
  },
  verify: async (values) => {
    const url = values.dashboard_url?.trim();
    if (!url) return 'Dashboard URL is required.';

    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return `Invalid protocol "${parsed.protocol}". Expected "http:" or "https:".`;
      }
    } catch {
      return 'Invalid URL format. Expected something like `http://localhost:3456` or `https://your-app.vercel.app`.';
    }

    // If it's a remote URL, try to reach it
    if (!url.includes('localhost') && !url.includes('127.0.0.1')) {
      try {
        const res = await fetch(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(10000),
        });
        // Any response means the server is reachable — even redirects/auth pages are fine
        if (!res.ok && res.status !== 307 && res.status !== 302 && res.status !== 301) {
          return `Got HTTP ${res.status} from ${url}. Make sure the Vercel deployment is live and the URL is correct.`;
        }
      } catch {
        return `Could not reach ${url}. Make sure the Vercel deployment is live. If you haven't deployed yet, open Vercel (button above), deploy first, then come back.`;
      }
    }

    return null;
  },
  enableFlag: null,
};

/* ------------------------------------------------------------------ */
/*  Step 3: Supabase Management (optional — auto-migration)            */
/* ------------------------------------------------------------------ */

const supabaseManagementStep: WizardStep = {
  id: 'supabase_mgmt',
  title: 'Supabase Management',
  emoji: '🗄️',
  description: 'Connect the Supabase Management API so the bot can auto-run database migrations on updates.',
  instructions: [
    'This step is **optional** but recommended.',
    '',
    '1. Go to your Supabase Dashboard → Account → Access Tokens',
    '2. Generate a new token and copy it',
    '3. Go to your project → Settings → Database',
    '4. Copy the **Connection String (URI)** — the `postgresql://...` URL',
    '5. Click "I have my credentials" and paste both values',
    '',
    '> Without this, database migrations need to be run manually after updates.',
    '> With it, the bot handles schema changes automatically when it restarts.',
  ].join('\n'),
  url: 'https://supabase.com/dashboard/account/tokens',
  urlLabel: 'Open Supabase Dashboard',
  credentialsLabel: 'I have my credentials',
  modalFields: [
    {
      customId: 'supabase_access_token',
      label: 'Access Token',
      placeholder: 'sbp_abc123def456...',
      style: 'short',
      required: true,
    },
    {
      customId: 'supabase_db_url',
      label: 'Database Connection String (URI)',
      placeholder: 'postgresql://postgres:[PASSWORD]@db.xxx.supabase.co:5432/postgres',
      style: 'paragraph',
      required: true,
    },
  ],
  fieldToSettingsKey: {
    supabase_access_token: 'supabase_access_token',
    supabase_db_url: 'supabase_db_url',
  },
  verify: async (values) => {
    const token = values.supabase_access_token?.trim();
    const dbUrl = values.supabase_db_url?.trim();

    if (!token) return 'Access Token is required.';
    if (!dbUrl) return 'Database Connection String is required.';

    // Validate DB URL format
    try {
      const parsed = new URL(dbUrl);
      if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) {
        return `Invalid protocol "${parsed.protocol}" in DB URL. Expected "postgresql:" or "postgres:".`;
      }
    } catch {
      return 'Invalid database URL format. Expected something like `postgresql://postgres:password@host:5432/postgres`.';
    }

    // Verify access token by listing projects
    try {
      const res = await fetch('https://api.supabase.com/v1/projects', {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (res.status === 401 || res.status === 403) {
        return 'Access token is invalid or expired. Generate a new one from Supabase → Account → Access Tokens.';
      }
      if (!res.ok) {
        return `Supabase API returned HTTP ${res.status}. Try generating a new access token.`;
      }

      return null;
    } catch (err) {
      return `Could not reach Supabase Management API. Check your internet connection.\n\`${String(err)}\``;
    }
  },
  enableFlag: null,
};

/* ------------------------------------------------------------------ */
/*  Ordered step array                                                 */
/* ------------------------------------------------------------------ */

export const WIZARD_STEPS: WizardStep[] = [
  paypalStep,
  deploymentStep,
  supabaseManagementStep,
];

/* ------------------------------------------------------------------ */
/*  Embed / component builders                                         */
/* ------------------------------------------------------------------ */

export function buildStepEmbed(step: WizardStep, index: number, total: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(SOMNI_PALETTE.HOT_PINK)
    .setTitle(`${step.emoji} Setup — ${step.title}  (${index + 1}/${total})`)
    .setDescription(`${step.description}\n\n${step.instructions}`)
    .setFooter({ text: 'You can skip any step and come back to it later with /setup' });
}

export function buildStepComponents(step: WizardStep): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();

  if (step.url) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel(step.urlLabel)
        .setStyle(ButtonStyle.Link)
        .setURL(step.url),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`setup:${step.id}:credentials`)
      .setLabel(step.credentialsLabel)
      .setStyle(ButtonStyle.Primary),
  );

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`setup:${step.id}:skip`)
      .setLabel('Skip')
      .setStyle(ButtonStyle.Secondary),
  );

  return [row];
}

export function buildStepModal(step: WizardStep): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`setup:modal:${step.id}`)
    .setTitle(`${step.title} — Credentials`);

  for (const field of step.modalFields) {
    const input = new TextInputBuilder()
      .setCustomId(field.customId)
      .setLabel(field.label)
      .setPlaceholder(field.placeholder)
      .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required);

    if (field.value !== undefined) {
      input.setValue(field.value);
    }
    if (field.maxLength !== undefined) {
      input.setMaxLength(field.maxLength);
    }

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
  }

  return modal;
}

export function buildCompletionEmbed(configuredIds: Set<string>): EmbedBuilder {
  const lines = WIZARD_STEPS.map((s) => {
    const status = configuredIds.has(s.id) ? '✅' : '⏭️ skipped';
    return `${s.emoji} **${s.title}** — ${status}`;
  }).join('\n');

  return new EmbedBuilder()
    .setColor(SOMNI_PALETTE.HOT_PINK)
    .setTitle('🎉 Setup Complete!')
    .setDescription(
      `${lines}\n\n` +
      'All external services are configured. Head to the **dashboard** to enable and ' +
      'configure features — moderation, levels, welcome, tickets, commerce, music, and everything else.\n\n' +
      'Run `/setup` again anytime to reconfigure any service.',
    );
}
