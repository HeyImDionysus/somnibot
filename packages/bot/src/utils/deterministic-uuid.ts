import { createHash } from 'node:crypto';

const HASH_DOMAIN = 'somnibot:deterministic-uuid:v1';

function updateLengthPrefixed(
  hash: ReturnType<typeof createHash>,
  value: string,
): void {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hash.update(length);
  hash.update(bytes);
}

/**
 * Derive a stable RFC-compatible UUIDv8 from an explicitly versioned namespace
 * and an ordered tuple of canonical string parts.
 *
 * Every value is UTF-8 length-prefixed (and the tuple length is hashed), so
 * different tuples cannot collide merely because a delimiter appears in an ID.
 * Callers must bump their namespace version when the tuple contract changes.
 */
export function deterministicUuidV8(
  namespace: string,
  parts: readonly string[],
): string {
  if (namespace.length === 0 || namespace.trim() !== namespace) {
    throw new Error('Deterministic UUID namespace must be a non-blank canonical string');
  }
  if (parts.some((part) => typeof part !== 'string')) {
    throw new Error('Deterministic UUID parts must be canonical strings');
  }

  const hash = createHash('sha256');
  updateLengthPrefixed(hash, HASH_DOMAIN);
  updateLengthPrefixed(hash, namespace);

  const partCount = Buffer.allocUnsafe(4);
  partCount.writeUInt32BE(parts.length);
  hash.update(partCount);
  for (const part of parts) updateLengthPrefixed(hash, part);

  const bytes = hash.digest().subarray(0, 16);
  // RFC 9562 UUIDv8 version and RFC variant bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
