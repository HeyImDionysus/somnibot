/** PayPal hosts are intentionally fixed; a guild policy selects one. */
export const PAYPAL_SANDBOX_API_BASE = 'https://api-m.sandbox.paypal.com';
export const PAYPAL_LIVE_API_BASE = 'https://api-m.paypal.com';

export type PayPalEnvironment = 'sandbox' | 'live';

export function paypalApiBaseForEnvironment(environment: PayPalEnvironment): string {
  return environment === 'live' ? PAYPAL_LIVE_API_BASE : PAYPAL_SANDBOX_API_BASE;
}

/** Missing/invalid policy values always resolve to sandbox. */
export function resolvePayPalEnvironment(value: unknown): PayPalEnvironment {
  return value === 'live' ? 'live' : 'sandbox';
}
