/**
 * Authorization scope for the webhook event log.
 *
 * ── The problem (Finding 2) ────────────────────────────────────────────────
 * `webhook_events.guild_id` is nullable and is omitted from the insert when
 * the route cannot attribute the event to a guild. Both the list route and the
 * replay route filter with `.eq('guild_id', guildId)`, and in SQL a NULL never
 * equals anything — so those rows were invisible in the dashboard and 404'd on
 * replay. That silently hid exactly the two worst cases: a capture that failed
 * (`CHECKOUT.ORDER.APPROVED`, whose custom_id lives on the purchase units) and
 * the case the code itself calls catastrophic — "Customer was charged but no
 * order/entitlement was created".
 *
 * Resolving `purchase_units[0].custom_id` (see ../paypal/webhook/route.ts)
 * fixes attribution going forward. It does not help rows already written with
 * a NULL guild, nor rows where `custom_id` is genuinely malformed — for those
 * the owning guild is not merely unknown, it is *unknowable* from the payload.
 *
 * ── The authorization question ─────────────────────────────────────────────
 * A NULL-guild row belongs to nobody. Making it visible to "the current guild"
 * would be a cross-tenant leak: `requireGuildOwner` supports several guilds,
 * each with its own `owner_discord_id`, so operator A could read (and replay)
 * a payment event that in truth belongs to operator B's guild. Replay is not
 * read-only — it re-drives fulfillment — so this is a privilege question, not
 * just a disclosure one.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * Unattributed rows are exposed ONLY to a caller who is the sole operator of
 * the entire instance — every row in `guild` has `owner_discord_id` equal to
 * the caller's Discord ID. Then there is provably no other operator the row
 * could belong to and no one to leak it to, so the caller is the only person
 * who can possibly be owed that money.
 *
 * If a second distinct owner (or any guild with no recorded owner) exists, the
 * instance is genuinely multi-tenant, nobody can prove ownership of an
 * unattributed row, and it stays hidden from everyone — the operator resolves
 * it by backfilling `guild_id` directly. Fail closed: every uncertainty
 * (query error, no guilds, unreadably large guild set) denies access.
 *
 * This is deliberately narrower than filing unattributed rows under
 * `DISCORD_GUILD_ID` (the instance-primary fallback used for *alerts*):
 * alerts only notify, replay re-drives money.
 */
import type { createAdminSupabase } from '@/lib/supabase/admin';

type AdminSupabase = ReturnType<typeof createAdminSupabase>;

/**
 * Upper bound on the guild scan. `requireGuildOwner` uses the same 1000-row
 * cap; we request one extra row so a truncated read is detectable rather than
 * silently reading as "all guilds are mine".
 */
const GUILD_SCAN_LIMIT = 1000;

/**
 * True when `discordId` owns every guild in this instance.
 *
 * Never throws — any failure is reported as "not the sole operator", which
 * degrades to the pre-existing guild-scoped behaviour.
 */
export async function isSoleInstanceOperator(
  admin: AdminSupabase,
  discordId: string,
): Promise<boolean> {
  if (!discordId) return false;

  const { data, error } = await admin
    .from('guild')
    .select('owner_discord_id')
    .limit(GUILD_SCAN_LIMIT + 1);

  if (error || !Array.isArray(data)) {
    console.error(
      '[Webhooks] Could not determine instance operator scope:',
      error?.message ?? 'malformed guild query result',
    );
    return false;
  }

  // No guilds at all, or more than we can read in one page — cannot prove
  // sole ownership, so deny.
  if (data.length === 0 || data.length > GUILD_SCAN_LIMIT) return false;

  return data.every((row) => row.owner_discord_id === discordId);
}

/**
 * Discord snowflakes are numeric strings. Anything else is refused before it
 * reaches a PostgREST `or=` filter, whose comma/dot grammar is not escapable.
 */
function isSafeGuildId(guildId: string): boolean {
  return /^\d{1,32}$/.test(guildId);
}

/**
 * PostgREST `or=` expression selecting the caller's guild plus unattributed
 * rows, or `null` when unattributed rows must not be included.
 */
export function buildWebhookScopeFilter(
  guildId: string,
  includeUnattributed: boolean,
): string | null {
  if (!includeUnattributed || !isSafeGuildId(guildId)) return null;
  return `guild_id.eq.${guildId},guild_id.is.null`;
}

/**
 * Is this specific `webhook_events` row readable/replayable by the caller?
 *
 * Used by the replay route, which fetches by primary key and then authorizes,
 * so that an unauthorized row is indistinguishable from a missing one (404).
 */
export function mayAccessWebhookRow(
  rowGuildId: string | null | undefined,
  callerGuildId: string,
  isSoleOperator: boolean,
): boolean {
  if (rowGuildId === null || rowGuildId === undefined) return isSoleOperator;
  return rowGuildId === callerGuildId;
}
