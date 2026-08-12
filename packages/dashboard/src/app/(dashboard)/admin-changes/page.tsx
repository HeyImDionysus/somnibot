/**
 * Admin Changes — Change history with undo capability.
 * Phase D: SOTA admin change tracking and reversal.
 */
'use client';

import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { isApiRecord, requireApiArray, requireApiSuccess, requireReadback } from '@/lib/client-api-result';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';

// ── Types ─────────────────────────────────────────────────

interface AdminChange {
  id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  description: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  is_undoable: boolean;
  is_undone: boolean;
  undone_at: string | null;
  undone_by: string | null;
  undo_change_id: string | null;
  blast_radius: string;
  requires_confirmation: boolean;
  created_at: string;
}

function isAdminChange(value: unknown): value is AdminChange {
  return isApiRecord(value)
    && typeof value.id === 'string'
    && typeof value.actor_id === 'string'
    && typeof value.action === 'string'
    && typeof value.target_type === 'string'
    && (typeof value.target_id === 'string' || value.target_id === null)
    && typeof value.description === 'string'
    && (isApiRecord(value.before_state) || value.before_state === null)
    && (isApiRecord(value.after_state) || value.after_state === null)
    && typeof value.is_undoable === 'boolean'
    && typeof value.is_undone === 'boolean'
    && (typeof value.undone_at === 'string' || value.undone_at === null)
    && (typeof value.undone_by === 'string' || value.undone_by === null)
    && (typeof value.undo_change_id === 'string' || value.undo_change_id === null)
    && typeof value.blast_radius === 'string'
    && typeof value.requires_confirmation === 'boolean'
    && typeof value.created_at === 'string';
}

// ── Helpers ───────────────────────────────────────────────

const BLAST_STYLES: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400',
  high: 'bg-orange-500/20 text-orange-400',
  medium: 'bg-yellow-500/20 text-yellow-400',
  low: 'bg-blue-500/20 text-blue-400',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// ── Component ─────────────────────────────────────────────

