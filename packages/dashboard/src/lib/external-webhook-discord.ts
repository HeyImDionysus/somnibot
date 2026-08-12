const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_TIMEOUT_MS = 8_000;
const DISCORD_MESSAGE_LIMIT = 2_000;
const SNOWFLAKE = /^\d{17,20}$/u;

export type ExternalWebhookDiscordResult =
  | { status: 'delivered'; messageId: string }
  | { status: 'retryable'; error: string; retryAfterMs: number }
  | { status: 'failed'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get('retry-after');
  if (raw === null) return 1_000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return 1_000;
  return Math.min(Math.ceil(seconds * 1_000), 120_000);
}

export async function sendExternalWebhookDiscordMessage(input: {
  token: string;
  channelId: string;
  content: string;
}): Promise<ExternalWebhookDiscordResult> {
  if (input.token.trim() === '') {
    return { status: 'failed', error: 'Discord delivery is not configured.' };
  }
  if (!SNOWFLAKE.test(input.channelId)) {
    return { status: 'failed', error: 'The configured Discord channel is invalid.' };
  }
  if (input.content.length === 0 || input.content.length > DISCORD_MESSAGE_LIMIT) {
    return { status: 'failed', error: 'The rendered Discord message is invalid.' };
  }

  let response: Response;
  try {
    response = await fetch(`${DISCORD_API}/channels/${input.channelId}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bot ${input.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        content: input.content,
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    return { status: 'retryable', error: 'Discord is temporarily unavailable.', retryAfterMs: 1_000 };
  }

  if (response.status === 429 || response.status >= 500) {
    return {
      status: 'retryable',
      error: 'Discord is temporarily unavailable.',
      retryAfterMs: retryAfterMs(response),
    };
  }
  if (!response.ok) {
    return {
      status: 'failed',
      error: response.status === 401
        ? 'Discord delivery is not configured.'
        : 'Discord rejected the configured channel or permissions.',
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: 'retryable', error: 'Discord returned an incomplete delivery receipt.', retryAfterMs: 1_000 };
  }
  if (!isRecord(payload) || typeof payload.id !== 'string' || !SNOWFLAKE.test(payload.id)) {
    return { status: 'retryable', error: 'Discord returned an incomplete delivery receipt.', retryAfterMs: 1_000 };
  }
  return { status: 'delivered', messageId: payload.id };
}
