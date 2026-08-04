import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  PAYPAL_SANDBOX_API_BASE,
  PAYPAL_WEBHOOK_EVENT_TYPES,
  ensurePayPalWebhook,
} from '../main/paypal-webhook-service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tokenResponse(): Response {
  return jsonResponse({ access_token: 'paypal-access-token' });
}

function webhookUrlConflictResponse(): Response {
  return jsonResponse({
    name: 'WEBHOOK_URL_ALREADY_EXISTS',
    message: 'Webhook URL already exists.',
  }, 400);
}

function webhook(id: string, url: string, events = PAYPAL_WEBHOOK_EVENT_TYPES) {
  return {
    id,
    url,
    event_types: events.map(name => ({ name })),
  };
}

const baseInput = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  webhookUrl: 'https://somnibot.tailnet.ts.net/api/paypal/webhook',
  sandbox: true,
};

describe('PayPal webhook service', () => {
  it('keeps launcher webhook event catalog aligned with the dashboard handler catalog', () => {
    const dashboardSource = readFileSync(
      path.join(repoRoot, 'packages/dashboard/src/lib/paypal-webhook-events.ts'),
      'utf8',
    );
    const dashboardEvents = Array.from(dashboardSource.matchAll(/eventType: '([^']+)'/g))
      .map(match => match[1]);

    expect(PAYPAL_WEBHOOK_EVENT_TYPES).toEqual(dashboardEvents);
  });

  it('blocks before calling PayPal when the webhook URL is not public HTTPS', async () => {
    const fetchImpl = vi.fn();

    const result = await ensurePayPalWebhook({
      ...baseInput,
      webhookUrl: 'http://localhost:3456/api/paypal/webhook',
    }, { fetch: fetchImpl as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.error).toContain('public callback setup');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('creates a webhook with the full handled event catalog when none exists', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ webhooks: [] }))
      .mockResolvedValueOnce(jsonResponse(webhook('WH-CREATED', baseInput.webhookUrl)));

    const result = await ensurePayPalWebhook(baseInput, { fetch: fetchImpl as unknown as typeof fetch });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('created');
    expect(result.webhookId).toBe('WH-CREATED');
    expect(fetchImpl).toHaveBeenCalledWith(
      `${PAYPAL_SANDBOX_API_BASE}/v1/oauth2/token`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenLastCalledWith(
      `${PAYPAL_SANDBOX_API_BASE}/v1/notifications/webhooks`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          url: baseInput.webhookUrl,
          event_types: PAYPAL_WEBHOOK_EVENT_TYPES.map(name => ({ name })),
        }),
      }),
    );
  });

  it('trims pasted PayPal app credentials before requesting an access token', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ webhooks: [] }))
      .mockResolvedValueOnce(jsonResponse(webhook('WH-CREATED', baseInput.webhookUrl)));

    await ensurePayPalWebhook({
      ...baseInput,
      clientId: ' client-id ',
      clientSecret: ' client-secret ',
    }, { fetch: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${PAYPAL_SANDBOX_API_BASE}/v1/oauth2/token`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
        }),
      }),
    );
  });

  it('matches existing webhooks even when PayPal returns the URL with a trailing slash', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        webhooks: [webhook('WH-TRAILING', `${baseInput.webhookUrl}/`)],
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await ensurePayPalWebhook(baseInput, { fetch: fetchImpl as unknown as typeof fetch });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('updated');
    expect(result.webhookId).toBe('WH-TRAILING');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      `${PAYPAL_SANDBOX_API_BASE}/v1/notifications/webhooks/WH-TRAILING`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify([
          { op: 'replace', path: '/url', value: baseInput.webhookUrl },
        ]),
      }),
    );
  });

  it('recovers a URL conflict when a normalized application match needs an update', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        webhooks: [webhook('WH-APP', `${baseInput.webhookUrl}/`, ['CHECKOUT.ORDER.APPROVED'])],
      }))
      .mockResolvedValueOnce(webhookUrlConflictResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await ensurePayPalWebhook(baseInput, { fetch: fetchImpl as unknown as typeof fetch });

    expect(result).toMatchObject({ ok: true, status: 'updated', webhookId: 'WH-APP' });
    const calls = fetchImpl.mock.calls;
    expect(calls.filter(([url, init]) => String(url).endsWith('/v1/notifications/webhooks')
      && (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
    expect(calls.some(([url]) => String(url).includes('anchor_type=ACCOUNT'))).toBe(false);
    expect(calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
    expect((calls.at(-1)?.[1] as RequestInit).body).toBe(JSON.stringify([
      {
        op: 'replace',
        path: '/event_types',
        value: PAYPAL_WEBHOOK_EVENT_TYPES.map(name => ({ name })),
      },
    ]));
  });

  it('updates an existing webhook ID when URL or event subscriptions drift', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(webhook('WH-EXISTING', 'https://old.example.com/api/paypal/webhook', [
        'CHECKOUT.ORDER.APPROVED',
      ])))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await ensurePayPalWebhook({
      ...baseInput,
      webhookId: 'WH-EXISTING',
    }, { fetch: fetchImpl as unknown as typeof fetch });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('updated');
    expect(result.webhookId).toBe('WH-EXISTING');
    expect(fetchImpl).toHaveBeenLastCalledWith(
      `${PAYPAL_SANDBOX_API_BASE}/v1/notifications/webhooks/WH-EXISTING`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify([
          { op: 'replace', path: '/url', value: baseInput.webhookUrl },
          {
            op: 'replace',
            path: '/event_types',
            value: PAYPAL_WEBHOOK_EVENT_TYPES.map(name => ({ name })),
          },
        ]),
      }),
    );
  });

  it('recovers a stale saved webhook id by matching the existing callback URL', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ name: 'INVALID_RESOURCE_ID' }, 400))
      .mockResolvedValueOnce(jsonResponse({
        webhooks: [webhook('WH-RECOVERED', baseInput.webhookUrl, ['CHECKOUT.ORDER.APPROVED'])],
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await ensurePayPalWebhook({
      ...baseInput,
      webhookId: 'WH-STALE',
    }, { fetch: fetchImpl as unknown as typeof fetch });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('updated');
    expect(result.webhookId).toBe('WH-RECOVERED');
    expect(fetchImpl).toHaveBeenLastCalledWith(
      `${PAYPAL_SANDBOX_API_BASE}/v1/notifications/webhooks/WH-RECOVERED`,
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('recovers a URL conflict from the account anchor without deleting or recreating', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(webhook('WH-OLD', 'https://old.example.com/api/paypal/webhook', [
        'CHECKOUT.ORDER.APPROVED',
      ])))
      .mockResolvedValueOnce(webhookUrlConflictResponse())
      .mockResolvedValueOnce(jsonResponse({ webhooks: [] }))
      .mockResolvedValueOnce(jsonResponse({
        webhooks: [webhook('WH-ACCOUNT', baseInput.webhookUrl, ['CHECKOUT.ORDER.APPROVED'])],
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await ensurePayPalWebhook({
      ...baseInput,
      webhookId: 'WH-OLD',
    }, { fetch: fetchImpl as unknown as typeof fetch });

    expect(result).toMatchObject({ ok: true, status: 'updated', webhookId: 'WH-ACCOUNT' });
    const calls = fetchImpl.mock.calls;
    expect(calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toHaveLength(0);
    expect(calls.filter(([url, init]) => String(url).endsWith('/v1/notifications/webhooks')
      && (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
    expect(calls.some(([url]) => String(url).endsWith('/v1/notifications/webhooks?anchor_type=ACCOUNT'))).toBe(true);
    expect(calls.at(-1)?.[0]).toBe(`${PAYPAL_SANDBOX_API_BASE}/v1/notifications/webhooks/WH-ACCOUNT`);
    expect((calls.at(-1)?.[1] as RequestInit).body).toBe(JSON.stringify([
      {
        op: 'replace',
        path: '/event_types',
        value: PAYPAL_WEBHOOK_EVENT_TYPES.map(name => ({ name })),
      },
    ]));
  });

  it('recovers a create race by rediscovering the existing account webhook without a second POST', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ webhooks: [] }))
      .mockResolvedValueOnce(webhookUrlConflictResponse())
      .mockResolvedValueOnce(jsonResponse({ webhooks: [] }))
      .mockResolvedValueOnce(jsonResponse({
        webhooks: [webhook('WH-RACE', baseInput.webhookUrl, ['CHECKOUT.ORDER.APPROVED'])],
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await ensurePayPalWebhook(baseInput, { fetch: fetchImpl as unknown as typeof fetch });

    expect(result).toMatchObject({ ok: true, status: 'updated', webhookId: 'WH-RACE' });
    const postWebhookCalls = fetchImpl.mock.calls.filter(([url, init]) => (
      String(url).endsWith('/v1/notifications/webhooks')
      && (init as RequestInit | undefined)?.method === 'POST'
    ));
    expect(postWebhookCalls).toHaveLength(1);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/v1/notifications/webhooks?anchor_type=ACCOUNT'))).toBe(true);
    expect(fetchImpl.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });

  it('reuses an already-correct webhook without patching it', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(webhook('WH-READY', baseInput.webhookUrl)));

    const result = await ensurePayPalWebhook({
      ...baseInput,
      webhookId: 'WH-READY',
    }, { fetch: fetchImpl as unknown as typeof fetch });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('already-configured');
    expect(result.webhookId).toBe('WH-READY');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not leak the client secret in PayPal API errors', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        name: 'AUTHENTICATION_FAILURE',
        message: 'Authentication failed.',
      }, 401));

    const result = await ensurePayPalWebhook(baseInput, { fetch: fetchImpl as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('AUTHENTICATION_FAILURE');
    expect(result.error).not.toContain(baseInput.clientSecret);
  });
});
