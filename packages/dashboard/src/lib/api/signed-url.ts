/**
 * Signed Download URL Utilities
 *
 * V5 Audit Fix #5 — Replace raw portal tokens in URLs with short-lived
 * HMAC-signed download links. The portal token never appears in a URL.
 *
 * Flow:
 * 1. Portal page calls POST /api/portal/download-link with productId + fileId
 * 2. Server verifies portal token (from header), generates signed URL
 * 3. Signed URL encodes: productId, fileId, customerId, expiry, HMAC
 * 4. GET /api/downloads/[productId]/[fileId] verifies HMAC instead of raw token
 */
import { createHmac } from 'crypto';

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
}

/**
 * Generate a signed download URL path (relative).
 * The signature covers all parameters + expiry so it can't be tampered with.
 */
export function generateSignedDownloadUrl(
  params: SignedDownloadParams,
  expirySeconds = DEFAULT_EXPIRY_SECONDS,
): string {
  const expires = Math.floor(Date.now() / 1000) + expirySeconds;
  const payload = `${params.productId}:${params.fileId}:${params.customerId}:${params.guildId}:${expires}`;
  const signature = createHmac('sha256', getDownloadSecret())
    .update(payload)
    .digest('hex');

  const qs = new URLSearchParams({
    sig: signature,
    exp: String(expires),
    cid: params.customerId,
    gid: params.guildId,
  });

  return `/api/downloads/${params.productId}/${params.fileId}?${qs.toString()}`;
}

/**
 * Verify a signed download URL's signature and expiry.
 * Returns the decoded customer/guild IDs on success, or null on failure.
 */
export function verifySignedDownloadUrl(
  productId: string,
  fileId: string,
  sig: string,
  exp: string,
  customerId: string,
  guildId: string,
): { customerId: string; guildId: string } | null {
  const expNum = parseInt(exp, 10);
  if (isNaN(expNum)) return null;

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (now > expNum) return null;

  // Verify HMAC
  const payload = `${productId}:${fileId}:${customerId}:${guildId}:${exp}`;
  const expected = createHmac('sha256', getDownloadSecret())
    .update(payload)
    .digest('hex');

  // Constant-time comparison
  if (sig.length !== expected.length) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  try {
    const { timingSafeEqual } = require('crypto');
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    if (sig !== expected) return null;
  }

  return { customerId, guildId };
}
