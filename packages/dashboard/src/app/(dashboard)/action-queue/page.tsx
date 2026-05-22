/**
 * Action Queue — Dead Letter Queue visibility and retry dashboard.
 *
 * V53 Phase 2 (Finding 2.3 — M-6)
 *
 * Shows failed actions that exhausted retries, with ability to:
 * - View error details
 * - Retry individual items
 * - Acknowledge (dismiss) items
 * - Bulk operations
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { DashboardSkeleton } from '@/components/shared/loading-skeleton';

// ── Types ─────────────────────────────────────────────────

interface DlqItem {
  id: string;
  action: string;
  payload: Record<string, unknown>;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  original_id: string | null;
  failed_at: string;
  acknowledged: boolean;
  acknowledged_at: string | null;
  retried: boolean;
  retried_at: string | null;
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

type FilterType = 'pending' | 'acknowledged' | 'retried' | 'all';

// ── Page Component ────────────────────────────────────────

export default function ActionQueuePage() {
  const [items, setItems] = useState<DlqItem[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  });
  const [filter, setFilter] = useState<FilterType>('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchItems = useCallback(
    async (page = 1) => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(
          `/api/action-queue?page=${page}&pageSize=20&filter=${filter}`,
        );
        const json = await res.json();
        if (!json.success) throw new Error(json.error ?? 'Failed to load');
        setItems(json.data.items);
        setPagination(json.data.pagination);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    },
    [filter],
  );

  useEffect(() => {
    fetchItems(1);
  }, [fetchItems]);

  const handleAction = async (action: 'acknowledge' | 'retry', ids: string[]) => {
    if (ids.length === 0) return;
    try {
      setActionLoading(true);
      const res = await fetch('/api/action-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ids }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Action failed');
      setSelectedIds(new Set());
      await fetchItems(pagination.page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((i) => i.id)));
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading && items.length === 0) {
    return <DashboardSkeleton title="Action Queue" />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Action Queue</h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            Failed automations that exhausted retries — review, retry, or dismiss.
          </p>
        </div>
        {pagination.total > 0 && (
          <span className="inline-flex items-center rounded-full bg-red-500/20 px-3 py-1 text-sm font-medium text-red-400">
            {pagination.total} failed
          </span>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        {(['pending', 'acknowledged', 'retried', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === f
                ? 'bg-discord-accent text-white'
                : 'bg-discord-bg-tertiary text-discord-text-secondary hover:bg-discord-bg-primary'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Bulk actions */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-discord-border-subtle bg-discord-bg-tertiary px-4 py-2">
          <span className="text-sm text-discord-text-secondary">
            {selectedIds.size} selected
          </span>
          <button
            onClick={() => handleAction('retry', [...selectedIds])}
            disabled={actionLoading}
            className="rounded-md bg-discord-accent px-3 py-1 text-sm font-medium text-white hover:bg-discord-accent/80 disabled:opacity-50"
          >
            Retry selected
          </button>
          <button
            onClick={() => handleAction('acknowledge', [...selectedIds])}
            disabled={actionLoading}
            className="rounded-md bg-discord-bg-primary px-3 py-1 text-sm font-medium text-discord-text-secondary hover:text-discord-text-primary disabled:opacity-50"
          >
            Dismiss selected
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && items.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-discord-border-subtle bg-discord-bg-secondary py-16">
          <div className="mb-3 text-4xl">✅</div>
          <p className="text-discord-text-primary font-medium">Queue is clear</p>
          <p className="mt-1 text-sm text-discord-text-muted">
            No {filter === 'all' ? '' : filter + ' '}failed actions
          </p>
        </div>
      )}

      {/* Table */}
      {items.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-discord-border-subtle bg-discord-bg-secondary">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-discord-border-subtle bg-discord-bg-tertiary text-discord-text-muted">
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === items.length && items.length > 0}
                    onChange={toggleSelectAll}
                    className="rounded border-discord-border-subtle"
                  />
                </th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Error</th>
                <th className="px-4 py-3">Retries</th>
                <th className="px-4 py-3">Failed</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 w-28">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-discord-border-subtle">
              {items.map((item) => (
                <>
                  <tr
                    key={item.id}
                    className="hover:bg-discord-bg-primary/30 transition-colors cursor-pointer"
                    onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleSelect(item.id)}
                        className="rounded border-discord-border-subtle"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <code className="rounded bg-discord-bg-tertiary px-1.5 py-0.5 text-xs text-discord-accent">
                        {item.action}
                      </code>
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      <span className="truncate block text-discord-text-secondary">
                        {item.error_message ?? 'No error details'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-discord-text-muted">
                      {item.retry_count}/{item.max_retries}
                    </td>
                    <td className="px-4 py-3 text-discord-text-muted">
                      {formatDate(item.failed_at)}
                    </td>
                    <td className="px-4 py-3">
                      {item.retried ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/20 px-2 py-0.5 text-xs text-blue-400">
                          Retried
                        </span>
                      ) : item.acknowledged ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-gray-500/20 px-2 py-0.5 text-xs text-gray-400">
                          Dismissed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-400">
                          Pending
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        {!item.retried && (
                          <button
                            onClick={() => handleAction('retry', [item.id])}
                            disabled={actionLoading}
                            className="rounded px-2 py-1 text-xs text-discord-accent hover:bg-discord-accent/10 disabled:opacity-50"
                            title="Retry"
                          >
                            ↻
                          </button>
                        )}
                        {!item.acknowledged && (
                          <button
                            onClick={() => handleAction('acknowledge', [item.id])}
                            disabled={actionLoading}
                            className="rounded px-2 py-1 text-xs text-discord-text-muted hover:bg-discord-bg-tertiary disabled:opacity-50"
                            title="Dismiss"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {/* Expanded detail row */}
                  {expandedId === item.id && (
                    <tr key={`${item.id}-detail`}>
                      <td colSpan={7} className="bg-discord-bg-primary/20 px-8 py-4">
                        <div className="space-y-3">
                          <div>
                            <h4 className="text-xs font-semibold uppercase text-discord-text-muted mb-1">
                              Payload
                            </h4>
                            <pre className="rounded-lg bg-discord-bg-tertiary p-3 text-xs text-discord-text-secondary overflow-x-auto max-h-48">
                              {JSON.stringify(item.payload, null, 2)}
                            </pre>
                          </div>
                          <div>
                            <h4 className="text-xs font-semibold uppercase text-discord-text-muted mb-1">
                              Error
                            </h4>
                            <pre className="rounded-lg bg-red-500/5 border border-red-500/20 p-3 text-xs text-red-400 overflow-x-auto max-h-32">
                              {item.error_message ?? 'No error details captured'}
                            </pre>
                          </div>
                          {item.original_id && (
                            <p className="text-xs text-discord-text-muted">
                              Original action ID: <code>{item.original_id}</code>
                            </p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-discord-text-muted">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchItems(pagination.page - 1)}
              disabled={pagination.page <= 1 || loading}
              className="rounded-md bg-discord-bg-tertiary px-3 py-1.5 text-sm text-discord-text-secondary hover:text-discord-text-primary disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={() => fetchItems(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages || loading}
              className="rounded-md bg-discord-bg-tertiary px-3 py-1.5 text-sm text-discord-text-secondary hover:text-discord-text-primary disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
