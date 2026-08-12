/**
 * V7 Audit §1.P3a — Centralized CSRF exempt route prefixes.
 *
 * Routes listed here skip CSRF verification on mutating requests because
 * they use an alternative authentication mechanism:
 * - paypal/webhook  → PayPal API signature verification
 * - paypal/recovery → Dedicated reconciliation-secret authentication
 * - license/*       → API-key + per-key rate limiting
 * - portal/*        → Portal session token auth
 * - auth/*          → OAuth provider callback (state param)
 * - downloads/*     → HMAC-signed URL + single-use nonce
 * - inbound-webhooks/* → High-entropy receiver token + per-relay/IP rate limits
 * - csrf            → GET-only token issuance
 *
 * V6 Audit §1.1: /api/setup intentionally NOT exempt (uses parseBody + Supabase auth).
 *
 * This module is deliberately dependency-free: it is the single source of
 * truth for BOTH the server-side check (lib/api/csrf.ts) and the client fetch
 * wrapper (lib/csrf-fetch.ts), so it must stay importable from client code.
 */
export const CSRF_EXEMPT_PREFIXES: readonly string[] = [
  '/api/paypal/webhook',
  '/api/paypal/recovery',
  '/api/license/',
  '/api/portal/',
  '/api/auth/',
  '/api/downloads/',
  '/api/inbound-webhooks/',
  '/api/csrf',
] as const;
