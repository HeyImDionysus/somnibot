/**
 * Shared PayPal utilities — single source of truth for PayPal API auth.
 *
 * Previously duplicated in:
 *   - /api/orders/[id]/refund/route.ts
 *   - /api/paypal/webhook/route.ts
 *   - /api/store/products/route.ts
 */
import { createAdminSupabase } from './supabase/admin';

const PAYPAL_SANDBOX_API_BASE = 'https://api-m.sandbox.paypal.com';
const PAYPAL_LIVE_API_BASE = 'https://api-m.paypal.com';

export const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE
  || (process.env.PAYPAL_SANDBOX === 'false' ? PAYPAL_LIVE_API_BASE : PAYPAL_SANDBOX_API_BASE);

type PayPalConfigSource = 'env' | 'saved' | 'derived' | 'missing';

export interface PayPalRuntimeConfig {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  webhookId: string;
  webhookUrl: string;
  sandbox: boolean;
  sources: {
    apiBase: PayPalConfigSource;
    clientId: PayPalConfigSource;
    clientSecret: PayPalConfigSource;
    webhookId: PayPalConfigSource;
    webhookUrl: PayPalConfigSource;
    sandbox: PayPalConfigSource;
  };
}

interface SavedPayPalSetting {
  key: string;
  value: string | null;
}

export const PAYPAL_RUNTIME_SETTING_KEYS = [
  'paypal_client_id',
  'paypal_client_secret',
  'paypal_webhook_id',
  'paypal_webhook_url',
  'paypal_sandbox',
  'paypal_api_base',
] as const;

function parseSandbox(value: string | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'sandbox'].includes(normalized)) return true;
  if (['false', '0', 'no', 'live', 'production'].includes(normalized)) return false;
  return null;
}

function baseForSandbox(sandbox: boolean) {
  return sandbox ? PAYPAL_SANDBOX_API_BASE : PAYPAL_LIVE_API_BASE;
}

function savedMap(settings: SavedPayPalSetting[] | null | undefined) {
  return new Map(
    (settings ?? [])
      .filter((row): row is { key: string; value: string } => typeof row.value === 'string' && row.value.length > 0)
      .map((row) => [row.key, row.value]),
  );
}

export function readEnvPayPalConfig(env: NodeJS.ProcessEnv = process.env): PayPalRuntimeConfig {
  const envSandbox = parseSandbox(env.PAYPAL_SANDBOX);
  const sandbox = envSandbox ?? true;
  const apiBase = env.PAYPAL_API_BASE || baseForSandbox(sandbox);

  return {
    apiBase,
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
    webhookUrl: env.PAYPAL_WEBHOOK_URL || '',
    sandbox,
    sources: {
      apiBase: env.PAYPAL_API_BASE ? 'env' : 'derived',
      clientId: env.PAYPAL_CLIENT_ID ? 'env' : 'missing',
      clientSecret: env.PAYPAL_CLIENT_SECRET ? 'env' : 'missing',
      webhookId: env.PAYPAL_WEBHOOK_ID ? 'env' : 'missing',
      webhookUrl: env.PAYPAL_WEBHOOK_URL ? 'env' : 'missing',
      sandbox: env.PAYPAL_SANDBOX ? 'env' : 'derived',
    },
  };
}

export function mergeSavedPayPalConfig(
  config: PayPalRuntimeConfig,
  settings: SavedPayPalSetting[] | null | undefined,
): PayPalRuntimeConfig {
  const saved = savedMap(settings);
  const savedSandbox = parseSandbox(saved.get('paypal_sandbox'));
  const sandbox = config.sources.sandbox === 'env'
    ? config.sandbox
    : savedSandbox ?? config.sandbox;
  const savedApiBase = saved.get('paypal_api_base') || '';
  const apiBase = config.sources.apiBase === 'env'
    ? config.apiBase
    : savedApiBase || baseForSandbox(sandbox);

  return {
    apiBase,
    clientId: config.clientId || saved.get('paypal_client_id') || '',
    clientSecret: config.clientSecret || saved.get('paypal_client_secret') || '',
    webhookId: config.webhookId || saved.get('paypal_webhook_id') || '',
    webhookUrl: config.webhookUrl || saved.get('paypal_webhook_url') || '',
    sandbox,
    sources: {
      apiBase: config.sources.apiBase === 'env' ? 'env' : savedApiBase ? 'saved' : 'derived',
      clientId: config.clientId ? config.sources.clientId : saved.get('paypal_client_id') ? 'saved' : 'missing',
      clientSecret: config.clientSecret ? config.sources.clientSecret : saved.get('paypal_client_secret') ? 'saved' : 'missing',
      webhookId: config.webhookId ? config.sources.webhookId : saved.get('paypal_webhook_id') ? 'saved' : 'missing',
      webhookUrl: config.webhookUrl ? config.sources.webhookUrl : saved.get('paypal_webhook_url') ? 'saved' : 'missing',
      sandbox: config.sources.sandbox === 'env' ? 'env' : savedSandbox === null ? 'derived' : 'saved',
    },
  };
}

