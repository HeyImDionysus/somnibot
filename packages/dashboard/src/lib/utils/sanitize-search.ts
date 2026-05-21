/**
 * Sanitize user-provided search strings for use in Supabase PostgREST
 * `.or()` / `.filter()` expressions.
 *
 * PostgREST filter strings use commas to separate conditions and periods
 * to separate column.operator.value.  Parentheses delimit nested groups.
 * Injecting these characters into an unsanitized template literal lets an
 * attacker add arbitrary filter conditions (e.g. bypass guild_id scoping).
 *
 * This helper strips all PostgREST-significant metacharacters so the
 * value can only ever match as a plain text literal.
 */
export function sanitizeSearch(raw: string): string {
  // Remove characters that have structural meaning in PostgREST filters:
  //   ,  → condition separator
  //   .  → column/operator/value separator
  //   () → logical grouping
  //   %  → wildcard (we add our own, user shouldn't inject extra)
  //   *  → wildcard in full-text search
  //   \  → escape char
  // Also trim and limit length to prevent abuse.
  return raw
    .replace(/[,.()*%\\]/g, '')
    .trim()
    .slice(0, 200);
}
