import { createHash, randomBytes } from 'node:crypto';

const DISCORD_MESSAGE_LIMIT = 2_000;
export const EXTERNAL_WEBHOOK_BODY_LIMIT = 256 * 1024;
const EVENT_LABEL_LIMIT = 120;
const CONTENT_LIMIT = 1_700;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

export const DEFAULT_EXTERNAL_WEBHOOK_TEMPLATE = '**{source} — {event}**\n{content}';

export interface ExternalWebhookEvent {
  event: string;
  content: string;
}

function cleanText(value: string, maxLength: number): string {
  const cleaned = value.replace(CONTROL_CHARACTERS, '').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${Array.from(cleaned).slice(0, maxLength - 1).join('')}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function firstText(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[Unserializable payload]';
  }
}

export function extractExternalWebhookEvent(rawBody: string, contentType: string | null): ExternalWebhookEvent {
  const body = rawBody.replace(CONTROL_CHARACTERS, '').trim();
  const looksJson = contentType?.toLowerCase().includes('json')
    || body.startsWith('{')
    || body.startsWith('[');
  if (!looksJson) {
    return { event: 'External event', content: cleanText(body || '(empty payload)', CONTENT_LIMIT) };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { event: 'External event', content: cleanText(body || '(empty payload)', CONTENT_LIMIT) };
  }

  const root = recordValue(payload);
  if (!root) {
    return { event: 'External event', content: cleanText(compactJson(payload), CONTENT_LIMIT) };
  }
  const nested = recordValue(root.data) ?? recordValue(root.body);
  const event = firstText(root, ['event', 'event_type', 'type', 'title', 'name'])
    ?? (nested ? firstText(nested, ['event', 'event_type', 'type', 'title', 'name']) : null)
    ?? 'External event';
  const content = firstText(root, ['message', 'content', 'text', 'description'])
    ?? (nested ? firstText(nested, ['message', 'content', 'text', 'description']) : null)
    ?? compactJson(payload);
  return {
    event: cleanText(event.replace(/[\r\n]+/gu, ' '), EVENT_LABEL_LIMIT),
    content: cleanText(content, CONTENT_LIMIT),
  };
}

export function templateUsesOnlySupportedVariables(template: string): boolean {
  const withoutSupportedVariables = template.replace(/\{(?:source|event|content)\}/gu, '');
  return !/[{}]/u.test(withoutSupportedVariables);
}

export function renderExternalWebhookMessage(input: {
  template: string;
  source: string;
  event: string;
  content: string;
}): string {
  const values: Record<string, string> = {
    source: cleanText(input.source.replace(/[\r\n]+/gu, ' '), 80),
    event: cleanText(input.event.replace(/[\r\n]+/gu, ' '), EVENT_LABEL_LIMIT),
    content: cleanText(input.content, CONTENT_LIMIT),
  };
  const rendered = input.template.replace(/\{([a-z_]+)\}/gu, (whole, variable: string) => (
    values[variable] ?? whole
  )).trim();
  if (rendered.length <= DISCORD_MESSAGE_LIMIT) return rendered;
  return `${Array.from(rendered).slice(0, DISCORD_MESSAGE_LIMIT - 1).join('')}…`;
}

export function hashExternalWebhookValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createExternalWebhookToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashExternalWebhookValue(token) };
}

export function buildExternalWebhookReceiverUrl(publicAppUrl: string, token: string): string {
  let base: URL;
  try {
    base = new URL(publicAppUrl);
  } catch {
    throw new Error('A valid public app URL is required to create a webhook receiver.');
  }
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) {
    throw new Error('A trusted HTTPS public app URL is required to create a webhook receiver.');
  }
  return new URL(`/api/inbound-webhooks/${encodeURIComponent(token)}`, base.origin).toString();
}

export async function readExternalWebhookBody(
  request: Request,
): Promise<{ ok: true; body: string } | { ok: false; reason: 'too_large' | 'unreadable' }> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > EXTERNAL_WEBHOOK_BODY_LIMIT) {
      return { ok: false, reason: 'too_large' };
    }
  }

  if (request.body === null) return { ok: true, body: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > EXTERNAL_WEBHOOK_BODY_LIMIT) {
        await reader.cancel();
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(next.value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: new TextDecoder().decode(bytes) };
}
