/**
 * PayPal Webhook Verification + Replay Authentication.
 *
 * V5 Audit §2.P3a: Extracted from the monolithic route.ts for maintainability.
 */

import { type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  getPayPalRuntimeConfig,
  getPayPalTokenResult,
  isRetriablePayPalStatus,
} from '@/lib/paypal';
import type { createAdminSupabase } from '@/lib/supabase/admin';

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

const PAYPAL_SIGNATURE_HEADERS = [
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
] as const;

function hasRequiredSignatureHeaders(req: NextRequest): boolean {
  return PAYPAL_SIGNATURE_HEADERS.every((header) => {
    const value = req.headers.get(header);
    return typeof value === 'string' && value.trim().length > 0;
  });
}

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

// ── Signature Verification ─────────────────────────

/**
 * W2: Discriminated verification result so the route can map outcomes to the
 * right HTTP status:
 *   - 'verified'    → process the event (200 path)
 *   - 'invalid'     → 401, no retry: the signature (or our PayPal config) is
 *                     bad; redelivering the same request cannot succeed
 *   - 'unavailable' → 503 so PayPal redelivers: the verification
 *                     INFRASTRUCTURE (token fetch / verify API) failed — we
 *                     never learned whether the signature is valid
 */
export type WebhookSignatureVerification =
  | { outcome: 'verified' }
  | { outcome: 'invalid' }
  | { outcome: 'unavailable'; reason: string };

export interface VerifyWebhookSignatureOptions {
  /** Total wall-clock budget across all attempts, including backoff pauses. */
  budgetMs?: number;
  /** Maximum verification attempts (1 initial + N-1 quick retries). */
  maxAttempts?: number;
  /** Pause before retry N (0-indexed by retry number; last entry repeats). */
  backoffMs?: readonly number[];
  /** Tenant-selected PayPal environment (defaults to the runtime setting). */
  environment?: 'sandbox' | 'live';
}

/**
 * Bounded retry budget. PayPal's webhook sender times out slow listeners, so
 * the whole verification (attempts + backoff) must finish well inside a
 * single request: worst case is one 10s attempt, two quick retries, and 1s
 * of backoff — capped at 20s total by the deadline check before each step.
 */
const VERIFY_TOTAL_BUDGET_MS = 20_000;
const VERIFY_MAX_ATTEMPTS = 3;
const VERIFY_RETRY_BACKOFF_MS = [250, 750] as const;
const VERIFY_ATTEMPT_TIMEOUT_MS = 10_000;
/** Don't bother starting another attempt with less than this much budget. */
const VERIFY_MIN_ATTEMPT_BUDGET_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify the webhook signature via PayPal's API.
 *
 * Transient infrastructure failures (token fetch / verify API network error,
 * timeout, 5xx, 429) are retried up to twice with short backoff inside a
 * bounded time budget, then reported as 'unavailable' — distinct from an
 * actually rejected signature ('invalid') — so the route can respond 503 and
 * PayPal redelivers instead of the event being dropped as unauthorized.
 */
