/**
 * Setup Wizard — Step definitions.
 *
 * Three steps covering external infrastructure the user must configure:
 *  1. PayPal  — credentials for commerce features
 *  2. Deployment — regular local, WSL2 parity, or VPS callbacks
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
  /**
   * Optional note shown on the success screen, built from the values the
   * operator just submitted. Used for the genuinely-manual leftovers a step
   * cannot do for them (e.g. a redirect URL that must be pasted into Discord's
   * developer portal), so those land at the moment they are actionable instead
   * of being buried in the instructions beforehand.
   */
  successNote?: (values: Record<string, string>) => string | null;
  /**
   * Optional extra action button (custom id `setup:<stepId>:<action>`), for a
   * step that can *do* something for the operator rather than only collect a
   * value — e.g. turning on a Tailscale Funnel to obtain a public HTTPS URL.
   */
  extraButton?: { action: string; label: string; emoji?: string };
}

/* ------------------------------------------------------------------ */
/*  PayPal webhook verification                                        */
/* ------------------------------------------------------------------ */

/**
 * Every webhook event the commerce pipeline consumes. Kept in sync with the
 * dashboard's /api/paypal/webhook handler — a webhook that is missing any of
 * these silently drops that part of the lifecycle (e.g. without
 * BILLING.SUBSCRIPTION.EXPIRED a lapsed subscriber keeps their roles forever).
 */
const REQUIRED_PAYPAL_EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  // A denied capture leaves the order pending forever if it is not delivered.
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.SALE.COMPLETED',
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  // Without these a chargeback is completely invisible to the operator.
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
] as const;

interface PayPalWebhook {
  id: string;
  url: string;
  event_types?: { name: string }[];
}

const eventList = () => REQUIRED_PAYPAL_EVENTS.map((name) => ({ name }));

/**
 * Make PayPal's webhook configuration correct, rather than asking the operator
 * to do it by hand and then trusting them.
 *
 * The wizard used to require a Webhook ID typed in from the PayPal dashboard,
 * after manually creating a webhook and ticking twelve event checkboxes. That
 * put the fiddliest, most error-prone part of the whole integration on the
 * user — and then only checked the field was non-empty, so a typo, an ID from
 * the wrong environment, or (very commonly) a webhook missing several event
 * subscriptions all sailed through as "verified" and failed silently at
 * payment time.
 *
 * Everything here is a plain API call the bot can make with the credentials it
 * was just given, so it does:
 *   1. find an existing webhook already pointing at this callback URL,
 *   2. create one if there is none,
 *   3. force its event subscriptions to exactly the set the bot consumes,
 *   4. write the resulting id back so it is stored like any other credential.
 * The operator only supplies what genuinely requires a human: the app's
 * Client ID and Secret.
 */
