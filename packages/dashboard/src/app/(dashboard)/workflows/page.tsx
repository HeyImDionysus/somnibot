/**
 * Workflows — Event log + dead-letter queue management.
 * Phase D: SOTA workflow replay and dead-letter UI.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────

interface WorkflowEvent {
  id: string;
  event_type: string;
  source: string;
  correlation_id: string | null;
  payload: Record<string, unknown>;
  result: string | null;
  error_message: string | null;
  duration_ms: number | null;
  parent_event_id: string | null;
  created_at: string;
}

interface DeadLetterItem {
  id: string;
  event_type: string;
  source: string;
  payload: Record<string, unknown>;
  error_message: string | null;
  error_stack: string | null;
  retry_count: number;
  max_retries: number;
  status: string;
  first_failed_at: string;
  last_retry_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string;
}

interface DLQSummary {
  total: number;
  pending: number;
  retrying: number;
  exhausted: number;
  resolved: number;
  discarded: number;
}

// ── Helpers ───────────────────────────────────────────────

const RESULT_STYLES: Record<string, string> = {
  success: 'bg-discord-success/20 text-discord-success',
  error: 'bg-red-500/20 text-red-400',
  skipped: 'bg-discord-bg-tertiary text-discord-text-muted',
  pending: 'bg-yellow-500/20 text-yellow-400',
};

const DLQ_STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400',
  retrying: 'bg-blue-500/20 text-blue-400',
  exhausted: 'bg-red-500/20 text-red-400',
  resolved: 'bg-discord-success/20 text-discord-success',
  discarded: 'bg-discord-bg-tertiary text-discord-text-muted',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// ── Component ─────────────────────────────────────────────

export default function WorkflowsPage() {
  const [tab, setTab] = useState<'events' | 'dead-letter'>('events');
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [dlqItems, setDlqItems] = useState<DeadLetterItem[]>([]);
  const [dlqSummary, setDlqSummary] = useState<DLQSummary>({ total: 0, pending: 0, retrying: 0, exhausted: 0, resolved: 0, discarded: 0 });
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resultFilter, setResultFilter] = useState('');
  const [dlqStatusFilter, setDlqStatusFilter] = useState('');

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (resultFilter) params.set('result', resultFilter);
      const res = await fetch(`/api/workflows/events?${params}`);
      const json = await res.json();
      if (json.success) setEvents(json.data);
    } finally {
      setLoading(false);
    }
  }, [resultFilter]);

  const loadDLQ = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dlqStatusFilter) params.set('status', dlqStatusFilter);
      const res = await fetch(`/api/workflows/dead-letter?${params}`);
      const json = await res.json();
      if (json.success) {
        setDlqItems(json.data);
        setDlqSummary(json.summary);
      }
    } finally {
      setLoading(false);
    }
  }, [dlqStatusFilter]);

  useEffect(() => {
    if (tab === 'events') loadEvents();
    else loadDLQ();
  }, [tab, loadEvents, loadDLQ]);

  const handleDLQAction = async (id: string, action: 'retry' | 'discard' | 'resolve', note?: string) => {
    await fetch('/api/workflows/dead-letter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action, note }),
    });
    loadDLQ();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Workflows</h1>
        <p className="mt-1 text-sm text-discord-text-muted">Event log and dead-letter queue for durable workflow operations</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-discord-border-subtle">
        {[
          { key: 'events' as const, label: 'Event Log' },
          { key: 'dead-letter' as const, label: `Dead Letter Queue${dlqSummary.pending + dlqSummary.exhausted > 0 ? ` (${dlqSummary.pending + dlqSummary.exhausted})` : ''}` },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.key
                ? 'border-[#FF1493] text-discord-text-primary'
                : 'border-transparent text-discord-text-muted hover:text-discord-text-secondary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Event Log Tab */}
      {tab === 'events' && (
        <div className="space-y-3">
          <div className="flex gap-2">
            {['', 'success', 'error', 'pending', 'skipped'].map((r) => (
              <button
                key={r}
                onClick={() => setResultFilter(r)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  resultFilter === r
                    ? 'bg-[#FF1493]/20 text-[#FF1493]'
                    : 'bg-discord-bg-secondary text-discord-text-muted hover:text-discord-text-primary'
                }`}
              >
                {r || 'All'}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-discord-accent border-t-transparent" />
            </div>
          ) : events.length === 0 ? (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
              <div className="text-4xl mb-3">📋</div>
              <p className="text-discord-text-muted">No workflow events recorded yet.</p>
            </div>
          ) : (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-discord-border-subtle text-xs text-discord-text-muted">
                    <th className="px-4 py-2 text-left font-medium">Time</th>
                    <th className="px-4 py-2 text-left font-medium">Event</th>
                    <th className="px-4 py-2 text-left font-medium">Source</th>
                    <th className="px-4 py-2 text-left font-medium">Result</th>
                    <th className="px-4 py-2 text-right font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-discord-border-subtle">
                  {events.map((event) => (
                    <tr
                      key={event.id}
                      onClick={() => setExpandedId(expandedId === event.id ? null : event.id)}
                      className="cursor-pointer hover:bg-discord-bg-tertiary/30 transition-colors"
                    >
                      <td className="px-4 py-2 text-xs text-discord-text-muted whitespace-nowrap">{formatDate(event.created_at)}</td>
                      <td className="px-4 py-2 text-sm text-discord-text-primary font-mono">{event.event_type}</td>
                      <td className="px-4 py-2 text-xs text-discord-text-muted">{event.source}</td>
                      <td className="px-4 py-2">
                        {event.result && (
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RESULT_STYLES[event.result] || ''}`}>
                            {event.result}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-discord-text-muted text-right">
                        {event.duration_ms !== null ? `${event.duration_ms}ms` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Dead Letter Queue Tab */}
      {tab === 'dead-letter' && (
        <div className="space-y-4">
          {/* DLQ Summary */}
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {[
              { label: 'Pending', value: dlqSummary.pending, color: 'text-yellow-400' },
              { label: 'Retrying', value: dlqSummary.retrying, color: 'text-blue-400' },
              { label: 'Exhausted', value: dlqSummary.exhausted, color: 'text-red-400' },
              { label: 'Resolved', value: dlqSummary.resolved, color: 'text-discord-success' },
              { label: 'Discarded', value: dlqSummary.discarded, color: 'text-discord-text-muted' },
            ].map((s) => (
              <div key={s.label} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-2 text-center">
                <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                <p className="text-[10px] text-discord-text-muted">{s.label}</p>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            {['', 'pending', 'retrying', 'exhausted', 'resolved', 'discarded'].map((s) => (
              <button
                key={s}
                onClick={() => setDlqStatusFilter(s)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  dlqStatusFilter === s
                    ? 'bg-[#FF1493]/20 text-[#FF1493]'
                    : 'bg-discord-bg-secondary text-discord-text-muted hover:text-discord-text-primary'
                }`}
              >
                {s || 'All'}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-discord-accent border-t-transparent" />
            </div>
          ) : dlqItems.length === 0 ? (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
              <div className="text-4xl mb-3">✅</div>
              <p className="text-discord-text-muted">Dead letter queue is empty. All events processed successfully.</p>
            </div>
          ) : (
            dlqItems.map((item) => (
              <div key={item.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary">
                <button
                  onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                  className="w-full text-left px-4 py-3 hover:bg-discord-bg-tertiary/30 transition-colors rounded-lg"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${DLQ_STATUS_STYLES[item.status] || ''}`}>
                        {item.status}
                      </span>
                      <span className="text-sm font-mono text-discord-text-primary">{item.event_type}</span>
                      <span className="text-xs text-discord-text-muted">from {item.source}</span>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-discord-text-muted">
                        Retries: {item.retry_count}/{item.max_retries}
                      </p>
                      <p className="text-xs text-discord-text-muted">{formatDate(item.first_failed_at)}</p>
                    </div>
                  </div>
                  {item.error_message && (
                    <p className="mt-1 text-xs text-red-400 truncate">{item.error_message}</p>
                  )}
                </button>

                {expandedId === item.id && (
                  <div className="border-t border-discord-border-subtle px-4 py-3 space-y-3">
                    <div>
                      <h4 className="text-xs font-semibold uppercase text-discord-text-muted mb-1">Payload</h4>
                      <pre className="overflow-x-auto rounded-md bg-discord-bg-primary p-3 text-xs text-discord-text-secondary max-h-48 overflow-y-auto">
                        {JSON.stringify(item.payload, null, 2)}
                      </pre>
                    </div>

                    {item.error_stack && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase text-discord-text-muted mb-1">Error Stack</h4>
                        <pre className="overflow-x-auto rounded-md bg-discord-bg-primary p-3 text-xs text-red-400/80 max-h-32 overflow-y-auto">
                          {item.error_stack}
                        </pre>
                      </div>
                    )}

                    {item.resolution_note && (
                      <p className="text-xs text-discord-text-muted">
                        Resolution: <span className="text-discord-text-secondary">{item.resolution_note}</span>
                      </p>
                    )}

                    {(item.status === 'pending' || item.status === 'exhausted') && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleDLQAction(item.id, 'retry')}
                          className="rounded-md bg-blue-500/20 px-3 py-1.5 text-xs font-medium text-blue-400 hover:bg-blue-500/30 transition-colors"
                        >
                          Retry
                        </button>
                        <button
                          onClick={() => handleDLQAction(item.id, 'resolve', 'Manually resolved')}
                          className="rounded-md bg-discord-success/20 px-3 py-1.5 text-xs font-medium text-discord-success hover:bg-discord-success/30 transition-colors"
                        >
                          Resolve
                        </button>
                        <button
                          onClick={() => handleDLQAction(item.id, 'discard', 'Manually discarded')}
                          className="rounded-md bg-discord-bg-tertiary px-3 py-1.5 text-xs font-medium text-discord-text-muted hover:text-discord-text-primary transition-colors"
                        >
                          Discard
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
