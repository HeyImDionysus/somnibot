/**
 * /api/counts — Return row counts for sidebar badges and widgets.
 * Accepts ?table=... and optional ?filter=...
 *
 * GAP 4: Operator UX — Sidebar live badges
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';

const ALLOWED_TABLES = new Set([
  'tickets',
  'orders',
  'giveaways',
  'infractions',
  'incidents',
]);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const table = searchParams.get('table');

  if (!table || !ALLOWED_TABLES.has(table)) {
    return NextResponse.json({ count: 0 });
  }

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
