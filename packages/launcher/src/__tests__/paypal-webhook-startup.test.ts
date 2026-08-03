import { describe, expect, it, vi } from 'vitest';
import type { LauncherConfig } from '../main/config-store.js';
import { reconcileSandboxPayPalWebhookOnStartup } from '../main/paypal-webhook-startup.js';

function config(overrides: Partial<LauncherConfig> = {}): LauncherConfig {
  return {
    paypalClientId: 'sandbox-client',
    paypalClientSecret: 'sandbox-secret',
    paypalSandbox: true,
    ...overrides,
  } as LauncherConfig;
}

describe('startup PayPal webhook reconciliation', () => {
  it('repairs a configured sandbox webhook automatically', async () => {
    const ensureWebhook = vi.fn().mockResolvedValue({
      ok: true,
      status: 'updated',
      message: 'updated',
      webhookUrl: 'https://somni.example/api/paypal/webhook',
      apiBase: 'https://api-m.sandbox.paypal.com',
      webhookId: 'WH-RECOVERED',
    });

    const result = await reconcileSandboxPayPalWebhookOnStartup(
      config(),
      'https://somni.example/api/paypal/webhook',
      ensureWebhook,
    );

    expect(result.attempted).toBe(true);
    expect(result.result?.webhookId).toBe('WH-RECOVERED');
    expect(ensureWebhook).toHaveBeenCalledOnce();
  });

  it('never changes a live PayPal webhook automatically', async () => {
    const ensureWebhook = vi.fn();
    const result = await reconcileSandboxPayPalWebhookOnStartup(
      config({ paypalSandbox: false }),
      'https://somni.example/api/paypal/webhook',
      ensureWebhook,
    );

    expect(result).toEqual({ attempted: false, skipReason: 'live-mode' });
    expect(ensureWebhook).not.toHaveBeenCalled();
  });

  it('waits for complete sandbox credentials and a public callback', async () => {
    const ensureWebhook = vi.fn();
    const result = await reconcileSandboxPayPalWebhookOnStartup(
      config({ paypalClientSecret: '' }),
      '',
      ensureWebhook,
    );

    expect(result).toEqual({ attempted: false, skipReason: 'incomplete-config' });
    expect(ensureWebhook).not.toHaveBeenCalled();
  });
});
