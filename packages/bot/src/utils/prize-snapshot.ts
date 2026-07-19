/**
 * Exact JS replicas of the SQL prize-snapshot transform
 * btrim(left(btrim(prize), 1000)) used by giveaway_atomic_end/reroll.
 *
 * PostgreSQL btrim strips ONLY U+0020 by default and left() counts code
 * points; JS String.prototype.trim strips all Unicode whitespace and
 * slice() counts UTF-16 units. Validating or comparing SQL-minted
 * snapshots with trim()/slice() rejects legal snapshots (edge tabs or
 * newlines survive btrim) and miscounts astral content, permanently
 * dead-lettering winner notifications for those giveaways.
 */

/** btrim(value) — strips U+0020 only, exactly like the SQL default. */
export function sqlSpaceTrim(value: string): string {
  return value.replace(/^ +/, '').replace(/ +$/, '');
}

/** length in code points, exactly like SQL char_length()/left() counting. */
export function codePointLength(value: string): number {
  let count = 0;
  // for..of iterates code points, not UTF-16 units.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of value) count += 1;
  return count;
}

/** left(value, n) — first n code points, never splitting a surrogate pair. */
export function codePointSlice(value: string, maxCodePoints: number): string {
  return Array.from(value).slice(0, maxCodePoints).join('');
}

/** btrim(left(btrim(value), 1000)) — the exact snapshot a stored prize yields. */
export function prizeSnapshotOf(storedPrize: string): string {
  return sqlSpaceTrim(codePointSlice(sqlSpaceTrim(storedPrize), 1_000));
}
