/**
 * /api/counts — Return row counts for sidebar badges and widgets.
 * Accepts ?table=... and optional ?filter=...
 *
 * GAP 4: Operator UX — Sidebar live badges
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

const ALLOWED_TABLES = [
  'tickets',
  'orders',
  'giveaways',
  'infractions',
  'incidents',
] as const;

/** V7 Audit §7.P3a — Zod-validated query params for /api/counts */
const countsQuerySchema = z.object({
  table: z.enum(ALLOWED_TABLES),
});

export async function GET(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'standard');
  if (rateLimited) return rateLimited;

  const { searchParams } = new URL(req.url);
  const parsed = countsQuerySchema.safeParse({ table: searchParams.get('table') });

  if (!parsed.success) {
    return NextResponse.json({ count: 0 });
  }
  const { table } = parsed.data;

  try {
    const ctx = await requirePermission(null);
    const supabase = createAdminSupabase();
    let query = supabase.from(table).select('id', { count: 'exact', head: true }).eq('guild_id', ctx.guildId);

    // Apply status filter for tables that have status columns
    if (table === 'tickets') {
      query = query.eq('status', 'open');
    } else if (table === 'orders') {
      query = query.eq('status', 'pending');
    } else if (table === 'giveaways') {
      query = query.eq('status', 'active');
    } else if (table === 'incidents') {
      query = query.in('status', ['open', 'investigating', 'identified', 'monitoring']);
    }

    const { count, error } = await query;

    if (error) {
      return NextResponse.json({ count: 0 });
    }

    return NextResponse.json({ count: count ?? 0 });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