async function ensurePayPalWebhook(
  apiBase: string,
  accessToken: string,
  targetUrl: string,
  values: Record<string, string>,
): Promise<string | null> {
  const auth = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  let existing: PayPalWebhook | undefined;
  try {
    const listRes = await fetch(`${apiBase}/v1/notifications/webhooks`, {
      headers: auth,
      signal: AbortSignal.timeout(15000),
    });
    if (listRes.ok) {
      const body = (await listRes.json()) as { webhooks?: PayPalWebhook[] };
      // Scheme and host are case-insensitive; the PATH is not. Lowercasing the
      // whole URL could equate two genuinely different endpoints and make us
      // adopt — and then rewrite the event subscriptions of — somebody else's
      // webhook. Normalise only the parts that are actually case-insensitive.
      const norm = (u: string) => {
        const trimmed = u.replace(/\/$/, '');
        try {
          const parsed = new URL(trimmed);
          return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}`;
        } catch {
          return trimmed;
        }
      };
      existing = (body.webhooks ?? []).find((w) => norm(w.url ?? '') === norm(targetUrl));
    }
  } catch {
    // Fall through to create; a failed list is not fatal on its own.
  }

  // Already registered for this URL — just force the event set to match.
  if (existing) {
    const subscribed = new Set((existing.event_types ?? []).map((e) => e.name));
    const missing = REQUIRED_PAYPAL_EVENTS.filter((e) => !subscribed.has(e));
    if (missing.length > 0) {
      const patchRes = await fetch(
        `${apiBase}/v1/notifications/webhooks/${encodeURIComponent(existing.id)}`,
        {
          method: 'PATCH',
          headers: auth,
          body: JSON.stringify([{ op: 'replace', path: '/event_types', value: eventList() }]),
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!patchRes.ok) {
        const text = await patchRes.text().catch(() => '');
        return (
          `Found your webhook but could not update its event subscriptions `
          + `(HTTP ${patchRes.status}). It is missing: ${missing.join(', ')}.`
          + (text ? `\n\`\`\`${text.slice(0, 200)}\`\`\`` : '')
        );
      }
    }
    values.paypal_webhook_id = existing.id;
    values.paypal_webhook_url = targetUrl;
    return null;
  }

  // Nothing registered for this URL — create it.
  const createRes = await fetch(`${apiBase}/v1/notifications/webhooks`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ url: targetUrl, event_types: eventList() }),
    signal: AbortSignal.timeout(20000),
  });

  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '');
    if (/WEBHOOK_URL_ALREADY_EXISTS/i.test(text)) {
      return (
        `PayPal already has a webhook for \`${targetUrl}\` on a different app. `
        + 'Delete it in PayPal → Apps & Credentials → Webhooks, or use a '
        + 'different callback URL, then try again.'
      );
    }
    if (/INVALID_PARAMETER_SYNTAX|url/i.test(text) && !/^https:/i.test(targetUrl)) {
      return (
        `PayPal rejected \`${targetUrl}\`. Webhook URLs must be **public HTTPS** `
        + 'addresses — PayPal cannot reach `localhost`. Expose your dashboard '
        + 'with a stable HTTPS URL (Tailscale Funnel, a domain on your VPS, '
        + 'etc.) and set that as the dashboard URL in the Hosting step.'
      );
    }
    return (
      `PayPal refused to create the webhook for \`${targetUrl}\` (HTTP `
      + `${createRes.status}).`
      + (text ? `\n\`\`\`${text.slice(0, 250)}\`\`\`` : '')
    );
  }

  const created = (await createRes.json()) as PayPalWebhook;
  values.paypal_webhook_id = created.id;
  values.paypal_webhook_url = targetUrl;
  return null;
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
    'The bot configures your PayPal webhook for you — you only need the app',
    'credentials.',
    '',
    '1. Open the PayPal Developer Dashboard (button below) and log in',
    '2. Go to **Apps & Credentials** and pick the **Sandbox** or **Live** tab',
    '   — this must match the Sandbox Mode you enter below',
    '3. Open your app (or create one) and copy the **Client ID** and **Secret**',
    '4. Click "I have my credentials" and paste them in',
    '',
    '> That is all. The bot then finds or creates the webhook on your account,',
    '> subscribes it to all 12 payment events it needs, and stores the webhook',
    '> ID itself — no copying IDs or ticking event checkboxes.',
    '',
    '> Payments need a **public HTTPS** callback URL — PayPal cannot reach',
    '> `localhost`. Set your public dashboard URL in the Hosting step first',
    '> (Tailscale Funnel, a VPS domain, …), or enter one below.',
    '> Without PayPal, all commerce/store features are disabled.',
  ].join('\n'),
  url: 'https://developer.paypal.com/dashboard/',
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
      // NOTE: the Webhook ID is deliberately NOT asked for. ensurePayPalWebhook()
      // finds or creates the webhook, forces its event subscriptions, and writes
      // the id back into `values` before storeCredentials() persists it — so the
      // operator never has to create a webhook, tick twelve event boxes, and
      // transcribe an ID that nothing previously validated.
      customId: 'paypal_webhook_url',
      label: 'Webhook URL (optional)',
      placeholder: 'Leave blank to use your dashboard URL',
      style: 'short',
      required: false,
    },
  ],
  fieldToSettingsKey: {
    paypal_client_id: 'paypal_client_id',
    paypal_client_secret: 'paypal_client_secret',
    paypal_sandbox: 'paypal_sandbox',
    paypal_webhook_id: 'paypal_webhook_id',
    paypal_webhook_url: 'paypal_webhook_url',
  },
  verify: async (values) => {
    const clientId = values.paypal_client_id?.trim();
    const clientSecret = values.paypal_client_secret?.trim();
    const sandbox = values.paypal_sandbox?.trim().toLowerCase();

    const webhookUrl = values.paypal_webhook_url?.trim();

    if (!clientId || !clientSecret) {
      return 'Client ID and Client Secret are both required.';
    }

    if (sandbox !== 'true' && sandbox !== 'false') {
      return 'Sandbox must be "true" or "false".';
    }

    if (webhookUrl) {
      try {
        const parsed = new URL(webhookUrl);
        if (parsed.protocol !== 'https:') {
          return 'PayPal webhook URL must use HTTPS.';
        }
        if (parsed.pathname !== '/api/paypal/webhook') {
          return 'PayPal webhook URL must end with `/api/paypal/webhook`.';
        }
      } catch {
        return 'Invalid PayPal webhook URL. Expected `<public-callback-base>/api/paypal/webhook`.';
      }
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

      // Credentials are good — now make the WEBHOOK correct on PayPal's side
      // rather than asking the operator to have done it by hand.
      const { access_token: accessToken } = (await res.json()) as { access_token?: string };
      if (!accessToken) {
        return 'PayPal did not return an access token. Double-check your Client ID and Secret.';
      }

      // Callback base: what the operator typed, else the dashboard URL that the
      // Hosting step stored. PayPal must be able to reach it over public HTTPS.
      const base = (webhookUrl || process.env.DASHBOARD_URL || '').trim().replace(/\/$/, '');
      if (!base) {
        return (
          'No callback URL is configured yet. Complete the **Hosting and '
          + 'Callbacks** step first (or enter a Webhook URL here) so PayPal has '
          + 'somewhere to send payment events.'
        );
      }
      const targetUrl = base.endsWith('/api/paypal/webhook')
        ? base
        : `${base}/api/paypal/webhook`;
      if (!/^https:\/\//i.test(targetUrl)) {
        return (
          `\`${targetUrl}\` is not a public HTTPS URL. PayPal cannot deliver `
          + 'payment events to `localhost` or plain HTTP — expose your dashboard '
          + 'over HTTPS (Tailscale Funnel, a VPS domain, …) and use that here.'
        );
      }

      return ensurePayPalWebhook(apiBase, accessToken, targetUrl, values);
    } catch (err) {
      return `Could not reach PayPal API (${apiBase}). Check your internet connection.\n\`${String(err)}\``;
    }
  },
  enableFlag: 'paypal_enabled',
};

