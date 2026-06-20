export const SETUP_PAYPAL_WEBHOOK_PATH = '/api/paypal/webhook';

export function isSetupLocalHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(hostname);
}

export function getSetupPayPalWebhookUrlError(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return 'PayPal webhook URL must use HTTPS before it can be marked ready.';
    }
    if (isSetupLocalHostname(parsed.hostname)) {
      return 'PayPal webhook URL cannot point at localhost before it can be marked ready.';
    }
    if (parsed.pathname !== SETUP_PAYPAL_WEBHOOK_PATH) {
      return `PayPal webhook URL must point at ${SETUP_PAYPAL_WEBHOOK_PATH}.`;
    }
    if (parsed.search || parsed.hash) {
      return 'PayPal webhook URL must not include query parameters or fragments.';
    }
  } catch {
    return 'PayPal webhook URL must be a valid HTTPS URL.';
  }

  return null;
}

export function normalizeSetupPayPalWebhookUrl(value: string | null | undefined): string | null {
  if (getSetupPayPalWebhookUrlError(value)) return null;

  const trimmed = value?.trim();
  if (!trimmed) return null;

  const parsed = new URL(trimmed);
  return `${parsed.origin}${SETUP_PAYPAL_WEBHOOK_PATH}`;
}

export function isSetupPayPalWebhookUrl(value: string): boolean {
  return value.trim().length > 0 && getSetupPayPalWebhookUrlError(value) === null;
}
