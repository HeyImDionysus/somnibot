export const PAYPAL_SANDBOX_API_BASE = 'https://api-m.sandbox.paypal.com';
export const PAYPAL_LIVE_API_BASE = 'https://api-m.paypal.com';

export const PAYPAL_WEBHOOK_EVENT_TYPES = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED',
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.CAPTURE.DENIED',
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
] as const;

type PayPalWebhookEventType = typeof PAYPAL_WEBHOOK_EVENT_TYPES[number];

interface PayPalWebhook {
  id: string;
  url: string;
  event_types?: Array<{ name?: string }>;
}

interface PayPalWebhookListResponse {
  webhooks?: PayPalWebhook[];
}

interface PayPalTokenResponse {
  access_token?: string;
}

export interface EnsurePayPalWebhookInput {
  clientId: string;
  clientSecret: string;
  webhookId?: string;
  webhookUrl: string;
  sandbox: boolean;
}

export type EnsurePayPalWebhookStatus = 'created' | 'updated' | 'already-configured' | 'blocked' | 'failed';

export interface EnsurePayPalWebhookResult {
  ok: boolean;
  status: EnsurePayPalWebhookStatus;
  message: string;
  webhookId?: string;
  webhookUrl: string;
  apiBase: string;
  eventTypes: PayPalWebhookEventType[];
  error?: string;
  servicesRestarted?: boolean;
}

interface PayPalRequestOptions {
  method?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface EnsurePayPalWebhookDeps {
  fetch?: typeof fetch;
}

class PayPalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PayPalApiError';
  }
}

export function getPayPalApiBase(sandbox: boolean): string {
  return sandbox ? PAYPAL_SANDBOX_API_BASE : PAYPAL_LIVE_API_BASE;
}

function normalizeWebhookUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function eventTypeNames(webhook: PayPalWebhook): string[] {
  return (webhook.event_types || [])
    .map(event => event.name || '')
    .filter(Boolean)
    .sort();
}

