/**
 * Appeals — review, approve, and deny member infraction appeals.
 *
 * Deciding an appeal is atomic server-side (only a still-pending appeal can be
 * decided). The member is DM'd the outcome by the bot's maintenance sweep.
 *
 * Architecture doc §18 (moderation) — appeals extension.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { useToast } from '@/components/shared/toast';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useAutoRefresh } from '@/hooks/use-realtime-events';

interface Appeal {
  id: string;
  guild_id: string;
  infraction_id: string;
  appellant_discord_id: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  reviewer_id: string | null;
  decided_at: string | null;
  created_at: string;
  expires_at: string | null;
}

type StatusFilter = 'all' | 'pending' | 'approved' | 'denied' | 'expired';

const STATUS_BADGE: Record<Appeal['status'], { label: string; className: string }> = {
  pending: { label: '🕓 Pending', className: 'bg-yellow-500/20 text-yellow-400' },
  approved: { label: '✅ Approved', className: 'bg-green-500/20 text-green-400' },
  denied: { label: '❌ Denied', className: 'bg-red-500/20 text-red-400' },
  expired: { label: '⚪ Expired', className: 'bg-discord-bg-tertiary text-discord-text-muted' },
};

const FILTERS: StatusFilter[] = ['all', 'pending', 'approved', 'denied', 'expired'];

type PendingDecision = { id: string; action: 'approve' | 'deny' } | null;

export default function AppealsPage() {
  const [appeals, setAppeals] = useState<Appeal[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [page, setPage] = useState(0);
  const [decision, setDecision] = useState<PendingDecision>(null);
  const [deciding, setDeciding] = useState(false);
  const { toast } = useToast();

  const PAGE_SIZE = 20;

  const loadAppeals = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (statusFilter !== 'all') params.set('status', statusFilter);

      const res = await fetch(`/api/moderation/appeals?${params}`);
      const json = await res.json();
      if (json.success) {
        setAppeals(json.data);
        setTotal(json.total);
        setError(null);
      } else {
        setError(json.error ?? 'Failed to load appeals');
      }
    } catch {
      setError('Failed to load appeals');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    loadAppeals();
  }, [loadAppeals]);

  // Live updates — auto-refresh when appeal rows change in the DB.
  useAutoRefresh('appeals', undefined, loadAppeals);

  const handleDecision = async (id: string, action: 'approve' | 'deny') => {
    setDeciding(true);
    try {
      const res = await fetch('/api/moderation/appeals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast({
        title: action === 'approve' ? 'Appeal approved' : 'Appeal denied',
        variant: 'success',
      });
      await loadAppeals();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to decide appeal';
      setError(msg);
      toast({ title: msg, variant: 'error' });
    } finally {
      setDeciding(false);
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Appeals</h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          Review member appeals against moderation actions. Approving or denying DMs the member automatically.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => {
              setStatusFilter(f);
              setPage(0);
            }}
            className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              statusFilter === f
                ? 'bg-somni-pink text-white'
                : 'bg-discord-bg-secondary text-discord-text-muted hover:text-discord-text-primary'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <TableSkeleton rows={8} />
      ) : appeals.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-discord-border bg-discord-bg-secondary py-16">
          <span className="text-4xl">⚖️</span>
          <h3 className="mt-4 text-lg font-semibold text-discord-text-primary">No Appeals</h3>
          <p className="mt-1 text-sm text-discord-text-muted">
            {statusFilter === 'all'
              ? 'No appeals have been filed yet.'
              : `No ${statusFilter} appeals.`}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-discord-border">
          <table className="w-full">
            <thead>
              <tr className="border-b border-discord-border bg-discord-bg-tertiary">
                <th className="px-4 py-3 text-left text-xs font-medium text-discord-text-muted uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-discord-text-muted uppercase">Appellant</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-discord-text-muted uppercase">Reason</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-discord-text-muted uppercase">Infraction</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-discord-text-muted uppercase">Filed</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-discord-text-muted uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-discord-border bg-discord-bg-secondary">
              {appeals.map((appeal) => {
                const badge = STATUS_BADGE[appeal.status];
                return (
                  <tr key={appeal.id} className={appeal.status === 'pending' ? '' : 'opacity-70'}>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-discord-text-primary font-mono">
                      {appeal.appellant_discord_id}
                    </td>
                    <td className="px-4 py-3 text-sm text-discord-text-muted max-w-xs truncate" title={appeal.reason}>
                      {appeal.reason}
                    </td>
                    <td className="px-4 py-3 text-xs text-discord-text-muted font-mono" title={appeal.infraction_id}>
                      {appeal.infraction_id.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-3 text-xs text-discord-text-muted whitespace-nowrap">
                      {new Date(appeal.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      {appeal.status === 'pending' ? (
                        <div className="flex gap-2">
                          <button
                            onClick={() => setDecision({ id: appeal.id, action: 'approve' })}
                            disabled={deciding}
                            className="rounded bg-green-500/20 px-2.5 py-1 text-xs font-medium text-green-400 hover:bg-green-500/30 disabled:opacity-50"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => setDecision({ id: appeal.id, action: 'deny' })}
                            disabled={deciding}
                            className="rounded bg-red-500/20 px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-500/30 disabled:opacity-50"
                          >
                            Deny
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-discord-text-muted">
                          {appeal.reviewer_id ? `by ${appeal.reviewer_id}` : '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="rounded bg-discord-bg-tertiary px-3 py-1.5 text-sm text-discord-text-muted hover:text-discord-text-primary disabled:opacity-50"
          >
            ← Previous
          </button>
          <span className="text-sm text-discord-text-muted">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
            className="rounded bg-discord-bg-tertiary px-3 py-1.5 text-sm text-discord-text-muted hover:text-discord-text-primary disabled:opacity-50"
          >
            Next →
          </button>
        </div>
      )}

      <ConfirmDialog
        open={!!decision}
        title={decision?.action === 'approve' ? 'Approve Appeal' : 'Deny Appeal'}
        description={
          decision?.action === 'approve'
            ? 'Approve this appeal? The member will be DM’d that their appeal was approved.'
            : 'Deny this appeal? The member will be DM’d that their appeal was denied and the infraction stands.'
        }
        confirmLabel={decision?.action === 'approve' ? 'Approve' : 'Deny'}
        variant={decision?.action === 'deny' ? 'danger' : 'default'}
        onConfirm={() => {
          if (decision) handleDecision(decision.id, decision.action);
          setDecision(null);
        }}
        onCancel={() => setDecision(null)}
      />
    </div>
  );
}