export default function AdminChangesPage() {
  const { toast } = useToast();
  const [changes, setChanges] = useState<AdminChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [undoableOnly, setUndoableOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<AdminChange | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (undoableOnly) params.set('undoable', 'true');
      const res = await fetch(`/api/admin-changes?${params}`);
      const json = await requireApiSuccess(res, 'Could not load admin changes. Retry from this page.');
      const nextChanges = requireApiArray(json, 'data', isAdminChange, 'The admin-change service returned an invalid readback. Retry from this page.');
      setChanges(nextChanges);
      return nextChanges;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load admin changes. Retry from this page.');
      return null;
    } finally {
      setLoading(false);
    }
  }, [undoableOnly]);

  useEffect(() => { load(); }, [load]);

  const undoChange = async () => {
    if (!confirmUndo) return;
    setUndoing(confirmUndo.id);
    setError(null);
    try {
      const res = await fetch('/api/admin-changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undo', id: confirmUndo.id }),
      });
      await requireApiSuccess(res, 'Could not undo this change. The recorded state is unchanged.');
      const nextChanges = await load();
      requireReadback(
        nextChanges?.some((change) => change.id === confirmUndo.id && change.is_undone && !change.is_undoable) === true,
        'The undo was accepted, but the targeted change still has its previous state in the authoritative readback. Keep this dialog open and reload before retrying.',
      );
      toast({ title: 'Change undone', variant: 'success' });
      setConfirmUndo(null);
    } catch (undoError) {
      const message = undoError instanceof Error ? undoError.message : 'Could not undo this change. The recorded state is unchanged.';
      setError(message);
      toast({ title: 'Undo failed', description: message, variant: 'error' });
    } finally {
      setUndoing(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Admin Changes</h1>
          <p className="mt-1 text-sm text-discord-text-muted">Track and undo administrative changes across the dashboard</p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={undoableOnly}
            onChange={(e) => setUndoableOnly(e.target.checked)}
            className="rounded border-discord-border-subtle bg-discord-bg-tertiary"
          />
          <span className="text-sm text-discord-text-secondary">Undoable only</span>
        </label>
      </div>

      {error && (
        <div role="alert" className="rounded-card border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <TableSkeleton rows={6} />
      ) : changes.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">📝</div>
          <p className="text-discord-text-muted">No admin changes recorded yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {changes.map((change) => (
            <div key={change.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary">
              <div className="flex items-start rounded-lg px-4 py-3 hover:bg-discord-bg-tertiary/30 transition-colors">
                <button
                  type="button"
                  onClick={() => setExpandedId(expandedId === change.id ? null : change.id)}
                  aria-expanded={expandedId === change.id}
                  aria-label={`${expandedId === change.id ? 'Collapse' : 'Expand'} change: ${change.description}`}
                  className="min-w-0 flex-1 text-left"
                >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BLAST_STYLES[change.blast_radius] || ''}`}>
                      {change.blast_radius}
                    </span>
                    {change.is_undone && (
                      <span className="rounded-full bg-discord-bg-tertiary px-2 py-0.5 text-xs text-discord-text-muted line-through">
                        undone
                      </span>
                    )}
                    <span className="text-sm text-discord-text-primary truncate">{change.description}</span>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-xs text-discord-text-muted">{formatDate(change.created_at)}</span>
                </div>
                <div className="mt-1 text-xs text-discord-text-muted">
                  <span className="font-mono">{change.action}</span>
                  {' • '}
                  {change.target_type}
                  {change.target_id && `: ${change.target_id.slice(0, 12)}…`}
                  {' • '}
                  by <span className="font-mono">{change.actor_id.slice(0, 12)}</span>
                </div>
                </button>
                {change.is_undoable && !change.is_undone && (
                  <button
                    type="button"
                    onClick={() => setConfirmUndo(change)}
                    aria-label={`Undo change: ${change.description}`}
                    disabled={undoing === change.id}
                    className="ml-3 shrink-0 rounded-md bg-orange-500/20 px-3 py-1 text-xs font-medium text-orange-400 hover:bg-orange-500/30 transition-colors disabled:opacity-50"
                  >
                    {undoing === change.id ? 'Undoing…' : 'Undo'}
                  </button>
                )}
              </div>

              {expandedId === change.id && (
                <div className="border-t border-discord-border-subtle px-4 py-3 grid gap-3 md:grid-cols-2">
                  {change.before_state && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase text-discord-text-muted mb-1">Before</h4>
                      <pre className="overflow-x-auto rounded-md bg-discord-bg-primary p-3 text-xs text-discord-text-secondary max-h-48 overflow-y-auto">
                        {JSON.stringify(change.before_state, null, 2)}
                      </pre>
                    </div>
                  )}
                  {change.after_state && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase text-discord-text-muted mb-1">After</h4>
                      <pre className="overflow-x-auto rounded-md bg-discord-bg-primary p-3 text-xs text-discord-text-secondary max-h-48 overflow-y-auto">
                        {JSON.stringify(change.after_state, null, 2)}
                      </pre>
                    </div>
                  )}
                  {change.is_undone && change.undone_at && (
                    <div className="md:col-span-2 text-xs text-discord-text-muted">
                      Undone at {formatDate(change.undone_at)}
                      {change.undone_by && ` by ${change.undone_by.slice(0, 12)}`}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmUndo !== null}
        title="Undo administrative change"
        description={confirmUndo ? `Undo “${confirmUndo.description}” for ${confirmUndo.target_type}${confirmUndo.target_id ? ` ${confirmUndo.target_id}` : ''}. This applies the recorded before-state and may affect the current configuration.` : undefined}
        confirmLabel="Undo change"
        variant="warning"
        loading={undoing !== null}
        onConfirm={undoChange}
        onCancel={() => {
          if (!undoing) setConfirmUndo(null);
        }}
      />
    </div>
  );
}
