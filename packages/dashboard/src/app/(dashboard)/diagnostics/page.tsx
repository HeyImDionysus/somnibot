/**
 * Diagnostics — System health dashboard with bot status, infrastructure health,
 * and webhook event log with replay support.
 *
 * Architecture doc §33.4.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────

interface DiagnosticsData {
  bot: {
    online: boolean;
    uptimeSeconds: number;
    memoryRssMb: number;
    memoryHeapMb: number;
    wsPing: number;
    guildMemberCount: number;
    activeVoiceConnections: number;
    snapshotAt: string | null;
  };
  lavalink: {
    nodes: Array<{ name: string; connected: boolean; players: number }>;
  };
  valkey: {
    connected: boolean;
    memoryMb: number;
  };
  supabase: {
    healthy: boolean;
  };
  webhooks: {
    total: number;
    success: number;
    error: number;
    duplicate: number;
    pending: number;
  };
  sync: {
    lastSync: string | null;
    lastSyncDetails: Record<string, unknown> | null;
    lastDrift: string | null;
    lastDriftDetails: Record<string, unknown> | null;
  };
  automations: { activeCount: number };
  scheduledMessages: { activeCount: number };
}

interface WebhookEvent {
  event_id: string;
  event_type: string;
  processed_at: string;
  payload: Record<string, unknown>;
  result: 'success' | 'error' | 'duplicate' | null;
  error_details: string | null;
  replayed_at: string | null;
  replay_count: number;
}

interface WebhookPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// ── Helpers ───────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(ts: string | null): string {
  if (!ts) return 'Never';
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-green-500' : 'bg-red-500'}`} />
  );
}

// ── Component ─────────────────────────────────────────────

export default function DiagnosticsPage() {
  const [diag, setDiag] = useState<DiagnosticsData | null>(null);
  const [loading, setLoading] = useState(true);

  // Webhook log state
  const [webhooks, setWebhooks] = useState<WebhookEvent[]>([]);
  const [whPagination, setWhPagination] = useState<WebhookPagination>({
    page: 1, pageSize: 25, total: 0, totalPages: 0,
  });
  const [whFilter, setWhFilter] = useState('');
  const [whLoading, setWhLoading] = useState(true);
  const [replayingId, setReplayingId] = useState<string | null>(null);

  const fetchDiagnostics = useCallback(async () => {
    try {
      const res = await fetch('/api/diagnostics');
      const json = await res.json();
      if (json.success) {
        setDiag(json.data);
      }
    } catch (err) {
      console.error('Failed to fetch diagnostics:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchWebhooks = useCallback(async (page = 1) => {
    setWhLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (whFilter) params.set('result', whFilter);
      const res = await fetch(`/api/webhooks?${params}`);
      const json = await res.json();
      if (json.success) {
        setWebhooks(json.data);
        setWhPagination(json.pagination);
      }
    } catch (err) {
      console.error('Failed to fetch webhooks:', err);
    } finally {
      setWhLoading(false);
    }
  }, [whFilter]);

  useEffect(() => {
    fetchDiagnostics();
    // Refresh every 30s
    const timer = setInterval(fetchDiagnostics, 30_000);
    return () => clearInterval(timer);
  }, [fetchDiagnostics]);

  useEffect(() => {
    fetchWebhooks(1);
  }, [fetchWebhooks]);

  const handleReplay = async (eventId: string) => {
    setReplayingId(eventId);
    try {
      const res = await fetch(`/api/webhooks/${eventId}/replay`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        // Refresh webhook list
        await fetchWebhooks(whPagination.page);
      }
    } catch (err) {
      console.error('Replay failed:', err);
    } finally {
      setReplayingId(null);
    }
  };

  const resultColors: Record<string, string> = {
    success: 'bg-green-500/20 text-green-400',
    error: 'bg-red-500/20 text-red-400',
    duplicate: 'bg-yellow-500/20 text-yellow-400',
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-discord-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Diagnostics</h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          System health, infrastructure status, and webhook monitoring
        </p>
      </div>

      {/* Health cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Bot Status */}
        <div className="rounded-lg bg-discord-bg-secondary p-4">
          <div className="flex items-center gap-2 mb-3">
            <StatusDot ok={diag?.bot.online ?? false} />
            <h3 className="text-sm font-semibold text-discord-text-primary">Bot Status</h3>
          </div>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-discord-text-muted">Status</span>
              <span className={diag?.bot.online ? 'text-green-400' : 'text-red-400'}>
                {diag?.bot.online ? 'Online' : 'Offline'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-discord-text-muted">Uptime</span>
              <span className="text-discord-text-secondary">
                {formatUptime(diag?.bot.uptimeSeconds ?? 0)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-discord-text-muted">WS Ping</span>
              <span className="text-discord-text-secondary">{diag?.bot.wsPing ?? '-'}ms</span>
            </div>
            <div className="flex justify-between">
              <span className="text-discord-text-muted">Members</span>
              <span className="text-discord-text-secondary">{diag?.bot.guildMemberCount ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-discord-text-muted">Voice Connections</span>
              <span className="text-discord-text-secondary">{diag?.bot.activeVoiceConnections ?? 0}</span>
            </div>
          </div>
        </div>

        {/* Memory */}
        <div className="rounded-lg bg-discord-bg-secondary p-4">
          <div className="flex items-center gap-2 mb-3">
            <StatusDot ok={true} />
            <h3 className="text-sm font-semibold text-discord-text-primary">Memory</h3>
          </div>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-discord-text-muted">RSS</span>
              <span className="text-discord-text-secondary">{diag?.bot.memoryRssMb ?? 0} MB</span>
            </div>
            <div className="flex justify-between">
              <span className="text-discord-text-muted">Heap Used</span>
              <span className="text-discord-text-secondary">{diag?.bot.memoryHeapMb ?? 0} MB</span>
            </div>
            <div className="flex justify-between">
              <span className="text-discord-text-muted">Last Update</span>
              <span className="text-discord-text-secondary">{formatDate(diag?.bot.snapshotAt ?? null)}</span>
            </div>
          </div>
        </div>

        {/* Supabase */}
        <div className="rounded-lg bg-discord-bg-secondary p-4">
          <div className="flex items-center gap-2 mb-3">
            <StatusDot ok={diag?.supabase.healthy ?? false} />
            <h3 className="text-sm font-semibold text-discord-text-primary">Supabase</h3>
          </div>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-discord-text-muted">Status</span>
              <span className={diag?.supabase.healthy ? 'text-green-400' : 'text-red-400'}>
                {diag?.supabase.healthy ? 'Healthy' : 'Unhealthy'}
              </span>
            </div>
          </div>
        </div>

        {/* Valkey */}
        <div className="rounded-lg bg-discord-bg-secondary p-4">
          <div className="flex items-center gap-2 mb-3">
            <StatusDot ok={diag?.valkey.connected ?? false} />
            <h3 className="text-sm font-semibold text-discord-text-primary">Valkey (Redis)</h3>
          </div>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-discord-text-muted">Status</span>
              <span className={diag?.valkey.connected ? 'text-green-400' : 'text-red-400'}>
                {diag?.valkey.connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-discord-text-muted">Memory</span>
              <span className="text-discord-text-secondary">{diag?.valkey.memoryMb ?? 0} MB</span>
            </div>
          </div>
        </div>

        {/* Lavalink */}
        <div className="rounded-lg bg-discord-bg-secondary p-4">
          <div className="flex items-center gap-2 mb-3">
            <StatusDot ok={(diag?.lavalink.nodes ?? []).some((n) => n.connected)} />
            <h3 className="text-sm font-semibold text-discord-text-primary">Lavalink</h3>
          </div>
          <div className="space-y-1.5 text-sm">
            {(diag?.lavalink.nodes ?? []).length === 0 ? (
              <p className="text-discord-text-muted">No nodes configured</p>
            ) : (
              diag?.lavalink.nodes.map((node) => (
                <div key={node.name} className="flex justify-between">
                  <span className="text-discord-text-muted">{node.name}</span>
                  <span className="flex items-center gap-2">
                    <span className={node.connected ? 'text-green-400' : 'text-red-400'}>
                      {node.connected ? 'Connected' : 'Disconnected'}
                    </span>
                    <span className="text-discord-text-muted">({node.players} players)</span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Sync */}
        <div className="rounded-lg bg-discord-bg-secondary p-4">
          <div className="flex items-center gap-2 mb-3">
            <StatusDot ok={true} />
            <h3 className="text-sm font-semibold text-discord-text-primary">Sync & Deploy</h3>
          </div>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-discord-text-muted">Last Sync</span>
              <span className="text-discord-text-secondary">{formatDate(diag?.sync.lastSync ?? null)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-discord-text-muted">Last Drift</span>
              <span className="text-discord-text-secondary">{formatDate(diag?.sync.lastDrift ?? null)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg bg-discord-bg-secondary p-4 text-center">
          <p className="text-2xl font-bold text-discord-text-primary">{diag?.automations.activeCount ?? 0}</p>
          <p className="text-sm text-discord-text-muted">Active Automations</p>
        </div>
        <div className="rounded-lg bg-discord-bg-secondary p-4 text-center">
          <p className="text-2xl font-bold text-discord-text-primary">{diag?.scheduledMessages.activeCount ?? 0}</p>
          <p className="text-sm text-discord-text-muted">Scheduled Messages</p>
        </div>
        <div className="rounded-lg bg-discord-bg-secondary p-4 text-center">
          <p className="text-2xl font-bold text-discord-text-primary">{diag?.webhooks.total ?? 0}</p>
          <p className="text-sm text-discord-text-muted">Recent Webhooks</p>
        </div>
      </div>

      {/* Webhook Log */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-discord-text-primary">Webhook Events</h2>
          <select
            value={whFilter}
            onChange={(e) => setWhFilter(e.target.value)}
            className="rounded-md bg-discord-bg-secondary px-3 py-1.5 text-sm text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-accent"
          >
            <option value="">All Results</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
            <option value="duplicate">Duplicate</option>
          </select>
        </div>

        <div className="rounded-lg bg-discord-bg-secondary overflow-hidden">
          {whLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-discord-accent border-t-transparent" />
            </div>
          ) : webhooks.length === 0 ? (
            <div className="py-8 text-center text-discord-text-muted">No webhook events</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-discord-border-subtle">
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-discord-text-muted">Type</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-discord-text-muted">Result</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-discord-text-muted">Processed</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-discord-text-muted">Error</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold uppercase text-discord-text-muted">Actions</th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map((wh) => (
                  <tr key={wh.event_id} className="border-b border-discord-border-subtle last:border-0 hover:bg-discord-bg-tertiary/30">
                    <td className="px-4 py-2 text-discord-text-primary font-mono text-xs">
                      {wh.event_type}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${resultColors[wh.result ?? ''] ?? 'bg-gray-500/20 text-gray-400'}`}>
                        {wh.result ?? 'pending'}
                      </span>
                      {wh.replay_count > 0 && (
                        <span className="ml-1 text-xs text-discord-text-muted">
                          (replayed ×{wh.replay_count})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-discord-text-muted">
                      {formatDate(wh.processed_at)}
                    </td>
                    <td className="px-4 py-2 text-xs text-red-400 max-w-[200px] truncate">
                      {wh.error_details ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {wh.result === 'error' && (
                        <button
                          onClick={() => handleReplay(wh.event_id)}
                          disabled={replayingId === wh.event_id}
                          className="rounded-md bg-discord-accent/20 px-2 py-1 text-xs font-medium text-discord-accent hover:bg-discord-accent/30 disabled:opacity-50 transition-colors"
                        >
                          {replayingId === wh.event_id ? 'Replaying…' : 'Replay'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Webhook pagination */}
        {whPagination.totalPages > 1 && (
          <div className="flex items-center justify-between mt-3">
            <p className="text-xs text-discord-text-muted">
              Page {whPagination.page} of {whPagination.totalPages}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => fetchWebhooks(whPagination.page - 1)}
                disabled={whPagination.page <= 1}
                className="rounded-md bg-discord-bg-secondary px-3 py-1 text-xs text-discord-text-secondary hover:bg-discord-bg-tertiary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              <button
                onClick={() => fetchWebhooks(whPagination.page + 1)}
                disabled={whPagination.page >= whPagination.totalPages}
                className="rounded-md bg-discord-bg-secondary px-3 py-1 text-xs text-discord-text-secondary hover:bg-discord-bg-tertiary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
