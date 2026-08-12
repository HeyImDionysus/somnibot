/**
 * Audit Log — Filterable log viewer with category badges, actor icons,
 * expandable detail rows, date range picker, and export buttons.
 *
 * Architecture doc §33.3.
 */
'use client';

import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ScrollText } from 'lucide-react';

import { useEffect, useState, useCallback } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';
import { downloadAuditExport } from '@/lib/audit-export';
import { CATEGORIES, ACTOR_ICONS, CATEGORY_COLORS } from './audit-constants';

// ── Types ─────────────────────────────────────────────────

interface AuditEntry {
  id: string;
  guild_id: string;
  timestamp: string;
  actor_type: 'user' | 'bot' | 'system' | 'webhook' | 'automation' | 'discord' | 'dashboard';
  actor_id: string;
  action: string;
  category: string | null;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  success: boolean;
  error_message: string | null;
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// ── Component ─────────────────────────────────────────────

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1, pageSize: 50, total: 0, totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Filters
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const fetchLogs = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '50' });
      if (category) params.set('category', category);
      if (search) params.set('search', search);
      if (dateFrom) params.set('dateFrom', new Date(dateFrom).toISOString());
      if (dateTo) params.set('dateTo', new Date(dateTo + 'T23:59:59').toISOString());

      const res = await fetch(`/api/audit?${params}`);
      const json = await res.json();
      if (json.success) {
        setEntries(json.data);
        setPagination(json.pagination);
      }
    } catch (err) {
      console.error('Failed to fetch audit logs:', err);
    } finally {
      setLoading(false);
    }
  }, [category, search, dateFrom, dateTo]);

  useEffect(() => {
    fetchLogs(1);
  }, [fetchLogs]);

  // GAP 2: Live updates — auto-refresh when new audit entries arrive
  const refetchCurrentPage = useCallback(() => fetchLogs(pagination.page), [fetchLogs, pagination.page]);
  useAutoRefresh('audit_log', undefined, refetchCurrentPage);

  const handleExport = async (format: 'csv' | 'json') => {
    setExportError(null);
    try {
      const result = await downloadAuditExport(format, { category, search, dateFrom, dateTo });
      if (!result.ok) setExportError(result.error);
    } catch {
      setExportError('Could not reach the server to export audit logs.');
    }
  };

  const formatDate = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Audit Log</h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            Track all actions and events across your server
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleExport('csv')}
            className="rounded-md bg-discord-bg-secondary px-3 py-1.5 text-sm text-discord-text-secondary hover:bg-discord-bg-tertiary hover:text-discord-text-primary transition-colors"
          >
            Export CSV
          </button>
          <button
            onClick={() => handleExport('json')}
            className="rounded-md bg-discord-bg-secondary px-3 py-1.5 text-sm text-discord-text-secondary hover:bg-discord-bg-tertiary hover:text-discord-text-primary transition-colors"
          >
            Export JSON
          </button>
        </div>
      </div>

      {exportError && (
        <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          {exportError}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 rounded-lg bg-discord-bg-secondary p-4">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-accent"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>

        <input
          type="text"
          placeholder="Search actions, actors, targets..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-[200px] flex-1 rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder:text-discord-text-muted outline-none focus:ring-2 focus:ring-discord-accent"
        />

        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-accent [color-scheme:dark]"
        />

        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-accent [color-scheme:dark]"
        />

        {(category || search || dateFrom || dateTo) && (
          <button
            onClick={() => { setCategory(''); setSearch(''); setDateFrom(''); setDateTo(''); }}
            className="rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-muted hover:text-discord-text-primary transition-colors"
          >
            Clear Filters
          </button>
        )}
      </div>

      {/* Results count */}
      <p className="text-sm text-discord-text-muted">
        {pagination.total.toLocaleString()} entries found
      </p>

      {/* Log entries */}
      <div className="space-y-1">
        {loading ? (
          <TableSkeleton rows={10} />
        ) : entries.length === 0 ? (
          <EmptyState icon={ScrollText} title="No audit log entries found" description="Activity will appear here as the bot processes events." />
        ) : (
          entries.map((entry) => {
            const isExpanded = expandedId === entry.id;
            const categoryStyle = CATEGORY_COLORS[entry.category ?? 'system'] ?? CATEGORY_COLORS.system;

            return (
              <div key={entry.id} className="rounded-lg bg-discord-bg-secondary">
                <button
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-discord-bg-tertiary/30 transition-colors rounded-lg"
                >
                  {/* Actor icon */}
                  <span className="mt-0.5 text-lg" title={entry.actor_type}>
                    {ACTOR_ICONS[entry.actor_type] ?? '❓'}
                  </span>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${categoryStyle}`}>
                        {entry.category ?? 'system'}
                      </span>
                      <span className="text-sm font-medium text-discord-text-primary">
                        {entry.action}
                      </span>
                      {!entry.success && (
                        <span className="inline-flex items-center rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400">
                          Failed
                        </span>
                      )}
                    </div>

                    <div className="mt-1 flex items-center gap-3 text-xs text-discord-text-muted">
                      <span>{formatDate(entry.timestamp)}</span>
                      {entry.target_type && (
                        <span>
                          Target: <span className="text-discord-text-secondary">{entry.target_type}</span>
                          {entry.target_id && (
                            <span className="ml-1 font-mono text-discord-text-secondary">{entry.target_id.slice(0, 12)}{entry.target_id.length > 12 ? '…' : ''}</span>
                          )}
                        </span>
                      )}
                      <span>
                        Actor: <span className="font-mono text-discord-text-secondary">{entry.actor_id.slice(0, 12)}{entry.actor_id.length > 12 ? '…' : ''}</span>
                      </span>
                    </div>
                  </div>

                  {/* Expand indicator */}
                  <span className={`text-discord-text-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
                    ▶
                  </span>
                </button>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="border-t border-discord-border-subtle px-4 py-3 space-y-2">
                    {entry.error_message && (
                      <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">
                        Error: {entry.error_message}
                      </div>
                    )}

                    <div>
                      <h4 className="text-xs font-semibold uppercase text-discord-text-muted mb-1">Details</h4>
                      <pre className="overflow-x-auto rounded-md bg-discord-bg-primary p-3 text-xs text-discord-text-secondary">
                        {JSON.stringify(entry.details, null, 2)}
                      </pre>
                    </div>

                    {entry.before_state && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase text-discord-text-muted mb-1">Before State</h4>
                        <pre className="overflow-x-auto rounded-md bg-discord-bg-primary p-3 text-xs text-discord-text-secondary">
                          {JSON.stringify(entry.before_state, null, 2)}
                        </pre>
                      </div>
                    )}

                    {entry.after_state && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase text-discord-text-muted mb-1">After State</h4>
                        <pre className="overflow-x-auto rounded-md bg-discord-bg-primary p-3 text-xs text-discord-text-secondary">
                          {JSON.stringify(entry.after_state, null, 2)}
                        </pre>
                      </div>
                    )}

                    <div className="flex gap-4 text-xs text-discord-text-muted pt-1">
                      <span>ID: <code className="font-mono">{entry.id}</code></span>
                      <span>Actor Type: {entry.actor_type}</span>
                      <span>Actor ID: <code className="font-mono">{entry.actor_id}</code></span>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-discord-text-muted">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => fetchLogs(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="rounded-md bg-discord-bg-secondary px-3 py-1.5 text-sm text-discord-text-secondary hover:bg-discord-bg-tertiary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => fetchLogs(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              className="rounded-md bg-discord-bg-secondary px-3 py-1.5 text-sm text-discord-text-secondary hover:bg-discord-bg-tertiary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
