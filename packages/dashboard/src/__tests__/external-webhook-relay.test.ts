import { describe, expect, it } from 'vitest';
import {
  buildExternalWebhookReceiverUrl,
  createExternalWebhookToken,
  DEFAULT_EXTERNAL_WEBHOOK_TEMPLATE,
  extractExternalWebhookEvent,
  readExternalWebhookBody,
  renderExternalWebhookMessage,
  templateUsesOnlySupportedVariables,
} from '@/lib/external-webhook-relay';

describe('external webhook relay formatting', () => {
  it('turns a Rust-style event into the default Discord message', () => {
    const event = extractExternalWebhookEvent(JSON.stringify({
      event: 'server.started',
      message: 'Map wipe completed',
      players: 42,
    }), 'application/json');

    expect(event).toEqual({ event: 'server.started', content: 'Map wipe completed' });
    expect(renderExternalWebhookMessage({
      template: DEFAULT_EXTERNAL_WEBHOOK_TEMPLATE,
      source: 'Rust server',
      ...event,
    })).toBe('**Rust server — server.started**\nMap wipe completed');
  });

  it('keeps arbitrary JSON useful without storing or requiring a format adapter', () => {
    const event = extractExternalWebhookEvent(
      JSON.stringify({ player: 'Dionysus', action: 'connected', population: 17 }),
      'application/json',
    );

    expect(event.event).toBe('External event');
    expect(event.content).toContain('"player":"Dionysus"');
    expect(event.content).toContain('"population":17');
  });

  it('accepts plain text and removes control characters', () => {
    expect(extractExternalWebhookEvent('server online\u0000', 'text/plain')).toEqual({
      event: 'External event',
      content: 'server online',
    });
  });

  it('rejects ambiguous template variables', () => {
    expect(templateUsesOnlySupportedVariables('{source}: {event}\n{content}')).toBe(true);
    expect(templateUsesOnlySupportedVariables('{source}: {secret}')).toBe(false);
  });

  it('never exceeds Discord message limits even with long unbroken payloads', () => {
    const rendered = renderExternalWebhookMessage({
      template: '{source}\n{event}\n{content}',
      source: 'Service',
      event: 'Event',
      content: 'x'.repeat(10_000),
    });

    expect(rendered.length).toBeLessThanOrEqual(2_000);
    expect(rendered.endsWith('…')).toBe(true);
  });

  it('truncates astral Unicode using the sender length limit without splitting a surrogate pair', () => {
    const rendered = renderExternalWebhookMessage({
      template: '{content}',
      source: 'Service',
      event: 'Event',
      content: '😀'.repeat(1_700),
    });

    expect(rendered.length).toBeLessThanOrEqual(2_000);
    expect(rendered.endsWith('…')).toBe(true);
    expect(rendered).not.toContain('\uFFFD');
  });

  it('creates a one-time receiver token and stores only its SHA-256 hash', () => {
    const credential = createExternalWebhookToken();

    expect(credential.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credential.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(credential.tokenHash).not.toContain(credential.token);
  });

  it('builds receiver URLs from the trusted configured origin', () => {
    expect(buildExternalWebhookReceiverUrl('https://bot.example.test/dashboard', 'abc_DEF-123'))
      .toBe('https://bot.example.test/api/inbound-webhooks/abc_DEF-123');
    expect(() => buildExternalWebhookReceiverUrl('javascript:alert(1)', 'abc'))
      .toThrow('public app URL');
  });

  it('bounds streamed request bodies before decoding them', async () => {
    const accepted = await readExternalWebhookBody(new Request('https://example.test', {
      method: 'POST',
      body: 'server online',
    }));
    expect(accepted).toEqual({ ok: true, body: 'server online' });

    const rejected = await readExternalWebhookBody(new Request('https://example.test', {
      method: 'POST',
      body: 'x'.repeat(256 * 1024 + 1),
    }));
    expect(rejected).toEqual({ ok: false, reason: 'too_large' });
  });
});
