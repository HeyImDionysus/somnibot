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
