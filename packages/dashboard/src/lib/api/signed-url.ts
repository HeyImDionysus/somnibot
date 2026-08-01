/**
 * Signed Download URL Utilities
 *
 * V5 Audit Fix #5 — Replace raw portal tokens in URLs with short-lived
 * HMAC-signed download links. The portal token never appears in a URL.
 *
 * Flow:
 * 1. Portal page calls POST /api/portal/download-link with productId + fileId
 * 2. Server verifies portal token (from header), generates signed URL
 * 3. Signed URL binds product, file, customer, guild, entitlement, expiry, and nonce
 * 4. GET /api/downloads/[productId]/[fileId] verifies HMAC instead of raw token
 */
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

let _downloadSecret: string | undefined;
function getDownloadSecret(): string {
  if (_downloadSecret) return _downloadSecret;
  const secret =
    process.env.DOWNLOAD_SIGNING_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.CSRF_SECRET;
  if (!secret) {
    throw new Error(
      'Missing DOWNLOAD_SIGNING_SECRET (or NEXTAUTH_SECRET / CSRF_SECRET fallback). ' +
      'Refusing to operate with predictable signing keys.',
    );
  }
  _downloadSecret = secret;
  return secret;
}

const DEFAULT_EXPIRY_SECONDS = 300; // 5 minutes

export interface SignedDownloadParams {
  productId: string;
  fileId: string;
  customerId: string;
  guildId: string;
  entitlementId: string;
}

/**
 * Generate a signed download URL path (relative).
 * The signature covers all parameters + expiry + a single-use nonce
 * so it can't be tampered with or reused.
 */
export function generateSignedDownloadUrl(
  params: SignedDownloadParams,
  expirySeconds = DEFAULT_EXPIRY_SECONDS,
): string {
  const expires = Math.floor(Date.now() / 1000) + expirySeconds;
  const nonce = randomUUID();
  const payload = `${params.productId}:${params.fileId}:${params.customerId}:${params.guildId}:${params.entitlementId}:${expires}:${nonce}`;
  const signature = createHmac('sha256', getDownloadSecret())
    .update(payload)
    .digest('hex');

  const qs = new URLSearchParams({
    sig: signature,
    exp: String(expires),
    cid: params.customerId,
    gid: params.guildId,
    eid: params.entitlementId,
    nonce,
  });

  return `/api/downloads/${params.productId}/${params.fileId}?${qs.toString()}`;
}

/**
 * Verify a signed download URL's signature and expiry.
 * Returns the decoded customer/guild IDs + nonce on success, or null on failure.
 *
 * Links WITHOUT an entitlement id are the previous release's format: during a
 * rolling deployment an old instance keeps minting them for up to the
 * five-minute lifetime, and a freshly issued link must not 401 on a new
 * instance. The legacy payload verifies for its remaining lifetime — still
 * nonce-bound and single-use — and the caller selects the entitlement at
 * delivery time instead.
 */
export function verifySignedDownloadUrl(
  productId: string,
  fileId: string,
  sig: string,
  exp: string,
  customerId: string,
  guildId: string,
  entitlementId?: string | null,
  nonce?: string,
): {
  customerId: string;
  guildId: string;
  entitlementId: string | null;
  nonce: string | null;
} | null {
  const expNum = parseInt(exp, 10);
  if (isNaN(expNum)) return null;

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (now > expNum) return null;

  if (!nonce) return null;
  const payload = entitlementId
    ? `${productId}:${fileId}:${customerId}:${guildId}:${entitlementId}:${exp}:${nonce}`
    : `${productId}:${fileId}:${customerId}:${guildId}:${exp}:${nonce}`;
  const expected = createHmac('sha256', getDownloadSecret())
    .update(payload)
    .digest('hex');

  // Constant-time comparison — V6 Audit §9.8: direct import, no try/catch fallback
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  return { customerId, guildId, entitlementId: entitlementId ?? null, nonce };
}
