/**
 * License Key Generator — SMNI-XXXX-XXXX-XXXX-XXXX format.
 *
 * Uses crypto.randomBytes for secure generation.
 * Only SHA-256 hash is stored; plaintext delivered once via bot DM.
 */
import { createHash, randomBytes } from 'node:crypto';

const KEY_PREFIX = 'SMNI';
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0/O/1/I confusion

/**
 * Generate a random 4-character group from the charset.
 */
function randomGroup(bytes: Buffer, offset: number): string {
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += CHARSET[bytes[offset + i]! % CHARSET.length];
  }
  return result;
}

/**
 * Generate a new license key in SMNI-XXXX-XXXX-XXXX-XXXX format.
 * Returns both the plaintext key and its SHA-256 hash.
 */
export function generateLicenseKey(): {
  plaintext: string;
  hash: string;
  prefix: string;
  suffix: string;
} {
  const bytes = randomBytes(16);
  const group1 = randomGroup(bytes, 0);
  const group2 = randomGroup(bytes, 4);
  const group3 = randomGroup(bytes, 8);
  const group4 = randomGroup(bytes, 12);

  const plaintext = `${KEY_PREFIX}-${group1}-${group2}-${group3}-${group4}`;
  const hash = createHash('sha256').update(plaintext).digest('hex');

  return {
    plaintext,
    hash,
    prefix: KEY_PREFIX,
    suffix: group4, // Last 4 chars for customer identification
  };
}

/**
 * Hash a license key for lookup.
 */
export function hashLicenseKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
