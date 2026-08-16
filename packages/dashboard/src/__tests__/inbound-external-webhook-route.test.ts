import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAdminSupabaseMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/client-ip', () => ({ getClientIp: vi.fn(() => '203.0.113.8') }));
vi.mock('@/lib/api/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/external-webhook-discord', () => ({ sendExternalWebhookDiscordMessage: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: createAdminSupabaseMock }));

import { POST } from '@/app/api/inbound-webhooks/[token]/route';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { sendExternalWebhookDiscordMessage } from '@/lib/external-webhook-discord';
import { hashExternalWebhookValue } from '@/lib/external-webhook-relay';

const token = 'a'.repeat(43);
const endpoint = `http://localhost/api/inbound-webhooks/${token}`;
const allowed = { limited: false, remaining: 10, retryAfterMs: 0 };

function request(body: string, headers: Record<string, string> = {}) {
  return new NextRequest(endpoint, { method: 'POST', body, headers });
}

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    delivery_id: '11111111-1111-4111-8111-111111111111',
    relay_id: '22222222-2222-4222-8222-222222222222',
    guild_id: '333333333333333333',
    source_label: 'Release QA',
    channel_id: '444444444444444444',
    message_template: '**{source} — {event}**\n{content}',
    claim_outcome: 'claimed',
    delivery_status: 'processing',
    existing_request_hash: '',
    discord_message_id: null,
    ...overrides,
  };
}

function adminFor(row: Record<string, unknown>) {
  const rpc = vi.fn(async (functionName: string) => (
    functionName === 'claim_external_webhook_delivery'
      ? { data: [row], error: null }
      : { data: true, error: null }
  ));
  return { admin: { rpc }, rpc };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue(allowed);
  vi.mocked(sendExternalWebhookDiscordMessage).mockResolvedValue({
    status: 'delivered',
    messageId: '555555555555555555',
  });
  process.env.DISCORD_TOKEN = 'test-token';
});

describe('POST /api/inbound-webhooks/[token]', () => {
  it('claims a JSON delivery without persisting the raw body and returns the Discord message id', async () => {
    const body = JSON.stringify({ source: 'agent', event: 'release.ready', content: 'secret body value' });
    const state = adminFor(claimRow());
    createAdminSupabaseMock.mockReturnValue(state.admin);

    const response = await POST(request(body, {
      'content-type': 'application/json',
      'idempotency-key': 'release-1',
    }), { params: Promise.resolve({ token }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      status: 'delivered',
      message_id: '555555555555555555',
    });
    expect(state.rpc).toHaveBeenCalledWith('claim_external_webhook_delivery', {
      p_token_hash: hashExternalWebhookValue(token),
      p_idempotency_key: 'release-1',
      p_request_hash: hashExternalWebhookValue(body),
      p_event_label: 'release.ready',
      p_content_preview: 'secret body value',
    });
    expect(JSON.stringify(state.rpc.mock.calls)).not.toContain(body);
    expect(sendExternalWebhookDiscordMessage).toHaveBeenCalledWith({
      token: 'test-token',
      channelId: '444444444444444444',
      content: '**Release QA — release.ready**\nsecret body value',
    });
  });

  it.each([
    'idempotency-key',
    'x-idempotency-key',
    'x-webhook-id',
    'x-event-id',
    'x-github-delivery',
    'x-request-id',
  ])('accepts %s as an idempotency key', async (header) => {
    const body = 'server online';
    const state = adminFor(claimRow());
    createAdminSupabaseMock.mockReturnValue(state.admin);

    const response = await POST(request(body, {
      'content-type': 'text/plain',
      [header]: 'provider-event-1',
    }), { params: Promise.resolve({ token }) });

    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith('claim_external_webhook_delivery', expect.objectContaining({
      p_idempotency_key: 'provider-event-1',
    }));
  });

  it('returns duplicate evidence without dispatching a second Discord message', async () => {
    const body = 'server online';
    const state = adminFor(claimRow({
      claim_outcome: 'duplicate',
      delivery_status: 'delivered',
      existing_request_hash: hashExternalWebhookValue(body),
      discord_message_id: '666666666666666666',
    }));
    createAdminSupabaseMock.mockReturnValue(state.admin);

    const response = await POST(request(body, {
      'content-type': 'text/plain',
      'x-request-id': 'release-2',
    }), { params: Promise.resolve({ token }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      status: 'duplicate',
      original_status: 'delivered',
      message_id: '666666666666666666',
    });
    expect(sendExternalWebhookDiscordMessage).not.toHaveBeenCalled();
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['processing', 503, 'retryable'],
    ['failed', 502, 'failed'],
  ])('does not acknowledge a duplicate whose original status is %s', async (deliveryStatus, expectedStatus, responseStatus) => {
    const body = 'server online';
    const state = adminFor(claimRow({
      claim_outcome: 'duplicate',
      delivery_status: deliveryStatus,
      existing_request_hash: hashExternalWebhookValue(body),
    }));
    createAdminSupabaseMock.mockReturnValue(state.admin);

    const response = await POST(request(body, { 'idempotency-key': 'release-pending' }), {
      params: Promise.resolve({ token }),
    });

    expect(response.status).toBe(expectedStatus);
    await expect(response.json()).resolves.toMatchObject({ success: false, status: responseStatus });
    expect(sendExternalWebhookDiscordMessage).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key with a different body', async () => {
    const state = adminFor(claimRow({
      claim_outcome: 'duplicate',
      existing_request_hash: hashExternalWebhookValue('first body'),
    }));
    createAdminSupabaseMock.mockReturnValue(state.admin);

    const response = await POST(request('second body', { 'idempotency-key': 'same-key' }), {
      params: Promise.resolve({ token }),
    });

    expect(response.status).toBe(409);
    expect(sendExternalWebhookDiscordMessage).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies before a database claim', async () => {
    const response = await POST(request('x'.repeat((256 * 1024) + 1)), {
      params: Promise.resolve({ token }),
    });

    expect(response.status).toBe(413);
    expect(createAdminSupabaseMock).not.toHaveBeenCalled();
    expect(sendExternalWebhookDiscordMessage).not.toHaveBeenCalled();
  });

  it('enforces the relay and caller IP rate limits', async () => {
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ limited: true, remaining: 0, retryAfterMs: 2_000 })
      .mockResolvedValueOnce(allowed);

    const response = await POST(request('server online'), {
      params: Promise.resolve({ token }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(checkRateLimit).toHaveBeenCalledTimes(2);
    expect(createAdminSupabaseMock).not.toHaveBeenCalled();
  });
});
