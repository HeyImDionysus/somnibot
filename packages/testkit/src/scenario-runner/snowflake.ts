/**
 * Map a run-scoped fixture label to a deterministic Discord-snowflake-shaped
 * identifier. The 18-digit range satisfies production snowflake validation
 * while retaining stable, distinct fixture identities.
 */
export function deterministicSnowflake(seed: string): string {
  let hash = 1469598103934665603n;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= BigInt(seed.charCodeAt(index));
    hash = (hash * 1099511628211n) & 0xffffffffffffffffn;
  }
  return (100000000000000000n + (hash % 900000000000000000n)).toString();
}