/**
 * Fetch the project's publishable (anon) key with the access token we were just
 * given, and record it for the dashboard.
 *
 * Dashboard sign-in needs this key, and the operator used to be told to go and
 * copy it out of Supabase by hand — a second, similar-looking key that nothing
 * validated, right after they had already been warned not to paste the other
 * two. The Management API hands it over for the same token that proves the
 * project, so there is no reason to ask.
 *
 * Best-effort: setup must not fail because this lookup did, since the key can
 * still be supplied by env.
 */
async function fetchPublishableKey(
  token: string,
  projectRef: string,
  values: Record<string, string>,
): Promise<void> {
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/api-keys`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return;

    const keys = (await res.json()) as Array<{ name?: string; type?: string; api_key?: string }>;
    if (!Array.isArray(keys)) return;

    // Prefer the modern publishable key; fall back to the legacy anon JWT for
    // projects that have not been migrated.
    const publishable = keys.find((k) => k.type === 'publishable')
      ?? keys.find((k) => k.name === 'anon');

    if (publishable?.api_key) values.supabase_publishable_key = publishable.api_key;
  } catch {
    // Leave it unset — env can still provide it.
  }
}

/**
 * Which PayPal API host to talk to.
 *
 * The mode chosen in the wizard wins over `PAYPAL_API_BASE`. The stock
 * `.env.example` pins that variable to the sandbox host, so letting it take
 * precedence meant a live setup authenticated live credentials against sandbox,
 * failed, and returned silently — leaving the webhook pointed at the previous
 * dashboard URL with no indication anything went wrong. `PAYPAL_API_BASE` is
 * still honoured when no explicit mode has been recorded.
 */
export function paypalApiBase(values?: Record<string, string>): string {
  const mode = (values?.paypal_sandbox ?? process.env.PAYPAL_SANDBOX ?? '').trim().toLowerCase();
  if (mode) {
    return mode === 'false' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  }
  return process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
}

/**
 * Move the PayPal webhook to follow a changed dashboard URL.
 *
 * The callback address is derived from the dashboard URL, so changing the
 * dashboard without re-pointing PayPal left payment events being delivered to
 * the previous host — invisibly, because both the wizard and PayPal still
 * considered the (stale) webhook perfectly valid. Best-effort: PayPal not being
 * configured yet is the normal case and must not fail the hosting step.
 */
async function repointPayPalWebhook(
  dashboardUrl: string,
  values: Record<string, string>,
): Promise<void> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return;

  const apiBase = paypalApiBase(values);
  const target = `${dashboardUrl.replace(/\/$/, '')}/api/paypal/webhook`;
  if (!/^https:\/\//i.test(target)) return; // PayPal only accepts public HTTPS

  try {
    const tokenRes = await fetch(`${apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10000),
    });
    if (!tokenRes.ok) return;
    const { access_token: accessToken } = (await tokenRes.json()) as { access_token?: string };
    if (!accessToken) return;

    const previousId = process.env.PAYPAL_WEBHOOK_ID;

    // Discarding this used to mean the Hosting step reported success — and its
    // note claimed "payment callbacks now point here" — while PayPal had
    // rejected the change and kept delivering purchases to the previous host.
    // A silently stale payment webhook is about the worst thing to be wrong
    // about, so surface it.
    const webhookProblem = await ensurePayPalWebhook(apiBase, accessToken, target, values);
    if (webhookProblem) {
      values.__paypal_note = webhookProblem;
      return;
    }

    // Remove the webhook we were previously using, so repeatedly changing the
    // dashboard URL does not leave a trail of dead webhooks delivering to hosts
    // that no longer exist. Scoped deliberately narrowly: only the id this bot
    // had stored, and only when it is our own callback path — never anything
    // else the operator may have registered on their PayPal app.
    if (previousId && values.paypal_webhook_id && previousId !== values.paypal_webhook_id) {
      try {
        const stale = await fetch(
          `${apiBase}/v1/notifications/webhooks/${encodeURIComponent(previousId)}`,
          { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) },
        );
        if (stale.ok) {
          const { url: staleUrl } = (await stale.json()) as { url?: string };
          if (staleUrl && /\/api\/paypal\/webhook\/?$/i.test(staleUrl)) {
            await fetch(
              `${apiBase}/v1/notifications/webhooks/${encodeURIComponent(previousId)}`,
              {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(10000),
              },
            );
          }
        }
      } catch {
        // A leftover webhook is untidy, not harmful — never fail the step for it.
      }
    }
  } catch {
    // Never block saving the dashboard URL on PayPal being reachable.
  }
}

