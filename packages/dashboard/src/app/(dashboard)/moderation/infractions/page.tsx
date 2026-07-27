/**
 * Infractions — View, search, and manage member infractions.
 *
 * Architecture doc §18.3
 */
'use client';

import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { useToast } from '@/components/shared/toast';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

import { useEffect, useState, useCallback } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';

interface Infraction {
  id: string;
  guild_id: string;
  member_id: string;
  moderator_id: string;
  type: string;
  reason: string;
  automod_rule_id: string | null;
  duration_minutes: number | null;
  active: boolean;
  pardoned: boolean;
  pardoned_by: string | null;
  pardoned_at: string | null;
  expires_at: string | null;
  created_at: string;
}

const TYPE_ICONS: Record<string, string> = {
  warn: '⚠️',
  mute: '🔇',
  kick: '👢',
  ban: '🔨',
};

const TYPE_COLORS: Record<string, string> = {
  warn: 'bg-yellow-500/20 text-yellow-400',
  mute: 'bg-orange-500/20 text-orange-400',
  kick: 'bg-red-500/20 text-red-400',
  ban: 'bg-red-600/20 text-red-500',
};

export default function InfractionsPage() {
  const [infractions, setInfractions] = useState<Infraction[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterMemberId, setFilterMemberId] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [showManualWarn, setShowManualWarn] = useState(false);
  const [manualForm, setManualForm] = useState({ member_id: '', type: 'warn', reason: '' });
  const [saving, setSaving] = useState(false);
  const [confirmPardon, setConfirmPardon] = useState<string | null>(null);
  const { toast } = useToast();

  const PAGE_SIZE = 20;

  const loadInfractions = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (filterMemberId) params.set('member_id', filterMemberId);
      if (activeOnly) params.set('active', 'true');

      const res = await fetch(`/api/moderation/infractions?${params}`);
      const json = await res.json();
      if (json.success) {
        setInfractions(json.data);
        setTotal(json.total);
      }
    } catch {
      setError('Failed to load infractions');
    } finally {
      setLoading(false);
    }
  }, [filterMemberId, activeOnly, page]);

  useEffect(() => {
    loadInfractions();
  }, [loadInfractions]);

  // GAP 2: Live updates — auto-refresh when infraction data changes in DB
  useAutoRefresh('infractions', undefined, loadInfractions);

  const handlePardon = async (id: string) => {
    try {
      const res = await fetch('/api/moderation/infractions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'pardon' }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast({ title: 'Infraction pardoned', variant: 'success' });
      await loadInfractions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to pardon';
      setError(msg);
      toast({ title: msg, variant: 'error' });
    }
  };

  const handleManualWarn = async () => {
    if (!manualForm.member_id || !manualForm.reason) return;
    setSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/moderation/infractions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manualForm),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast({ title: `${manualForm.type.charAt(0).toUpperCase() + manualForm.type.slice(1)} issued`, variant: 'success' });
      setShowManualWarn(false);
      setManualForm({ member_id: '', type: 'warn', reason: '' });
      await loadInfractions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create infraction';
      setError(msg);
      toast({ title: msg, variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Infractions</h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            {total} total infraction{total !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => setShowManualWarn(!showManualWarn)}
          className="rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent-hover"
        >
          + Manual Infraction
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Manual Warn Form */}
      {showManualWarn && (
        <div className="rounded-lg border-2 border-discord-accent/30 bg-discord-bg-secondary p-4 space-y-3">
          <h3 className="font-medium text-discord-text-primary">Create Manual Infraction</h3>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-discord-text-muted mb-1">Member Discord ID</label>
              <input
                type="text"
                value={manualForm.member_id}
                onChange={(e) => setManualForm({ ...manualForm, member_id: e.target.value })}
                placeholder="123456789012345678"
                className="w-full rounded border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted"
              />
            </div>
            <div>
              <label className="block text-xs text-discord-text-muted mb-1">Type</label>
              <select
                value={manualForm.type}
                onChange={(e) => setManualForm({ ...manualForm, type: e.target.value })}
                className="w-full rounded border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary"
              >
                <option value="warn">Warning</option>
                <option value="mute">Mute</option>
                <option value="kick">Kick</option>
                <option value="ban">Ban</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-discord-text-muted mb-1">Reason</label>
              <input
                type="text"
                value={manualForm.reason}
                onChange={(e) => setManualForm({ ...manualForm, reason: e.target.value })}
                placeholder="Reason for infraction"
                className="w-full rounded border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleManualWarn}
              disabled={saving || !manualForm.member_id || !manualForm.reason}
              className="rounded bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent-hover disabled:opacity-50"
            >
              {saving ? 'Creating...' : 'Create'}
            </button>
            <button
              onClick={() => setShowManualWarn(false)}
              className="rounded bg-discord-bg-tertiary px-4 py-2 text-sm text-discord-text-muted hover:text-discord-text-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-4">
        <input
          type="text"
          value={filterMemberId}
          onChange={(e) => {
            setFilterMemberId(e.target.value);
            setPage(0);
          }}
          placeholder="Filter by member ID..."
          className="w-64 rounded-md border border-discord-border-subtle bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-discord-accent focus:outline-none"
        />
        <label className="flex items-center gap-2 text-sm text-discord-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => {
              setActiveOnly(e.target.checked);
              setPage(0);
            }}
            className="rounded"
          />
          Active only
        </label>
      </div>

      {/* Table */}
      {loading ? (
        <TableSkeleton rows={8} />
      ) : infractions.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-discord-border-subtle bg-discord-bg-secondary py-16">
          <span className="text-4xl">📋</span>
          <h3 className="mt-4 text-lg font-medium text-discord-text-primary">No Infractions</h3>
          <p className="mt-1 text-sm text-discord-text-muted">
            {filterMemberId || activeOnly ? 'No infractions match your filters.' : 'No infractions recorded yet.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-discord-border-subtle">
          <table className="w-full">
            <thead>
              <tr className="border-b border-discord-border-subtle bg-discord-bg-tertiary">
                <th className="px-4 py-3 text-left text-xs font-medium text-discord-text-muted uppercase">Type</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-discord-text-muted uppercase">Member</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-discord-text-muted uppercase">Moderator</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-discord-text-muted uppercase">Reason</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-discord-text-muted uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-discord-text-muted uppercase">Date</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-discord-text-muted uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-discord-border bg-discord-bg-secondary">
              {infractions.map((inf) => (
                <tr key={inf.id} className={inf.active ? '' : 'opacity-50'}>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TYPE_COLORS[inf.type] ?? ''}`}>
                      {TYPE_ICONS[inf.type]} {inf.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-discord-text-primary font-mono">
                    {inf.member_id}
                  </td>
                  <td className="px-4 py-3 text-sm text-discord-text-muted">
                    {inf.moderator_id === 'system' ? (
                      <span className="text-discord-accent">Auto-Mod</span>
                    ) : inf.moderator_id === 'dashboard' ? (
                      <span className="text-discord-accent">Dashboard</span>
                    ) : (
                      <span className="font-mono">{inf.moderator_id}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-discord-text-muted max-w-xs truncate" title={inf.reason}>
                    {inf.reason}
                  </td>
                  <td className="px-4 py-3">
                    {inf.pardoned ? (
                      <span className="text-xs text-green-400">Pardoned</span>
                    ) : inf.active ? (
                      <span className="text-xs text-yellow-400">Active</span>
                    ) : (
                      <span className="text-xs text-discord-text-muted">Expired</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-discord-text-muted whitespace-nowrap">
                    {new Date(inf.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    {inf.active && !inf.pardoned && (
                      <button
                        onClick={() => setConfirmPardon(inf.id)}
                        className="rounded bg-green-500/20 px-2.5 py-1 text-xs font-medium text-green-400 hover:bg-green-500/30"
                      >
                        Pardon
                      </button>
                    )}
                  </td>
                </tr>
              ))}
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
        open={!!confirmPardon}
        title="Pardon Infraction"
        description="Are you sure you want to pardon this infraction? This will deactivate it and it won't count toward escalation thresholds."
        confirmLabel="Pardon"
        variant="default"
        onConfirm={() => {
          if (confirmPardon) handlePardon(confirmPardon);
          setConfirmPardon(null);
        }}
        onCancel={() => setConfirmPardon(null)}
      />
    </div>
  );
}
