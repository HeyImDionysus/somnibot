/**
 * Shared PayPal utilities — single source of truth for PayPal API auth.
 *
 * Previously duplicated in:
 *   - /api/orders/[id]/refund/route.ts
 *   - /api/paypal/webhook/route.ts
 *   - /api/store/products/route.ts
 */

export const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';

/**
 * V5-Audit §2.1 — Fetch the billing plan amount for a subscription.
 *
 * PayPal's BILLING.SUBSCRIPTION.ACTIVATED webhook doesn't include
 * the first payment amount. This queries the subscription details API
 * to retrieve the plan's billing amount, so the initial order row
 * can record the real amount_cents instead of 0.
 *
 * Returns amount in cents and the currency code, or null on failure.
 */
export async function getSubscriptionAmount(
  subscriptionId: string,
): Promise<{ amountCents: number; currency: string } | null> {
  try {
    const token = await getPayPalToken();
    if (!token) return null;

    const res = await fetch(
      `${PAYPAL_API_BASE}/v1/billing/subscriptions/${subscriptionId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;

    const data = await res.json();
    // billing_info.last_payment is present once first payment settles;
    // fall back to plan's fixed_price for newly-activated subscriptions.
    const amount =
      data.billing_info?.last_payment?.amount ??
      data.plan?.billing_cycles?.[0]?.pricing_scheme?.fixed_price;

    if (!amount?.value) return null;

    const cents = Math.round(parseFloat(amount.value) * 100);
    if (!Number.isFinite(cents) || cents < 0) return null;

    return { amountCents: cents, currency: (amount.currency_code ?? 'USD').toUpperCase() };
  } catch {
    // Non-critical — order still created, amount updated on PAYMENT.SALE.COMPLETED
    return null;
  }
}

/**
 * Fetch a fresh PayPal access token using client credentials.
 * Returns null if the request fails (missing creds, network error, etc).
 */
export async function getPayPalToken(): Promise<string | null> {
  try {
    const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000), // V6 Audit §2.5: prevent hung token fetch
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token;
  } catch {
    return null;
  }
}
