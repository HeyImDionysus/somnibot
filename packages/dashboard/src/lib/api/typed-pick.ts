/**
 * V5-Audit §7.1 — Type-safe field picker for PATCH update handlers.
 *
 * Replaces the `(body as Record<string, unknown>)[field]` pattern used in
 * ~19 PATCH routes. This utility:
 *  1. Preserves the compile-time type of `body` (no `as` casts needed)
 *  2. Only copies fields that are explicitly listed AND present on the body
 *  3. Returns a plain `Record<string, unknown>` suitable for Supabase `.update()`
 *
 * Usage:
 * ```ts
 * const updates = typedPick(body, ['name', 'enabled', 'trigger_config']);
 * if (Object.keys(updates).length === 0) return badRequest('No fields to update');
 * await supabase.from('table').update(updates).eq('id', id);
 * ```
 */
export function typedPick<T extends object>(
  body: T,
  allowedFields: ReadonlyArray<keyof T & string>,
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }
  return updates;
}
