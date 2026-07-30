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
  if (config.clientId) process.env.PAYPAL_CLIENT_ID = config.clientId;
  if (config.clientSecret) process.env.PAYPAL_CLIENT_SECRET = config.clientSecret;
  if (config.webhookId) process.env.PAYPAL_WEBHOOK_ID = config.webhookId;
  if (config.webhookUrl) process.env.PAYPAL_WEBHOOK_URL = config.webhookUrl;
  if (config.sandbox) process.env.PAYPAL_SANDBOX = config.sandbox;
  if (config.apiBase) process.env.PAYPAL_API_BASE = config.apiBase;
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
export interface PayPalSubscriptionContract {
  amountCents: number;
  currency: string;
  planId: string;
  nextBillingTime: string;
}

function parsePayPalAmountCents(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    return null;
  }
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export async function getSubscriptionAmount(
  subscriptionId: string,
): Promise<PayPalSubscriptionContract | null> {
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

    const amountCents = parsePayPalAmountCents(amount?.value);
    const currency = typeof amount?.currency_code === 'string'
      ? amount.currency_code.toUpperCase()
      : null;
    const planId = typeof data.plan_id === 'string' ? data.plan_id : null;
    const nextBillingTime = typeof data.billing_info?.next_billing_time === 'string'
      ? data.billing_info.next_billing_time
      : null;
    const nextBillingTimestamp = nextBillingTime === null
      ? Number.NaN
      : Date.parse(nextBillingTime);
    if (
      amountCents == null ||
      !currency ||
      !/^[A-Z]{3}$/.test(currency) ||
      !planId ||
      planId.trim() !== planId ||
      !nextBillingTime ||
      !Number.isFinite(nextBillingTimestamp)
    ) {
      return null;
    }

    return {
      amountCents,
      currency,
      planId,
      nextBillingTime: new Date(nextBillingTimestamp).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * W2: is this HTTP status a transient PayPal-side failure worth retrying?
 * 5xx = PayPal outage, 429 = throttled, 408 = request timeout.
 */
export function isRetriablePayPalStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

export type PayPalTokenResult =
  | { ok: true; token: string }
  | { ok: false; retriable: boolean; reason: string };

/**
 * W2: Fetch a fresh PayPal access token, classifying failures so callers can
 * distinguish transient infrastructure failures (`retriable: true` — network
 * error, timeout, 5xx/429) from permanent configuration problems
 * (`retriable: false` — missing or rejected credentials).
 *
 * Failure `reason` strings only ever contain HTTP status codes and generic
 * fetch error messages — never credentials or tokens — so they are safe to
 * persist in operator-readable tables (alerts, logs).
 */
export async function getPayPalTokenResult(
  config: PayPalRuntimeConfig | null = null,
  options: { timeoutMs?: number } = {},
): Promise<PayPalTokenResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);

  let runtimeConfig: PayPalRuntimeConfig;
  try {
    runtimeConfig = config ?? await getPayPalRuntimeConfig();
  } catch (err) {
    return {
      ok: false,
      retriable: true,
      reason: `PayPal config load failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!runtimeConfig.clientId || !runtimeConfig.clientSecret) {
    return { ok: false, retriable: false, reason: 'PayPal client credentials are not configured' };
  }

  try {
    const res = await fetch(`${runtimeConfig.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${runtimeConfig.clientId}:${runtimeConfig.clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(timeoutMs), // V6 Audit §2.5: prevent hung token fetch
    });
    if (!res.ok) {
      // 4xx (401/403/…) means PayPal rejected the credentials themselves —
      // retrying with the same credentials cannot succeed.
      return {
        ok: false,
        retriable: isRetriablePayPalStatus(res.status),
        reason: `token endpoint returned ${res.status}`,
      };
    }
    const data = await res.json();
    if (typeof data?.access_token !== 'string' || data.access_token.length === 0) {
      return { ok: false, retriable: true, reason: 'token endpoint returned no access_token' };
    }
    return { ok: true, token: data.access_token };
  } catch (err) {
    // AbortSignal timeout or network failure — transient by nature.
    return {
      ok: false,
      retriable: true,
      reason: `token request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Fetch a fresh PayPal access token using client credentials.
 * Returns null if the request fails (missing creds, network error, etc).
 */
export async function getPayPalToken(
  config: PayPalRuntimeConfig | null = null,
): Promise<string | null> {
  const result = await getPayPalTokenResult(config);
  return result.ok ? result.token : null;
}
