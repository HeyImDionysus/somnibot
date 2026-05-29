/**
 * PayPal Webhook Verification + Replay Authentication.
 *
 * V5 Audit §2.P3a: Extracted from the monolithic route.ts for maintainability.
 */

import { type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { getPayPalToken, PAYPAL_API_BASE } from '@/lib/paypal';

const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || '';

// V5 Audit §2.P2a: Startup-time warning when WEBHOOK_REPLAY_SECRET isn't set.
// Fires at module-load so the operator sees it in logs immediately, not on first request.
if (!process.env.WEBHOOK_REPLAY_SECRET && process.env.NEXTAUTH_SECRET) {
  console.warn(
    '[PayPalWebhook] ⚠ WEBHOOK_REPLAY_SECRET is not set — deriving from NEXTAUTH_SECRET. ' +
    'Set a dedicated WEBHOOK_REPLAY_SECRET env var for security isolation. ' +
    'If NEXTAUTH_SECRET is rotated, replay auth will silently break.',
  );
}

// ── Replay Secret ───────────────────────────────────

let _replaySecret: string | undefined;

function getReplaySecret(): string {
  if (_replaySecret) return _replaySecret;

  if (process.env.WEBHOOK_REPLAY_SECRET) {
    _replaySecret = process.env.WEBHOOK_REPLAY_SECRET;
    return _replaySecret;
  }

  if (process.env.NEXTAUTH_SECRET) {
    console.warn(
      '[PayPalWebhook] WEBHOOK_REPLAY_SECRET not set — deriving from NEXTAUTH_SECRET. ' +
        'Set a dedicated WEBHOOK_REPLAY_SECRET env var for better security isolation.',
    );
    _replaySecret = createHmac('sha256', process.env.NEXTAUTH_SECRET)
      .update('webhook-replay-secret')
      .digest('hex');
    return _replaySecret;
  }

  throw new Error(
    'Missing WEBHOOK_REPLAY_SECRET (or NEXTAUTH_SECRET fallback). ' +
      'Cannot authenticate internal replay requests.',
  );
}

/**
 * Check if this request is an authenticated internal replay.
 */
export function isInternalReplay(req: NextRequest): boolean {
  const provided = req.headers.get('x-replay-secret');
  if (!provided) return false;
  const secret = getReplaySecret();
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Verify the webhook signature via PayPal's API.
 */
export async function verifyWebhookSignature(
  req: NextRequest,
  rawBody: string,
): Promise<boolean> {
  if (!PAYPAL_WEBHOOK_ID) {
    console.error('[Webhook] PAYPAL_WEBHOOK_ID is not configured — refusing to process');
    return false;
  }

  const token = await getPayPalToken();
  if (!token) return false;

  try {
    const res = await fetch(
      `${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          auth_algo: req.headers.get('paypal-auth-algo'),
          cert_url: req.headers.get('paypal-cert-url'),
          transmission_id: req.headers.get('paypal-transmission-id'),
          transmission_sig: req.headers.get('paypal-transmission-sig'),
          transmission_time: req.headers.get('paypal-transmission-time'),
          webhook_id: PAYPAL_WEBHOOK_ID,
          webhook_event: JSON.parse(rawBody),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) return false;
    const data = await res.json();
    return data.verification_status === 'SUCCESS';
  } catch {
    return false;
  }
}
