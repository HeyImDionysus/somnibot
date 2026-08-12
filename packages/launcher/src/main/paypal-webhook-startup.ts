import type { LauncherConfig } from './config-store.js';
import type { EnsurePayPalWebhookResult } from './paypal-webhook-service.js';

export interface StartupPayPalWebhookReconciliation {
  attempted: boolean;
  result?: EnsurePayPalWebhookResult;
  skipReason?: 'live-mode' | 'incomplete-config';
}

/**
 * Reconcile only sandbox webhooks automatically at startup. Live provider
 * changes remain an explicit owner action, while sandbox installations repair
 * stale saved webhook ids and event catalogs without rerunning setup.
 */
export async function reconcileSandboxPayPalWebhookOnStartup(
  config: LauncherConfig,
  webhookUrl: string,
  ensureWebhook: () => Promise<EnsurePayPalWebhookResult>,
): Promise<StartupPayPalWebhookReconciliation> {
  if (!config.paypalSandbox) {
    return { attempted: false, skipReason: 'live-mode' };
  }

  if (
    !config.paypalClientId.trim()
    || !config.paypalClientSecret.trim()
    || !webhookUrl.trim().startsWith('https://')
  ) {
    return { attempted: false, skipReason: 'incomplete-config' };
  }

  return {
    attempted: true,
    result: await ensureWebhook(),
  };
}
