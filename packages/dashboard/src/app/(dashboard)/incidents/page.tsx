/**
 * Incidents — Operational incident management with lifecycle tracking.
 * Phase D: SOTA incident response dashboard.
 */
'use client';

import { TableSkeleton } from '@/components/shared/loading-skeleton';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';

// ── Types ─────────────────────────────────────────────────

interface Incident {
  id: string;
  incident_number: number;
  title: string;
  description: string | null;
  severity: string;
  status: string;
  source: string;
  source_ref_id: string | null;
  assigned_to: string | null;
  started_at: string | null;
  identified_at: string | null;
  resolved_at: string | null;
  duration_seconds: number | null;
  impact_summary: string | null;
  root_cause: string | null;
  resolution: string | null;
  created_at: string;
}

interface IncidentEvent {
  id: string;
  event_type: string;
  actor_id: string | null;
  message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface Summary {
  total: number;
  open: number;
  investigating: number;
  identified: number;
  monitoring: number;
  resolved: number;
  critical: number;
  outage: number;
}

// ── Helpers ───────────────────────────────────────────────

const SEVERITY_STYLES: Record<string, string> = {
  outage: 'bg-red-600/20 text-red-400',
  critical: 'bg-red-500/20 text-red-400',
  warning: 'bg-yellow-500/20 text-yellow-400',
  info: 'bg-blue-500/20 text-blue-400',
};

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-red-500/20 text-red-400',
  investigating: 'bg-yellow-500/20 text-yellow-400',
  identified: 'bg-orange-500/20 text-orange-400',
  monitoring: 'bg-blue-500/20 text-blue-400',
  resolved: 'bg-discord-success/20 text-discord-success',
  closed: 'bg-discord-success/20 text-discord-success',
};

const STATUS_FLOW = ['open', 'investigating', 'identified', 'monitoring', 'resolved'];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

// ── Component ─────────────────────────────────────────────

