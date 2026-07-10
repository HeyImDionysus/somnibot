/**
 * /api/counts — Return row counts for sidebar badges and widgets.
 *
 * Accepts either:
 *   ?table=<one table>      → { count: number }
 *   ?tables=<a,b,c>         → { counts: { [table]: number } }
 *
 * The batch (`tables`) form exists so the sidebar can fetch every badge
 * count in a single request instead of one request per badge. With four
 * badges polling on an interval, per-badge requests fan out into a
 * thundering herd against this per-IP rate-limited route; batching keeps
 * each dashboard session to one request per poll.
 *
 * GAP 4: Operator UX — Sidebar live badges
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';
import type { AuthContext } from '@/lib/rbac';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { hasPermission } from '@somnibot/shared';
import type { DashboardPermission } from '@somnibot/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

const ALLOWED_TABLES = [
  'tickets',
  'orders',
  'giveaways',
  'infractions',
  'incidents',
  'action_queue_dlq',
] as const;

type AllowedTable = (typeof ALLOWED_TABLES)[number];

/**
 * Tables whose counts are sensitive enough to require guild-owner
 * authorization. `action_queue_dlq` may contain plaintext license keys
 * (see the DLQ lockdown migration) and its page is gated behind
 * `requireGuildOwner()` in /api/action-queue and /api/diagnostics, so a
 * non-owner dashboard user must not be able to read its volume here either.
 */
const OWNER_ONLY_TABLES: ReadonlySet<AllowedTable> = new Set(['action_queue_dlq']);

/**
 * Per-table permission gate. Each badge count mirrors the permission that
 * gates its own dashboard page/API (see ROUTE_PERMISSIONS in shared/rbac),
 * so a delegated user with only an unrelated permission cannot read
 * operational/commerce volume for pages they cannot open. `full_access`
 * (owners) satisfies every entry via hasPermission(). `action_queue_dlq`
 * is intentionally absent — it is owner-gated by OWNER_ONLY_TABLES, a
 * stronger gate than any single permission.
 */
const TABLE_PERMISSIONS: Record<
  Exclude<AllowedTable, 'action_queue_dlq'>,
  DashboardPermission
> = {
  tickets: 'dashboard.manage_tickets', // /tickets
  orders: 'dashboard.manage_orders', // /store/orders
  giveaways: 'dashboard.manage_server', // /giveaways
  infractions: 'dashboard.manage_moderation', // /moderation/infractions
  incidents: 'dashboard.manage_incidents', // /incidents
};

/** V7 Audit §7.P3a — Zod-validated single-table query param for /api/counts */
const countsQuerySchema = z.object({
  table: z.enum(ALLOWED_TABLES),
});

/**
 * Whether the caller is authorized to read the count for `table`. Owner-only
 * tables require the guild owner; every other table requires the same
 * permission that gates its own dashboard page, so the badge never exposes
 * volume for an area the user cannot open. Returns false (→ count 0) rather
 * than erroring so an unauthorized badge simply renders nothing.
 */
function canCountTable(ctx: AuthContext, table: AllowedTable): boolean {
  if (OWNER_ONLY_TABLES.has(table)) return ctx.isOwner;
  const required = TABLE_PERMISSIONS[table as Exclude<AllowedTable, 'action_queue_dlq'>];
  return hasPermission(ctx.permissions, required);
}

/**
 * Run the count query for a single allowed table, applying the same
 * status filters used across the dashboard. Returns 0 for any table the
 * caller is not authorized to read (owner-only DLQ, or a table whose page
 * permission the delegated user lacks) so its presence/volume stays hidden
 * (the badge renders nothing at 0).
 */
async function countForTable(
  supabase: SupabaseClient,
  ctx: AuthContext,
  table: AllowedTable,
): Promise<number> {
  // Gate each table behind its matching authorization (owner for the DLQ,
  // otherwise the same permission that protects its dashboard page) so the
  // count never leaks operational/commerce volume to users blocked from it.
  if (!canCountTable(ctx, table)) {
    return 0;
  }

  let query = supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', ctx.guildId);

  // Apply status filter for tables that have status columns
  if (table === 'tickets') {
    // Active tickets = open OR claimed-but-not-closed. Matches the
    // dashboard stats query (api/dashboard/stats) so a fully-claimed
    // backlog still surfaces in the nav badge.
    query = query.in('status', ['open', 'claimed']);
  } else if (table === 'orders') {
    query = query.eq('status', 'pending');
  } else if (table === 'giveaways') {
    query = query.eq('status', 'active');
  } else if (table === 'incidents') {
    query = query.in('status', ['open', 'investigating', 'identified', 'monitoring']);
  } else if (table === 'action_queue_dlq') {
    // Pending = not yet acknowledged and not yet retried. Uses the admin
    // (service role) client — the table is intentionally service_role-only.
    query = query.eq('acknowledged', false).eq('retried', false);
  }

  const { count, error } = await query;
  if (error) return 0;
  return count ?? 0;
}

/** Parse a `tables` param into a deduped list of allowed tables. */
function parseTables(raw: string): AllowedTable[] {
  const allowed = new Set<string>(ALLOWED_TABLES);
  const seen = new Set<AllowedTable>();
  const out: AllowedTable[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (allowed.has(name) && !seen.has(name as AllowedTable)) {
      seen.add(name as AllowedTable);
      out.push(name as AllowedTable);
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'standard');
  if (rateLimited) return rateLimited;

  const { searchParams } = new URL(req.url);
  const tablesParam = searchParams.get('tables');

  try {
    // Batch form: ?tables=a,b,c → { counts: { table: number } }
    if (tablesParam !== null) {
      const tables = parseTables(tablesParam);
      if (tables.length === 0) {
        return NextResponse.json({ counts: {} });
      }

      const ctx = await requirePermission(null);
      const supabase = createAdminSupabase();

      const results = await Promise.all(
        tables.map(async (table) => [table, await countForTable(supabase, ctx, table)] as const),
      );

      const counts: Record<string, number> = {};
      for (const [table, count] of results) counts[table] = count;
      return NextResponse.json({ counts });
    }

    // Single-table form: ?table=x → { count: number }
    const parsed = countsQuerySchema.safeParse({ table: searchParams.get('table') });
    if (!parsed.success) {
      return NextResponse.json({ count: 0 });
    }

    const ctx = await requirePermission(null);
    const supabase = createAdminSupabase();
    const count = await countForTable(supabase, ctx, parsed.data.table);
    return NextResponse.json({ count });
  } catch {
    return tablesParam !== null
      ? NextResponse.json({ counts: {} })
      : NextResponse.json({ count: 0 });
  }
}