function configuredEventTypesMatch(webhook: PayPalWebhook): boolean {
  const expected = [...PAYPAL_WEBHOOK_EVENT_TYPES].sort();
  const actual = eventTypeNames(webhook);
  return expected.length === actual.length
    && expected.every((eventType, index) => actual[index] === eventType);
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

function safePayPalError(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const candidate = body as { name?: unknown; message?: unknown; details?: unknown };
    const name = typeof candidate.name === 'string' ? candidate.name : '';
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    const detail = Array.isArray(candidate.details) && candidate.details.length > 0
      ? ' See PayPal developer dashboard for request details.'
      : '';
    return [`PayPal API returned HTTP ${status}.`, name, message].filter(Boolean).join(' ') + detail;
  }
  return `PayPal API returned HTTP ${status}.`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function paypalRequest<T>(
  apiBase: string,
  path: string,
  options: PayPalRequestOptions,
  fetchImpl: typeof fetch,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetchImpl(`${apiBase}${path}`, {
    method: options.method || 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const json = await readJson(response);
  if (!response.ok) {
    throw new PayPalApiError(safePayPalError(response.status, json), response.status);
  }
  return json as T;
}

async function getAccessToken(
  input: EnsurePayPalWebhookInput,
  apiBase: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: basicAuthHeader(input.clientId, input.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await readJson(response) as PayPalTokenResponse | null;
  if (!response.ok) {
    throw new PayPalApiError(safePayPalError(response.status, json), response.status);
  }
  if (!json?.access_token) {
    throw new PayPalApiError('PayPal did not return an access token.', response.status);
  }
  return json.access_token;
}

async function getWebhookById(
  apiBase: string,
  token: string,
  webhookId: string,
  fetchImpl: typeof fetch,
): Promise<PayPalWebhook | null> {
  try {
    return await paypalRequest<PayPalWebhook>(
      apiBase,
      `/v1/notifications/webhooks/${encodeURIComponent(webhookId)}`,
      { token },
      fetchImpl,
    );
  } catch (err) {
    if (err instanceof PayPalApiError && err.status === 404) return null;
    throw err;
  }
}

async function listWebhooks(
  apiBase: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<PayPalWebhook[]> {
  const response = await paypalRequest<PayPalWebhookListResponse>(
    apiBase,
    '/v1/notifications/webhooks',
    { token },
    fetchImpl,
  );
  return response.webhooks || [];
}

function webhookNeedsUpdate(webhook: PayPalWebhook, webhookUrl: string): boolean {
  return webhook.url !== webhookUrl || !configuredEventTypesMatch(webhook);
}

function webhookUrlMatches(webhook: PayPalWebhook, webhookUrl: string): boolean {
  return normalizeWebhookUrl(webhook.url) === webhookUrl;
}

async function updateWebhook(
  apiBase: string,
  token: string,
  webhook: PayPalWebhook,
  webhookUrl: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const patch: Array<{ op: 'replace'; path: string; value: unknown }> = [];
  if (webhook.url !== webhookUrl) {
    patch.push({ op: 'replace', path: '/url', value: webhookUrl });
  }
  if (!configuredEventTypesMatch(webhook)) {
    patch.push({
      op: 'replace',
      path: '/event_types',
      value: PAYPAL_WEBHOOK_EVENT_TYPES.map(name => ({ name })),
    });
  }
  if (patch.length === 0) return;

  await paypalRequest(
    apiBase,
    `/v1/notifications/webhooks/${encodeURIComponent(webhook.id)}`,
    {
      method: 'PATCH',
      token,
      body: patch,
    },
    fetchImpl,
  );
}

async function createWebhook(
  apiBase: string,
  token: string,
  webhookUrl: string,
  fetchImpl: typeof fetch,
): Promise<PayPalWebhook> {
  return paypalRequest<PayPalWebhook>(
    apiBase,
    '/v1/notifications/webhooks',
    {
      method: 'POST',
      token,
      body: {
        url: webhookUrl,
        event_types: PAYPAL_WEBHOOK_EVENT_TYPES.map(name => ({ name })),
      },
    },
    fetchImpl,
  );
}

function result(
  status: EnsurePayPalWebhookStatus,
  message: string,
  webhookUrl: string,
  apiBase: string,
  options: { webhookId?: string; error?: string } = {},
): EnsurePayPalWebhookResult {
  return {
    ok: ['created', 'updated', 'already-configured'].includes(status),
    status,
    message,
    webhookUrl,
    apiBase,
    eventTypes: [...PAYPAL_WEBHOOK_EVENT_TYPES],
    ...(options.webhookId ? { webhookId: options.webhookId } : {}),
    ...(options.error ? { error: options.error } : {}),
  };
}

export async function ensurePayPalWebhook(
  input: EnsurePayPalWebhookInput,
  deps: EnsurePayPalWebhookDeps = {},
): Promise<EnsurePayPalWebhookResult> {
  const apiBase = getPayPalApiBase(input.sandbox);
  const webhookUrl = normalizeWebhookUrl(input.webhookUrl);
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  if (!clientId || !clientSecret) {
    return result('blocked', 'PayPal Client ID and Client Secret are required.', webhookUrl, apiBase, {
      error: 'Fill in PayPal Client ID and Client Secret first.',
    });
  }
  if (!webhookUrl || !webhookUrl.startsWith('https://')) {
    return result('blocked', 'PayPal webhook URL must be a public HTTPS URL.', webhookUrl, apiBase, {
      error: 'Finish public callback setup before creating the PayPal webhook.',
    });
  }

  const fetchImpl = deps.fetch || fetch;
  try {
    const token = await getAccessToken({ ...input, clientId, clientSecret }, apiBase, fetchImpl);
    const existingById = input.webhookId?.trim()
      ? await getWebhookById(apiBase, token, input.webhookId.trim(), fetchImpl)
      : null;
    if (existingById) {
      if (webhookNeedsUpdate(existingById, webhookUrl)) {
        await updateWebhook(apiBase, token, existingById, webhookUrl, fetchImpl);
        return result('updated', 'Updated the existing PayPal webhook URL and event subscriptions.', webhookUrl, apiBase, {
          webhookId: existingById.id,
        });
      }
      return result('already-configured', 'PayPal webhook is already configured for this callback URL and event catalog.', webhookUrl, apiBase, {
        webhookId: existingById.id,
      });
    }

    const matchingWebhook = (await listWebhooks(apiBase, token, fetchImpl))
      .find(webhook => webhookUrlMatches(webhook, webhookUrl));
    if (matchingWebhook) {
      if (webhookNeedsUpdate(matchingWebhook, webhookUrl)) {
        await updateWebhook(apiBase, token, matchingWebhook, webhookUrl, fetchImpl);
        return result('updated', 'Updated the matching PayPal webhook event subscriptions.', webhookUrl, apiBase, {
          webhookId: matchingWebhook.id,
        });
      }
      return result('already-configured', 'Found an existing PayPal webhook for this callback URL.', webhookUrl, apiBase, {
        webhookId: matchingWebhook.id,
      });
    }

    const created = await createWebhook(apiBase, token, webhookUrl, fetchImpl);
    return result('created', 'Created a PayPal webhook for this callback URL.', webhookUrl, apiBase, {
      webhookId: created.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return result('failed', 'PayPal webhook setup failed.', webhookUrl, apiBase, {
      error: message,
    });
  }
}