/* ------------------------------------------------------------------ */
/*  Supabase auth wiring (dashboard login + redirects)                 */
/* ------------------------------------------------------------------ */

/**
 * Point Supabase auth at the operator's dashboard URL and switch Discord login
 * on, using the Management API.
 *
 * The Hosting step used to *describe* this: it printed a redirect allow-list
 * and a provider callback and expected the operator to go and configure them in
 * the Supabase dashboard by hand. Nothing checked that they had, so the common
 * outcome was an empty allow-list and a disabled Discord provider — i.e.
 * dashboard login simply did not work, with no error pointing at setup. These
 * are ordinary API calls, so do them.
 *
 * Best-effort by design: if no access token is stored yet (the Database step
 * has not been done), the URL is still saved and this is skipped rather than
 * failing the step.
 */
async function configureSupabaseAuth(
  dashboardUrl: string,
  accessToken?: string,
): Promise<string | null> {
  // Accepts the token explicitly because the Database step calls this during
  // its own verify(), before storeCredentials() has put it into process.env.
  const token = accessToken || process.env.SUPABASE_ACCESS_TOKEN;
  const ref = /https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(process.env.SUPABASE_URL ?? '')?.[1];
  if (!ref) return null;
  if (!token) {
    // Steps can be completed in any order, so Hosting may legitimately run
    // first. Say so rather than silently reporting a fully wired setup.
    return 'Saved the URL. Sign-in redirects will be wired up automatically when '
      + 'you finish the **Database Setup** step.';
  }

  const base = dashboardUrl.replace(/\/$/, '');
  const authUrl = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Keep localhost alongside the public URL so local sign-in keeps working
  // when the operator is running the dashboard on their own machine.
  const localPort = Number(process.env.DASHBOARD_PORT || process.env.PORT || 3000);
  const wanted = [
    `${base}/api/auth/callback`,
    `http://localhost:${localPort}/api/auth/callback`,
  ];

  // PATCH replaces uri_allow_list wholesale, so it has to be read and appended
  // to. Sending only our own callbacks would delete every other redirect on the
  // project — preview deployments, a mobile app, an unrelated site — and break
  // their sign-in. If we cannot read the current list we leave the field alone
  // entirely rather than risk clobbering it.
  let mergedAllowList: string | null = null;
  try {
    const current = await fetch(authUrl, { headers, signal: AbortSignal.timeout(15000) });
    if (current.ok) {
      const cfg = (await current.json()) as Record<string, unknown>;
      const raw = cfg.uri_allow_list ?? cfg.URI_ALLOW_LIST;
      const entries = typeof raw === 'string'
        ? raw.split(',').map((e) => e.trim()).filter(Boolean)
        : [];
      for (const url of wanted) if (!entries.includes(url)) entries.push(url);
      mergedAllowList = entries.join(',');
    }
  } catch {
    // handled below by leaving the allow-list untouched
  }

  const body: Record<string, unknown> = { site_url: base };
  if (mergedAllowList !== null) body.uri_allow_list = mergedAllowList;
  // Dashboard sign-in is Discord OAuth through Supabase, so enable the provider
  // with this bot's application credentials when we have them.
  if (process.env.DISCORD_APPLICATION_ID && process.env.DISCORD_CLIENT_SECRET) {
    body.external_discord_enabled = true;
    body.external_discord_client_id = process.env.DISCORD_APPLICATION_ID;
    body.external_discord_secret = process.env.DISCORD_CLIENT_SECRET;
  }

  try {
    const res = await fetch(authUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return `Saved the URL, but could not update Supabase auth settings (HTTP ${res.status}).`;
    }
  } catch {
    return 'Saved the URL, but could not reach Supabase to update auth settings.';
  }

  if (mergedAllowList === null) {
    return 'Saved the URL, but could not read the existing Supabase redirect list, '
      + 'so it was left untouched to avoid deleting other entries. Add '
      + `\`${wanted[0]}\` under Authentication → URL Configuration.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Step 2: Deployment Preferences                                     */
/* ------------------------------------------------------------------ */

const deploymentStep: WizardStep = {
  id: 'deployment',
  title: 'Hosting and Callbacks',
  emoji: '🚀',
  description: 'Choose regular local, WSL2 parity, or VPS hosting and set the dashboard callback URL.',
  instructions: [
    '**Where will people open your dashboard?**',
    '',
    'Enter that address below. The bot uses it for sign-in redirects and',
    'payment callbacks, and configures Supabase to match.',
    '',
    '• Just you, on this machine → `http://localhost:3000`',
    '  (desktop launcher instead? use `http://localhost:3456`)',
    '• Anyone else, or you want payments → a public **HTTPS** address, e.g.',
    '  your VPS domain or a Tailscale Funnel URL',
    '',
    '> `localhost` is fine to start with, but PayPal cannot send payment',
    '> events to it and nobody else can sign in. You can change this later by',
    '> re-running `/setup`.',
    '',
    '> **No public URL yet?** Press **Set up Tailscale Funnel** and the bot will',
    '> turn one on for you and fill in the address itself.',
  ].join('\n'),
  url: null,
  urlLabel: '',
  credentialsLabel: 'Configure',
  modalFields: [
    {
      customId: 'dashboard_url',
      label: 'Dashboard URL',
      placeholder: 'http://localhost:3000 or https://your-domain.example',
      style: 'short',
      required: true,
      value: 'http://localhost:3000',
    },
  ],
  fieldToSettingsKey: {
    dashboard_url: 'dashboard_url',
    // Changing the dashboard URL moves the PayPal callback with it, so the
    // re-pointed webhook id/url are persisted from this step as well.
    paypal_webhook_id: 'paypal_webhook_id',
    paypal_webhook_url: 'paypal_webhook_url',
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
      return 'Invalid URL format. Expected something like `http://localhost:3000` or `https://your-domain.example`.';
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
          values.__unreachable = `returned HTTP ${res.status}`;
        }
      } catch {
        // NOT a hard failure: during setup the dashboard is frequently not
        // running yet, and refusing to save its URL for that reason leaves the
        // operator unable to finish the wizard at all. Record it and surface a
        // prominent warning on the success screen instead of silently passing.
        values.__unreachable = 'did not respond';
      }
    }

    // Wire Supabase auth to this URL (redirect allow-list + Discord provider)
    // instead of printing instructions and hoping the operator does it.
    //
    // Returning this message used to ABORT the step — so a note that opened
    // with "Saved the URL, but..." was shown at the exact moment the URL was
    // not saved, and the operator had to redo a step that had actually
    // succeeded. Auth wiring is a follow-on action, not the thing being
    // verified: record it as a warning and let the URL persist.
    const authNote = await configureSupabaseAuth(url);
    if (authNote) values.__auth_note = authNote;

    // Move the PayPal webhook to the new address. Without this, changing the
    // dashboard URL silently left PayPal delivering payment events to the old
    // host — the callbacks kept "working" in the wizard's eyes while going
    // nowhere.
    await repointPayPalWebhook(url, values);
    return null;
  },
  enableFlag: null,
  extraButton: { action: 'tailscale', label: 'Set up Tailscale Funnel', emoji: '🌐' },
  successNote: (values) => {
    const ref = /https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(process.env.SUPABASE_URL ?? '')?.[1];
    const url = values.dashboard_url?.trim().replace(/\/$/, '') ?? '';
    const lines = [
      `Sign-in redirects and payment callbacks now point at \`${url}\`.`,
    ];
    if (values.paypal_webhook_url) {
      lines.push(
        '',
        `💳 PayPal webhook moved to \`${values.paypal_webhook_url}\` (all 12 `
        + 'payment events subscribed).',
      );
    }
    if (values.__unreachable) {
      lines.push(
        '',
        `⚠️ Heads up: \`${url}\` ${values.__unreachable} just now. That is fine `
        + 'if the dashboard is not started yet — but sign-in and payment '
        + 'callbacks will not work until it is reachable at that address.',
      );
    }
    if (values.__auth_note) {
      lines.push('', `⚠️ ${values.__auth_note}`);
    }
    if (values.__paypal_note) {
      lines.push(
        '',
        `⚠️ PayPal webhook was NOT moved: ${values.__paypal_note} Payment events `
        + 'will keep going to the previous address until this is resolved.',
      );
    }
    if (ref) {
      lines.push(
        '',
        '**One thing only you can do:** in the Discord Developer Portal → your '
        + 'app → **OAuth2 → Redirects**, add:',
        `\`https://${ref}.supabase.co/auth/v1/callback\``,
        '',
        '_(Discord has no API for this. Leave the Interactions Endpoint URL '
        + 'blank — this bot uses the gateway.)_',
      );
    }
    if (/^http:\/\/localhost/i.test(url)) {
      lines.push(
        '',
        '⚠️ This is a local address, so PayPal cannot deliver payment events '
        + 'and nobody else can sign in. Re-run `/setup` with a public HTTPS '
        + 'URL when you want either.',
      );
    }
    return lines.join('\n');
  },
};

