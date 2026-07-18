const PAYPAL_RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * PayPal resource IDs are opaque, but every trusted commerce ingress uses
 * this narrow ASCII grammar before persisting or acting on one.
 */
export function isCanonicalPayPalResourceId(value: unknown): value is string {
  return typeof value === 'string' && PAYPAL_RESOURCE_ID_PATTERN.test(value);
}