export function applyRuntimePayPalEnv(config: {
  clientId?: string;
  clientSecret?: string;
  webhookId?: string;
  webhookUrl?: string;
  sandbox?: string;
  apiBase?: string;
}) {
  if (config.clientId) process.env.PAYPAL_CLIENT_ID ||= config.clientId;
  if (config.clientSecret) process.env.PAYPAL_CLIENT_SECRET ||= config.clientSecret;
  if (config.webhookId) process.env.PAYPAL_WEBHOOK_ID ||= config.webhookId;
  if (config.webhookUrl) process.env.PAYPAL_WEBHOOK_URL ||= config.webhookUrl;
  if (config.sandbox) process.env.PAYPAL_SANDBOX ||= config.sandbox;
  if (config.apiBase) process.env.PAYPAL_API_BASE ||= config.apiBase;
}

async function readSavedPayPalSettings(): Promise<SavedPayPalSetting[]> {
  try {
    const admin = createAdminSupabase();
    const { data } = await admin
      .from('instance_settings')
      .select('key, value')
      .in('key', [...PAYPAL_RUNTIME_SETTING_KEYS])
      .limit(1000);

    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('[PayPal] Could not read saved PayPal settings; falling back to env:', err);
    return [];
  }
}

export async function getPayPalRuntimeConfig(): Promise<PayPalRuntimeConfig> {
  const envConfig = readEnvPayPalConfig();
  if (
    envConfig.clientId
    && envConfig.clientSecret
    && envConfig.webhookId
    && envConfig.webhookUrl
    && envConfig.sources.sandbox === 'env'
    && envConfig.sources.apiBase === 'env'
  ) {
    return envConfig;
  }

  return mergeSavedPayPalConfig(envConfig, await readSavedPayPalSettings());
}

export async function getPayPalApiBase(): Promise<string> {
  const config = await getPayPalRuntimeConfig();
  return config.apiBase;
}

export async function getPayPalWebhookId(): Promise<string> {
  const config = await getPayPalRuntimeConfig();
  return config.webhookId;
}

/**
 * V5-Audit §2.1 — Fetch the billing plan amount for a subscription.
 *
 * PayPal's BILLING.SUBSCRIPTION.ACTIVATED webhook doesn't include
 * the first payment amount. This queries the subscription details API
 * to retrieve the plan's billing amount, so the initial order row
 * can record the real amount_cents instead of 0.
 *
 * Returns amount in cents and the currency code, or null on failure.
 */
export async function getSubscriptionAmount(
  subscriptionId: string,
): Promise<{ amountCents: number; currency: string } | null> {
  try {
    const config = await getPayPalRuntimeConfig();
    const token = await getPayPalToken(config);
    if (!token) return null;

    const res = await fetch(
      `${config.apiBase}/v1/billing/subscriptions/${subscriptionId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;

    const data = await res.json();
    // billing_info.last_payment is present once first payment settles;
    // fall back to plan's fixed_price for newly-activated subscriptions.
    const amount =
      data.billing_info?.last_payment?.amount ??
      data.plan?.billing_cycles?.[0]?.pricing_scheme?.fixed_price;

    if (!amount?.value) return null;

    const cents = Math.round(parseFloat(amount.value) * 100);
    if (!Number.isFinite(cents) || cents < 0) return null;

    return { amountCents: cents, currency: (amount.currency_code ?? 'USD').toUpperCase() };
  } catch {
    // Non-critical — order still created, amount updated on PAYMENT.SALE.COMPLETED
    return null;
  }
}

/**
 * Fetch a fresh PayPal access token using client credentials.
 * Returns null if the request fails (missing creds, network error, etc).
 */
export async function getPayPalToken(
  config: PayPalRuntimeConfig | null = null,
): Promise<string | null> {
  try {
    const runtimeConfig = config ?? await getPayPalRuntimeConfig();
    if (!runtimeConfig.clientId || !runtimeConfig.clientSecret) return null;

    const res = await fetch(`${runtimeConfig.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${runtimeConfig.clientId}:${runtimeConfig.clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000), // V6 Audit §2.5: prevent hung token fetch
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token;
  } catch {
    return null;
  }
}