/* ------------------------------------------------------------------ */
/*  Database connection verification                                   */
/* ------------------------------------------------------------------ */

/**
 * Open a REAL connection to the supplied Postgres URL and run `select 1`.
 *
 * The wizard used to accept any well-formed URL, which meant the most common
 * user mistakes were "verified" and only surfaced much later as failed
 * migrations:
 *  - pasting Supabase's **Direct connection** string, which is IPv6-only on
 *    new projects and cannot be reached from most machines,
 *  - leaving the literal `[YOUR-PASSWORD]` placeholder in the string,
 *  - using the wrong database password.
 * Each now fails here with the specific fix, before anything is stored.
 */
async function verifyDatabaseConnection(dbUrl: string): Promise<string | null> {
  if (/\[YOUR-PASSWORD\]|\[password\]/i.test(dbUrl)) {
    return (
      'That connection string still contains the `[YOUR-PASSWORD]` placeholder. '
      + 'Replace it with your actual database password (Supabase → Settings → '
      + 'Database → **Reset database password** if you do not have it).'
    );
  }

  const { default: postgres } = await import('postgres');
  const sql = postgres(dbUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 1,
    prepare: false,
    onnotice: () => {},
  });

  try {
    await sql`select 1`;
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code ?? '';

    // IPv6-only direct host — by far the most common failure.
    if (
      /ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH/i.test(message + code)
      && /db\.[a-z0-9]+\.supabase\.co/i.test(dbUrl)
    ) {
      const ref = /db\.([a-z0-9]+)\.supabase\.co/i.exec(dbUrl)?.[1] ?? '<project-ref>';
      return (
        'Could not reach that host. This is Supabase\'s **Direct connection** '
        + 'string, which is IPv6-only on new projects — most networks cannot use it.\n\n'
        + 'Use the **Session pooler** string instead: in your project click '
        + '**Connect** → *Session pooler* → copy that URI. It looks like:\n'
        + `\`postgresql://postgres.${ref}:YOUR-PASSWORD@aws-0-<region>.pooler.supabase.com:5432/postgres\``
      );
    }
    if (/password authentication failed|SASL|28P01/i.test(message + code)) {
      return (
        'The database rejected that password. Copy it again, or reset it at '
        + 'Supabase → Settings → Database → **Reset database password** (this '
        + 'invalidates the previous one).'
      );
    }
    if (/ETIMEDOUT|timeout/i.test(message + code)) {
      return (
        'Timed out connecting to the database. If you used the **Direct '
        + 'connection** string, switch to the **Session pooler** string from the '
        + '**Connect** dialog; otherwise check any firewall on port 5432.'
      );
    }
    return `Could not connect to the database:\n\`${message.slice(0, 300)}\``;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/*  Step 3: Supabase Management (optional — auto-migration)            */
/* ------------------------------------------------------------------ */

const supabaseManagementStep: WizardStep = {
  id: 'supabase_mgmt',
  title: 'Database Setup',
  emoji: '🗄️',
  description: 'Connect to your Supabase database so the bot can create and update its schema.',
  instructions: [
    'This lets the bot create and update its own database tables.',
    '',
    '**You need one thing: a Personal Access Token (`sbp_...`).**',
    '',
    '1. Click the button below — it opens Supabase → **Account** → Access',
    '   Tokens. This is your ACCOUNT settings, not the project settings.',
    '2. Click **Generate new token**, give it any name, and copy it',
    '   immediately — it starts with `sbp_` and is shown only once',
    '3. Click "I have my credentials" and paste it in',
    '',
    '> **This is not one of your project API keys.** It is NOT the',
    '> `service_role`/secret key, NOT the `anon`/publishable key (the long',
    '> `eyJ...` values under Project Settings → API), and NOT your database',
    '> password. Those cannot create tables. Only an `sbp_` account token can.',
    '',
    '> Leave the connection-string box **blank**. The bot applies migrations',
    '> through Supabase\'s API using this token, so it never needs your',
    '> database password. Only fill that box in if you are running Postgres',
    '> somewhere without a Supabase access token.',
    '',
    '> The token is checked against your actual project before anything is',
    '> saved, so you will know immediately if it is the wrong one.',
  ].join('\n'),
  url: 'https://supabase.com/dashboard/account/tokens',
  urlLabel: 'Open Supabase Access Tokens',
  credentialsLabel: 'I have my credentials',
  modalFields: [
    {
      customId: 'supabase_access_token',
      label: 'Personal Access Token (starts with sbp_)',
      placeholder: 'sbp_abc123def456...  (NOT your service_role/anon key)',
      style: 'short',
      required: true,
    },
    // NOTE: there is deliberately NO connection-string field here.
    // migration-runner tries the Management API (access token) FIRST and only
    // falls back to a direct connection when no token exists — so for anyone
    // using Supabase this value is never read. Asking for it made users reset
    // their database password (breaking every other client using it) to supply
    // a credential the bot ignores. Self-hosted Postgres users set
    // SUPABASE_DB_URL in .env instead; it is documented there and hydrated by
    // config-loader exactly the same way.
  ],
  fieldToSettingsKey: {
    supabase_access_token: 'supabase_access_token',
    // Not typed by the operator — fetched from the Management API below and
    // written back into `values` so storeCredentials persists it. The dashboard
    // needs it to sign anyone in, and asking for it by hand was making people
    // hunt through Supabase for a second key they had no way to validate.
    supabase_publishable_key: 'supabase_publishable_key',
  },
  verify: async (values) => {
    const token = values.supabase_access_token?.trim();
    const dbUrl = values.supabase_db_url?.trim();

    if (!token) return 'Access Token is required.';

    // Users routinely paste a PROJECT API key here instead of an ACCOUNT
    // access token — Supabase calls both "keys"/"tokens" in its UI. Those
    // cannot create tables, and the raw Management API answer for them is an
    // opaque 401 ("invalid or expired"), which sends people off regenerating
    // the wrong credential. Name the actual mistake instead.
    if (token.startsWith('eyJ')) {
      return (
        'That is a **project API key** (a JWT), not an account access token. '
        + 'The `anon`/`service_role` keys under Project Settings → API cannot '
        + 'create database tables.\n\nYou need a **Personal Access Token** from '
        + 'Supabase → **Account** → Access Tokens — it starts with `sbp_`.'
      );
    }
    if (token.startsWith('sb_secret_') || token.startsWith('sb_publishable_')) {
      return (
        'That is a **project API key**, not an account access token.\n\nYou need '
        + 'a **Personal Access Token** from Supabase → **Account** → Access '
        + 'Tokens — it starts with `sbp_`.'
      );
    }
    if (!token.startsWith('sbp_')) {
      return (
        'That does not look like a Supabase personal access token — those start '
        + 'with `sbp_`. Generate one at Supabase → **Account** → Access Tokens '
        + '(this is your account settings, not the project settings).'
      );
    }

    // The connection string is an OPTIONAL fallback (see modalFields): with an
    // access token the bot migrates through the Management API and never opens
    // a direct connection. Only validate it when the user actually supplied one.
    if (dbUrl) {
      try {
        const parsed = new URL(dbUrl);
        if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) {
          return `Invalid protocol "${parsed.protocol}" in DB URL. Expected "postgresql:" or "postgres:".`;
        }
      } catch {
        return 'Invalid database URL format. Expected something like `postgresql://postgres:password@host:5432/postgres`.';
      }
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

      // A token that lists *some* projects still cannot migrate THIS one (a
      // token from another account passes the check above). Prove the exact
      // capability migrations need: run a trivial query against this project.
      const projectRef = /https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(process.env.SUPABASE_URL ?? '')?.[1];
      if (projectRef) {
        const probe = await fetch(
          `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'select 1' }),
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!probe.ok) {
          return (
            `That token cannot run migrations on project \`${projectRef}\` `
            + `(HTTP ${probe.status}). Make sure you generated it from the Supabase `
            + 'account that owns this project.'
          );
        }

        // The token is proven against this project — use it to collect the key
        // the dashboard needs, rather than sending the operator back to Supabase.
        await fetchPublishableKey(token, projectRef, values);
      }
    } catch (err) {
      return `Could not reach Supabase Management API. Check your internet connection.\n\`${String(err)}\``;
    }

    // Only when a fallback connection string was actually supplied: prove it
    // connects. Validating URL shape alone used to accept strings that could
    // never work — most commonly Supabase's IPv6-only "Direct connection" URI.
    if (dbUrl) {
      const dbError = await verifyDatabaseConnection(dbUrl);
      if (dbError) return dbError;
    }

    // Steps can be done in any order. If Hosting ran first it had no access
    // token and skipped the Supabase auth wiring, and nothing else revisits it
    // — so setup could report every step green while dashboard sign-in stayed
    // broken. Now that a working token exists, do that deferred wiring here.
    const savedDashboardUrl = process.env.DASHBOARD_URL?.trim();
    if (savedDashboardUrl) {
      // A warning, never a failure: the token itself is already proven, and
      // refusing to store it because a follow-on API call struggled would make
      // the operator redo a step that worked.
      const note = await configureSupabaseAuth(savedDashboardUrl, token);
      if (note) values.__auth_note = note;
    }

    return null;
  },
  successNote: (values) => (
    values.__auth_note
      ? `⚠️ ${values.__auth_note}`
      : 'The bot can now create and update its own database tables.'
  ),
  enableFlag: null,
};

