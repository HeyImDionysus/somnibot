/**
 * Shared utility functions used by both bot and dashboard.
 */
import { randomInt } from 'node:crypto';

/**
 * Generate an order number in the format SMNI-XXXXX.
 *
 * V10 Audit §4.P3b — Uses crypto.randomInt to avoid collisions under
 * load and for consistency with the CSPRNG policy.
 */
export function generateOrderNumber(): string {
  const seq = randomInt(1, 100000);
  return `SMNI-${seq.toString().padStart(5, '0')}`;
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chunk an array into groups of a given size.
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Clamp a number between a min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Format a Discord snowflake ID as a Discord mention string.
 */
export function mentionUser(id: string): string {
  return `<@${id}>`;
}

export function mentionRole(id: string): string {
  return `<@&${id}>`;
}

export function mentionChannel(id: string): string {
  return `<#${id}>`;
}

/**
 * Check if a Discord snowflake ID is valid.
 */
export function isValidSnowflake(id: string): boolean {
  return /^\d{17,20}$/.test(id);
}

/**
 * Format a number with commas (e.g., 1,234,567).
 */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Truncate a string to a max length, adding ellipsis if needed.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + '…';
}

/**
 * Default payment-failure grace window (days). Mirrors the
 * `guild_config.grace_period_days` column default in the initial schema —
 * used whenever a guild has no config row (or a null value).
 */
export const DEFAULT_GRACE_PERIOD_DAYS = 3;

/**
 * Minimal structural view of a Supabase client — just enough for the
 * guild_config grace-window lookup. @somnibot/shared deliberately has no
 * @supabase/supabase-js dependency; both the bot's and the dashboard's
 * clients satisfy this shape.
 *
 * NOTE: the public parameter is intentionally typed as `{ from(...): unknown }`
 * rather than a fully-inlined `select → eq → maybeSingle` builder. Asking tsc
 * to prove the full generic `SupabaseClient` is assignable to a deep builder
 * literal makes it recurse through PostgrestFilterBuilder's hundreds of
 * same-named methods until it trips TS2589 ("excessively deep") under the
 * dashboard's strict config. Widening `from`'s return to `unknown` at the
 * boundary and re-narrowing it internally keeps the caller-side assignability
 * check shallow while preserving the exact runtime query.
 */
export interface GraceConfigClient {
  from(table: string): unknown;
}

interface GraceConfigQuery {
  select(columns: string): {
    eq(
      column: string,
      value: string,
    ): {
      maybeSingle(): PromiseLike<{
        data: { grace_period_days?: number | null } | null;
      }>;
    };
  };
}

/**
 * Read a guild's configured payment-failure grace window
 * (`guild_config.grace_period_days`), falling back to
 * DEFAULT_GRACE_PERIOD_DAYS when unset.
 *
 * Single source of truth for BOTH suspension paths — the bot's webhook-driven
 * `subscription_suspended` fulfillment and the dashboard's manual
 * grace_period transition — so an operator's configured window is honored no
 * matter which surface starts the grace period. The lookup is fail-open to
 * the default: a read error must never block a suspension.
 */
export async function getGracePeriodDays(
  supabase: GraceConfigClient,
  guildId: string,
): Promise<number> {
  const query = supabase.from('guild_config') as GraceConfigQuery;
  const { data } = await query
    .select('grace_period_days')
    .eq('guild_id', guildId)
    .maybeSingle();
  return data?.grace_period_days ?? DEFAULT_GRACE_PERIOD_DAYS;
}