export default function IncidentsPage() {
  const { toast } = useToast();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, open: 0, investigating: 0, identified: 0, monitoring: 0, resolved: 0, critical: 0, outage: 0 });
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<IncidentEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('active');
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newSeverity, setNewSeverity] = useState('warning');
  const [noteText, setNoteText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`/api/incidents?${params}`);
      const json = await res.json();
      if (json.success) {
        setIncidents(json.data);
        setSummary(json.summary);
      }
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const loadEvents = async (id: string) => {
    setSelectedId(id);
    setEventsLoading(true);
    try {
      const res = await fetch(`/api/incidents/${id}/events`);
      const json = await res.json();
      if (json.success) setEvents(json.data);
    } finally {
      setEventsLoading(false);
    }
  };

  const createIncident = async () => {
    if (!newTitle.trim()) return;
    const res = await fetch('/api/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle, description: newDescription, severity: newSeverity }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      toast({ title: 'Failed to create incident', description: json.error || 'Unknown error', variant: 'error' });
      return;
    }
    toast({ title: 'Incident created', variant: 'success' });
    setNewTitle('');
    setNewDescription('');
    setShowCreate(false);
    load();
  };

  const updateStatus = async (id: string, status: string) => {
    const res = await fetch('/api/incidents', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      toast({ title: 'Failed to update status', description: json.error || 'Unknown error', variant: 'error' });
      return;
    }
    load();
    loadEvents(id);
  };

  const addNote = async (id: string) => {
    if (!noteText.trim()) return;
    const res = await fetch(`/api/incidents/${id}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: noteText, event_type: 'note' }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      toast({ title: 'Failed to add note', description: json.error || 'Unknown error', variant: 'error' });
      return;
    }
    setNoteText('');
    loadEvents(id);
  };

  const selectedIncident = incidents.find(i => i.id === selectedId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Incidents</h1>
          <p className="mt-1 text-sm text-discord-text-muted">Track and manage operational incidents</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="rounded-md bg-[#FF1493] px-4 py-2 text-sm font-medium text-white hover:bg-[#FF1493]/80 transition-colors"
        >
          New Incident
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Active', value: summary.open + summary.investigating + summary.identified + summary.monitoring, color: summary.open > 0 ? 'text-red-400' : 'text-discord-text-primary' },
          { label: 'Critical/Outage', value: summary.critical + summary.outage, color: summary.critical + summary.outage > 0 ? 'text-red-400' : 'text-discord-success' },
          { label: 'Resolved', value: summary.resolved, color: 'text-discord-success' },
          { label: 'Total', value: summary.total, color: 'text-discord-text-primary' },
        ].map((s) => (
          <div key={s.label} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-3 text-center">
            <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-discord-text-muted">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Create Form */}
      {showCreate && (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 space-y-3">
          <h3 className="text-sm font-semibold text-discord-text-primary">Create Incident</h3>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Incident title…"
            className="w-full rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
          />
          <textarea
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="Description (optional)…"
            rows={2}
            className="w-full rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none resize-none"
          />
          <div className="flex items-center gap-3">
            <select
              value={newSeverity}
              onChange={(e) => setNewSeverity(e.target.value)}
              className="rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
              <option value="outage">Outage</option>
            </select>
            <button
              onClick={createIncident}
              className="rounded-md bg-[#FF1493] px-4 py-2 text-sm font-medium text-white hover:bg-[#FF1493]/80 transition-colors"
            >
              Create
            </button>
          </div>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex gap-1">
        {['active', 'resolved', ''].map((f) => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              statusFilter === f
                ? 'bg-[#FF1493]/20 text-[#FF1493]'
                : 'bg-discord-bg-secondary text-discord-text-muted hover:text-discord-text-primary'
            }`}
          >
            {f === 'active' ? 'Active' : f === 'resolved' ? 'Resolved' : 'All'}
          </button>
        ))}
      </div>

      <div className="flex min-w-0 flex-col gap-6 xl:flex-row">
        {/* Incident List */}
        <div className="min-w-0 flex-1 space-y-2">
          {loading ? (
            <TableSkeleton rows={6} />
          ) : incidents.length === 0 ? (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
              <div className="text-4xl mb-3">✅</div>
              <p className="text-discord-text-muted">No incidents. All systems operational.</p>
            </div>
          ) : (
            incidents.map((inc) => (
              <button
                key={inc.id}
                onClick={() => loadEvents(inc.id)}
                className={`w-full text-left rounded-card border p-4 transition-standard ${
                  selectedId === inc.id
                    ? 'border-[#FF1493] bg-discord-bg-secondary'
                    : 'border-discord-border-subtle bg-discord-bg-secondary hover:border-discord-border-subtle/80'
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-mono text-discord-text-muted">#{inc.incident_number}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[inc.severity] || ''}`}>
                    {inc.severity}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[inc.status] || ''}`}>
                    {inc.status}
                  </span>
                </div>
                <p className="mt-1 text-sm font-medium text-discord-text-primary">{inc.title}</p>
                <div className="mt-1 text-xs text-discord-text-muted">
                  Started {formatDate(inc.started_at ?? inc.created_at)}
                  {inc.duration_seconds !== null && ` • Duration: ${formatDuration(inc.duration_seconds)}`}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Detail Panel */}
        {selectedIncident && (
          <div className="max-h-[calc(100vh-200px)] w-full shrink-0 space-y-4 overflow-y-auto rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 xl:w-[420px]">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-discord-text-muted">#{selectedIncident.incident_number}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[selectedIncident.severity] || ''}`}>
                  {selectedIncident.severity}
                </span>
              </div>
              <h2 className="mt-1 text-lg font-bold text-discord-text-primary">{selectedIncident.title}</h2>
              {selectedIncident.description && (
                <p className="mt-1 text-sm text-discord-text-secondary">{selectedIncident.description}</p>
              )}
            </div>

            {/* Status Flow */}
            {!['resolved', 'closed'].includes(selectedIncident.status) && !(selectedIncident.source === 'health_alert' && selectedIncident.source_ref_id) && (
              <div className="flex gap-2 flex-wrap">
                {STATUS_FLOW.filter(s => {
                  const currentIdx = STATUS_FLOW.indexOf(selectedIncident.status);
                  const targetIdx = STATUS_FLOW.indexOf(s);
                  return targetIdx > currentIdx;
                }).map((s) => (
                  <button
                    key={s}
                    onClick={() => updateStatus(selectedIncident.id, s)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      s === 'resolved'
                        ? 'bg-discord-success/20 text-discord-success hover:bg-discord-success/30'
                        : 'bg-discord-bg-tertiary text-discord-text-secondary hover:text-discord-text-primary'
                    }`}
                  >
                    → {s}
                  </button>
                ))}
              </div>
            )}
            {!['resolved', 'closed'].includes(selectedIncident.status) && selectedIncident.source === 'health_alert' && selectedIncident.source_ref_id && (
              <p className="rounded-input border border-discord-border-subtle bg-discord-bg-tertiary p-3 text-xs text-discord-text-muted">
                Status follows the linked diagnostics alert and updates automatically when that alert clears.
              </p>
            )}

            {/* Post-mortem fields */}
            {selectedIncident.impact_summary && (
              <div>
                <h4 className="text-xs font-semibold uppercase text-discord-text-muted">Impact</h4>
                <p className="mt-1 text-sm text-discord-text-secondary">{selectedIncident.impact_summary}</p>
              </div>
            )}
            {selectedIncident.root_cause && (
              <div>
                <h4 className="text-xs font-semibold uppercase text-discord-text-muted">Root Cause</h4>
                <p className="mt-1 text-sm text-discord-text-secondary">{selectedIncident.root_cause}</p>
              </div>
            )}
            {selectedIncident.resolution && (
              <div>
                <h4 className="text-xs font-semibold uppercase text-discord-text-muted">Resolution</h4>
                <p className="mt-1 text-sm text-discord-text-secondary">{selectedIncident.resolution}</p>
              </div>
            )}

            {/* Timeline */}
            <div>
              <h3 className="text-sm font-semibold text-discord-text-secondary mb-3">Timeline</h3>
              {eventsLoading ? (
                <div className="text-center py-4 text-discord-text-muted text-sm">Loading…</div>
              ) : (
                <div className="space-y-3 border-l-2 border-discord-border-subtle pl-4">
                  {events.map((event) => (
                    <div key={event.id} className="relative">
                      <div className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-discord-border-subtle border-2 border-discord-bg-secondary" />
                      <div className="text-xs text-discord-text-muted">{formatDate(event.created_at)}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="rounded bg-discord-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-discord-text-muted">
                          {event.event_type}
                        </span>
                        {event.actor_id && (
                          <span className="text-[10px] font-mono text-discord-text-muted">{event.actor_id.slice(0, 12)}</span>
                        )}
                      </div>
                      {event.message && (
                        <p className="mt-0.5 text-sm text-discord-text-secondary">{event.message}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Add Note */}
              <div className="mt-4 flex gap-2">
                <input
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Add a note…"
                  className="flex-1 rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
                  onKeyDown={(e) => e.key === 'Enter' && addNote(selectedIncident.id)}
                />
                <button
                  onClick={() => addNote(selectedIncident.id)}
                  className="rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-secondary hover:text-discord-text-primary transition-colors"
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