/* ------------------------------------------------------------------ */
/*  Ordered step array                                                 */
/* ------------------------------------------------------------------ */

// Hosting before PayPal, deliberately.
//
// PayPal's webhook target is derived from the dashboard URL, so its verifier
// needs DASHBOARD_URL to exist. With PayPal second, a fresh install following
// the wizard's own guided order hit PayPal, got told to go and do Hosting
// first, and dead-ended — the ordered path only worked for someone who already
// knew to skip ahead. Order the steps by what depends on what.
export const WIZARD_STEPS: WizardStep[] = [
  supabaseManagementStep,
  deploymentStep,
  paypalStep,
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

  if (step.extraButton) {
    const extra = new ButtonBuilder()
      .setCustomId(`setup:${step.id}:${step.extraButton.action}`)
      .setLabel(step.extraButton.label)
      .setStyle(ButtonStyle.Success);
    if (step.extraButton.emoji) extra.setEmoji(step.extraButton.emoji);
    row.addComponents(extra);
  }

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

/** Result of checking whether the saved dashboard URL actually serves anything. */
export interface DashboardProbe {
  url: string | null;
  /** `null` when we did not check — not the same as "checked and down". */
  live: boolean | null;
}

export function buildCompletionEmbed(
  configuredIds: Set<string>,
  probe: DashboardProbe = { url: null, live: null },
): EmbedBuilder {
  const dashboardDown = probe.live === false;

  const lines = WIZARD_STEPS.map((s) => {
    if (!configuredIds.has(s.id)) return `${s.emoji} **${s.title}** — ⏭️ skipped`;
    if (s.id === 'deployment' && dashboardDown) {
      return `${s.emoji} **${s.title}** — ⚠️ saved, but not responding`;
    }
    return `${s.emoji} **${s.title}** — ✅`;
  }).join('\n');

  // "Setup Complete" over a dashboard that does not answer is the exact
  // false-positive this screen used to produce: every step green, and the link
  // it sends the operator to is dead.
  return new EmbedBuilder()
    .setColor(SOMNI_PALETTE.HOT_PINK)
    .setTitle(dashboardDown ? '⚠️ Setup Saved — Dashboard Unreachable' : '🎉 Setup Complete!')
    .setDescription(
      `${lines}\n\n` +
      (dashboardDown
        ? `Every service is configured, but nothing is answering at \`${probe.url}\`, `
          + 'so the dashboard will not load yet. The bot starts it automatically when it '
          + 'is built — if this persists, open the **Hosting** step to recheck the URL.\n\n'
        : 'All external services are configured. Head to the **dashboard** to enable and '
          + 'configure features — moderation, levels, welcome, tickets, commerce, music, '
          + 'and everything else.\n\n')
      + 'Run `/setup` again anytime to reconfigure any service.',
    );
}
