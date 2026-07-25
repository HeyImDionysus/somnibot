/**
 * Print a cryptographically random hex secret.
 *
 * The docs used to say `openssl rand -hex 32` in a dozen places. openssl is not
 * installed on Windows, and it is not a dependency this project otherwise has —
 * every single use of it in the repo was generating random bytes, which Node
 * (already a hard prerequisite) does natively.
 *
 * Usage:
 *   node scripts/gen-secret.mjs        # 32 bytes → 64 hex chars
 *   node scripts/gen-secret.mjs 16     # 16 bytes → 32 hex chars
 */
import { randomBytes } from 'node:crypto';

const bytes = Number(process.argv[2] ?? 32);

if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
  console.error('Usage: node scripts/gen-secret.mjs [bytes 16-128, default 32]');
  process.exit(1);
}

console.log(randomBytes(bytes).toString('hex'));
