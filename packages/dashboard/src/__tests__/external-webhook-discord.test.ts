import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendExternalWebhookDiscordMessage } from '@/lib/external-webhook-discord';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('external webhook Discord delivery', () => {
  it('disables mentions and returns the real Discord message id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: '12345678901234567' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendExternalWebhookDiscordMessage({
      token: 'secret',
      channelId: '22345678901234567',
      content: '@everyone server online',
    })).resolves.toEqual({ status: 'delivered', messageId: '12345678901234567' });

    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe('https://discord.com/api/v10/channels/22345678901234567/messages');
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      content: '@everyone server online',
      allowed_mentions: { parse: [] },
    });
  });

  it('classifies Discord throttling as retryable without exposing response bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider detail', {
      status: 429,
      headers: { 'retry-after': '2' },
    })));

    await expect(sendExternalWebhookDiscordMessage({
      token: 'secret',
      channelId: '22345678901234567',
      content: 'server online',
    })).resolves.toEqual({ status: 'retryable', error: 'Discord is temporarily unavailable.', retryAfterMs: 2_000 });
  });

  it('classifies permission failures as permanent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider detail', { status: 403 })));

    await expect(sendExternalWebhookDiscordMessage({
      token: 'secret',
      channelId: '22345678901234567',
      content: 'server online',
    })).resolves.toEqual({ status: 'failed', error: 'Discord rejected the configured channel or permissions.' });
  });
});
