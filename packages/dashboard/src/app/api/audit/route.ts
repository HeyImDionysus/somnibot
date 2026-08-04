/**
 * /api/audit — Paginated, filterable audit log API.
 *
 * GET: List audit logs with filters (category, actor, date range, search, action)
 *      Supports CSV and JSON export via ?format=csv|json&export=true
 *
 * Architecture doc §33.3.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { sanitizeSearch } from '@/lib/utils/sanitize-search';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_EXPORT_ROWS = 10_000;

export async function GET(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const isExport = searchParams.get('export') === 'true';

  // Read the owner-configured export cap from the same guild_config row that
  // the Settings control writes. Missing/legacy rows retain the shipped cap.
  const { data: config } = await supabase
    .from('guild_config')
    .select('audit_export_row_limit')
    .eq('guild_id', guildId)
    .maybeSingle();
  const maxExportRows = Number.isInteger(config?.audit_export_row_limit)
    ? Math.max(1, Math.min(100_000, config.audit_export_row_limit))
    : DEFAULT_MAX_EXPORT_ROWS;

  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10)));
  const category = searchParams.get('category');
  const actorId = searchParams.get('actorId');
  const action = searchParams.get('action');
  const search = searchParams.get('search');
  const dateFrom = searchParams.get('dateFrom');
  const dateTo = searchParams.get('dateTo');
  const format = searchParams.get('format') ?? 'json';

  // Build query
  let query = supabase
    .from('audit_logs')
    .select('*', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('timestamp', { ascending: false })
    .limit(isExport ? maxExportRows : 500);

  if (category) {
    query = query.eq('category', category);
  }
  if (actorId) {
    query = query.eq('actor_id', actorId);
  }
  if (action) {
    query = query.eq('action', action);
  }
  if (dateFrom) {
    query = query.gte('timestamp', dateFrom);
  }
  if (dateTo) {
    query = query.lte('timestamp', dateTo);
  }
  if (search) {
    const s = sanitizeSearch(search);
    if (s) {
      query = query.or(`action.ilike.%${s}%,actor_id.ilike.%${s}%,target_id.ilike.%${s}%`);
    }
  }

  if (isExport) {
    // Export — return all matching rows up to the persisted owner cap.
    query = query.limit(maxExportRows);
  } else {
    // Paginate
    const from = (page - 1) * pageSize;
    query = query.range(from, from + pageSize - 1);
  }

  const { data, error, count } = await query;

  if (error) {
    return dbError(error, 'audit');
  }

  if (isExport && format === 'csv') {
    // Generate CSV
    const rows = data ?? [];
    const headers = ['timestamp', 'action', 'category', 'actor_type', 'actor_id', 'target_type', 'target_id', 'success', 'error_message', 'details'];
    const csvLines = [headers.join(',')];

    for (const row of rows) {
      csvLines.push(headers.map((h) => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
        return `"${String(val).replace(/"/g, '""')}"`;
      }).join(','));
    }

    return new NextResponse(csvLines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  return NextResponse.json({
    success: true,
    data: data ?? [],
    pagination: {
      page,
      pageSize,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / pageSize),
    },
  });
}