export async function verifyWebhookSignature(
  req: NextRequest,
  rawBody: string,
  options: VerifyWebhookSignatureOptions = {},
): Promise<WebhookSignatureVerification> {
  const budgetMs = options.budgetMs ?? VERIFY_TOTAL_BUDGET_MS;
  const maxAttempts = options.maxAttempts ?? VERIFY_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? VERIFY_RETRY_BACKOFF_MS;
  const deadline = Date.now() + budgetMs;

  if (!hasRequiredSignatureHeaders(req)) {
    console.error('[Webhook] PayPal signature headers are missing — refusing to process');
    return { outcome: 'invalid' };
  }

  const runtimeConfig = await getPayPalRuntimeConfig();
  const paypalConfig = options.environment
    ? {
        ...runtimeConfig,
        sandbox: options.environment === 'sandbox',
        apiBase: options.environment === 'sandbox'
          ? 'https://api-m.sandbox.paypal.com'
          : 'https://api-m.paypal.com',
      }
    : runtimeConfig;
  if (!paypalConfig.webhookId) {
    console.error('[Webhook] PAYPAL_WEBHOOK_ID is not configured — refusing to process');
    return { outcome: 'invalid' };
  }

  // A body that isn't JSON can never come from PayPal — classify as invalid
  // up front instead of conflating the parse failure with a fetch failure.
  let webhookEvent: unknown;
  try {
    webhookEvent = JSON.parse(rawBody);
  } catch {
    console.error('[Webhook] Webhook body is not valid JSON — refusing to process');
    return { outcome: 'invalid' };
  }

  // The access token is reused across attempts once acquired; it is only
  // re-fetched if the verify API rejects it (401/403).
  let token: string | null = null;
  let lastFailure = 'no verification attempt fit inside the time budget';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const pause = backoffMs[Math.min(attempt - 2, backoffMs.length - 1)] ?? 0;
      // Only retry if the pause plus a useful attempt still fits the budget.
      if (deadline - Date.now() < pause + VERIFY_MIN_ATTEMPT_BUDGET_MS) break;
      if (pause > 0) await sleep(pause);
    }

    if (!token) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const tokenResult = await getPayPalTokenResult(paypalConfig, {
        timeoutMs: Math.min(VERIFY_ATTEMPT_TIMEOUT_MS, remaining),
      });
      if (!tokenResult.ok) {
        if (!tokenResult.retriable) {
          // Missing/rejected credentials — retrying cannot succeed and the
          // signature cannot be checked. Same 401 posture as before.
          console.error('[Webhook] PayPal token fetch failed (non-retriable):', tokenResult.reason);
          return { outcome: 'invalid' };
        }
        lastFailure = `token fetch failed: ${tokenResult.reason}`;
        console.warn(`[Webhook] PayPal token fetch failed (attempt ${attempt}/${maxAttempts}): ${tokenResult.reason}`);
        continue;
      }
      token = tokenResult.token;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      lastFailure = 'verification time budget exhausted';
      break;
    }

    try {
      const res = await fetch(
        `${paypalConfig.apiBase}/v1/notifications/verify-webhook-signature`,
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
            webhook_id: paypalConfig.webhookId,
            webhook_event: webhookEvent,
          }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(VERIFY_ATTEMPT_TIMEOUT_MS, remaining))),
        },
      );

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          // Our token was rejected, not the webhook signature — refresh the
          // token and retry.
          token = null;
          lastFailure = `verify API rejected the access token (${res.status})`;
          console.warn(`[Webhook] verify-webhook-signature auth rejected (attempt ${attempt}/${maxAttempts}) — refreshing token`);
          continue;
        }
        if (isRetriablePayPalStatus(res.status)) {
          lastFailure = `verify API returned ${res.status}`;
          console.warn(`[Webhook] verify-webhook-signature returned ${res.status} (attempt ${attempt}/${maxAttempts})`);
          continue;
        }
        // Remaining 4xx: PayPal rejected the verification request itself
        // (malformed headers/body) — redelivery of the same request cannot
        // succeed either.
        console.error(`[Webhook] verify-webhook-signature rejected the request (${res.status})`);
        return { outcome: 'invalid' };
      }

      let verificationStatus: unknown;
      try {
        verificationStatus = (await res.json())?.verification_status;
      } catch {
        lastFailure = 'verify API returned an unparseable body';
        console.warn(`[Webhook] verify-webhook-signature body unparseable (attempt ${attempt}/${maxAttempts})`);
        continue;
      }

      return verificationStatus === 'SUCCESS'
        ? { outcome: 'verified' }
        : { outcome: 'invalid' };
    } catch (err) {
      // AbortSignal timeout / network failure — transient.
      lastFailure = `verify API request failed: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[Webhook] verify-webhook-signature request failed (attempt ${attempt}/${maxAttempts}): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
  }

  console.error('[Webhook] Signature verification unavailable after retries:', lastFailure);
  return { outcome: 'unavailable', reason: lastFailure };
}

// ── Verify-Outage Operator Alert ────────────────────

type AdminSupabase = ReturnType<typeof createAdminSupabase>;

/** Operator-visible alert type for PayPal verify-infrastructure outages (see `alerts` table). */
const VERIFY_ALERT_TYPE = 'paypal_webhook_verify_failure';

/**
 * Minimum time between alert write attempts per guild (per instance).
 * The alert row itself is deduped atomically in the DB (partial unique
 * index: one unresolved row per guild); this throttle only keeps a
 * sustained outage from adding alert-write DB load on every delivery.
 */
const VERIFY_ALERT_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Bounded per-instance throttle: guild_id → last alert write attempt (epoch ms). */
const VERIFY_ALERT_THROTTLE_MAX_ENTRIES = 1000;
const verifyAlertLastAttempt = new Map<string, number>();

/**
 * Persist an operator-visible alert for repeated verify-infrastructure
 * failures. By the time this is called, verification has already failed
 * every in-request retry attempt — a single transient blip never alerts.
 *
 * Mirrors the fraud-check alert pattern (PR #263): at most one unresolved
 * `paypal_webhook_verify_failure` alert per guild, enforced atomically by
 * the partial unique index `uniq_alerts_unresolved_paypal_webhook_verify_failure`.
 * An existing alert is refreshed in place with a single UPDATE; otherwise we
 * INSERT and treat a 23505 unique violation as "another instance already
 * raised it" — no check-then-insert window.
 */
export async function raisePayPalVerifyUnavailableAlert(
  supabase: AdminSupabase,
  reason: string,
): Promise<void> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    console.warn('[Webhook] DISCORD_GUILD_ID is not set — cannot raise PayPal verify outage alert');
    return;
  }

  const now = Date.now();
  const last = verifyAlertLastAttempt.get(guildId);
  if (last !== undefined && now - last < VERIFY_ALERT_MIN_INTERVAL_MS) return;

  // Record the attempt up front so a failing alert write is throttled too,
  // and bound the map so it cannot grow without limit.
  if (verifyAlertLastAttempt.size >= VERIFY_ALERT_THROTTLE_MAX_ENTRIES && !verifyAlertLastAttempt.has(guildId)) {
    verifyAlertLastAttempt.clear();
  }
  verifyAlertLastAttempt.set(guildId, now);

  // `reason` only ever carries HTTP statuses and generic fetch error
  // messages (see getPayPalTokenResult) — no tokens, credentials, or
  // webhook payload contents reach this operator-readable row.
  const message =
    `PayPal webhook signature verification is failing (${reason}). ` +
    'The webhook responded 503 so PayPal will redeliver, but paid orders ' +
    'will not be recorded until verification recovers.';
  const metadata = { reason, source: 'paypal_webhook' };

  try {
    // Refresh the existing unresolved alert in place — a single atomic
    // UPDATE, no read-then-write window.
    const { data: refreshed, error: updateError } = await supabase
      .from('alerts')
      .update({ message, metadata, updated_at: new Date().toISOString() })
      .eq('guild_id', guildId)
      .eq('alert_type', VERIFY_ALERT_TYPE)
      .eq('resolved', false)
      .select('id');

    if (updateError) {
      console.error('[Webhook] Failed to refresh PayPal verify outage alert:', updateError.message);
      return;
    }
    if (refreshed && refreshed.length > 0) return;

    const { error: insertError } = await supabase.from('alerts').insert({
      guild_id: guildId,
      alert_type: VERIFY_ALERT_TYPE,
      severity: 'critical',
      title: 'PayPal webhook verification failing',
      message,
      metadata,
    });
    if (insertError && insertError.code !== '23505') {
      console.error('[Webhook] Failed to insert PayPal verify outage alert:', insertError.message);
    }
  } catch (err) {
    console.error('[Webhook] Failed to write PayPal verify outage alert:', err instanceof Error ? err.message : err);
  }
}
