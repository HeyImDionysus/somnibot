/**
 * Type-safe helpers for Supabase query results.
 *
 * V7 Audit §11.4: Replaces `as any` casts on Supabase join results
 * with typed accessors that preserve type safety while handling the
 * untyped nature of `.select('*, related_table(*)')` joins.
 */

/** Safely access a nested join field from a Supabase row. */
export function joinField<T>(row: unknown, key: string): T | undefined {
  if (row && typeof row === 'object' && key in row) {
    return (row as Record<string, unknown>)[key] as T;
  }
  return undefined;
}

/** Safely access a nested join field's property. */
export function joinProp(row: unknown, joinKey: string, prop: string): unknown {
  const joined = joinField<Record<string, unknown>>(row, joinKey);
  return joined?.[prop];
}

/** Safely get wallet balance from a Supabase economy row. */
export function walletBalance(row: unknown): number {
  if (row && typeof row === 'object' && 'wallet' in row) {
    return (row as { wallet: number }).wallet ?? 0;
  }
  return 0;
}

/** Type guard for Supabase error objects with a `code` property. */
export function hasErrorCode(err: unknown): err is { code: string; message: string } {
  return err !== null && typeof err === 'object' && 'code' in err;
}
