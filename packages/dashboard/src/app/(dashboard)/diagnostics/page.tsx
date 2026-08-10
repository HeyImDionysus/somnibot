/**
 * Diagnostics — System health dashboard with bot status, infrastructure health,
 * and webhook event log with replay support.
 *
 * Architecture doc §33.4.
 */
'use client';

import { DashboardSkeleton } from '@/components/shared/loading-skeleton';

import { useEffect, useState, useCallback } from 'react';
import { DIAGNOSTICS_GUIDANCE, type GuidedMetric } from '@/lib/diagnostics-guidance';

// ── Types ─────────────────────────────────────────────────

interface Alert {
  id: string;
  alert_type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  acknowledged: boolean;
  resolved: boolean;
  created_at: string;
}

interface DiagnosticsData {
  /** When true, each metric is shown with a plain-English explanation. */
  guidedMode?: boolean;
  /** The owner's configured alert thresholds (what the bot actually alerts on). */
  thresholds?: {
    memoryRssMb: number;
    wsPingMs: number;
    webhookErrorRate: number;
  };
  snapshotIntervalMs?: number;
  bot: {
    online: boolean;
    uptimeSeconds: number;
    memoryRssMb: number;
    memoryHeapMb: number;
    wsPing: number;
    guildMemberCount: number;
    activeVoiceConnections: number;
    snapshotAt: string | null;
    staleSecs: number | null;
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
  dlq: { pendingCount: number };
  healthMetrics: Record<string, Array<{ value: number; time: string }>>;
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

/**
 * Plain-English explanation of one metric, shown under its raw value when the
 * owner has guided mode on. Renders nothing when guided mode is off, so the
 * page stays terse for readers who don't need it.
 */
function Guidance({ metric, on }: { metric: GuidedMetric; on: boolean }) {
  if (!on) return null;
  const g = DIAGNOSTICS_GUIDANCE[metric];
  if (!g) return null;
  return (
    <div className="mt-2 rounded-md border border-discord-border-subtle/60 bg-discord-bg-secondary/40 p-2">
      <p className="text-xs text-discord-text-secondary">{g.plainLanguage}</p>
      <p className="mt-1 text-xs text-discord-text-muted">
        <span className="font-medium text-discord-text-secondary">Normal:</span> {g.healthyRange}
      </p>
      <p className="mt-1 text-xs text-discord-text-muted">
        <span className="font-medium text-discord-text-secondary">If it isn&apos;t:</span> {g.nextStep}
      </p>
    </div>
  );
}

function alertGuidanceMetric(alertType: string): GuidedMetric | null {
  switch (alertType) {
    case 'memory_high': return 'memory';
    case 'ws_ping_high': return 'wsPing';
    case 'valkey_disconnected': return 'valkey';
    case 'lavalink_down': return 'lavalink';
    default: return null;
  }
}

function StatusDot({ ok, muted = false }: { ok: boolean; muted?: boolean }) {
  // `muted` is for subsystems that are switched off on purpose. Red would read
  // as "this is broken, go fix it" when nothing is wrong at all.
  const color = muted ? 'bg-discord-text-muted' : ok ? 'bg-green-500' : 'bg-red-500';
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

/**
 * Sparkline — a tiny inline SVG chart for latency trends.
 */
function Sparkline({
  data,
  color = '#5865f2',
  width = 200,
  height = 40,
}: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) {
    return <span className="text-xs text-discord-text-muted">Collecting data…</span>;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const padding = 2;
  const usableH = height - padding * 2;
  const step = (width - padding * 2) / (data.length - 1);

  const points = data.map((v, i) => {
    const x = padding + i * step;
    const y = padding + usableH - ((v - min) / range) * usableH;
    return `${x},${y}`;
  });

  const avg = Math.round(data.reduce((a, b) => a + b, 0) / data.length * 100) / 100;
  const latest = data[data.length - 1];

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(4rem,6rem)] items-center gap-3">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="h-10 w-full min-w-0"
      >
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="min-w-0 max-w-24 break-words text-right text-xs leading-4 text-discord-text-muted">
        <span className="text-discord-text-secondary font-medium">{latest?.toFixed(1)}ms</span>
        {' '}(avg {avg}ms)
      </div>
    </div>
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
  const [webhookActionError, setWebhookActionError] = useState<string | null>(null);

  // Alerting-threshold save state
  const [savingThresholds, setSavingThresholds] = useState(false);
  const [thresholdError, setThresholdError] = useState<string | null>(null);

  // Alert state
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(true);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch('/api/alerts?status=active');
      const json = await res.json();
      if (json.success) {
        setAlerts(json.data.alerts ?? []);
      }
    } catch (err) {
      console.error('Failed to fetch alerts:', err);
    } finally {
      setAlertsLoading(false);
    }
  }, []);

  /**
   * Persist one alerting setting. Saves on blur rather than on every keystroke
   * so a half-typed number ("5" on the way to "512") is never written, and
   * re-reads afterwards so the field shows what was actually stored.
   */
  const saveThresholds = async (patch: Record<string, number | boolean>) => {
    setSavingThresholds(true);
    setThresholdError(null);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setThresholdError(
          (body as { error?: string }).error
          ?? 'Could not save that value. Check it is inside the allowed range.',
        );
        // Re-read after a rejected save so the field is remounted with the
        // last persisted value rather than displaying a value the bot ignores.
        await fetchDiagnostics();
        return;
      }
      await fetchDiagnostics();
    } catch {
      setThresholdError('Could not reach the server to save that setting.');
    } finally {
      setSavingThresholds(false);
    }
  };

  const handleAcknowledgeAlert = async (alertId: string) => {
    try {
      await fetch('/api/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: alertId, action: 'acknowledge' }),
      });
      await fetchAlerts();
    } catch (err) {
      console.error('Failed to acknowledge alert:', err);
    }
  };

  const handleResolveAlert = async (alertId: string) => {
    try {
      await fetch('/api/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: alertId, action: 'resolve' }),
      });
      await fetchAlerts();
    } catch (err) {
      console.error('Failed to resolve alert:', err);
    }
  };

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
    fetchAlerts();
    // Refresh every 30s
    const timer = setInterval(() => {
      fetchDiagnostics();
      fetchAlerts();
    }, 30_000);
    return () => clearInterval(timer);
  }, [fetchDiagnostics, fetchAlerts]);

  useEffect(() => {
    fetchWebhooks(1);
  }, [fetchWebhooks]);

  const handleReplay = async (eventId: string) => {
    setReplayingId(eventId);
    setWebhookActionError(null);
    try {
      const res = await fetch(`/api/webhooks/${eventId}/replay`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        // Refresh webhook list
        await fetchWebhooks(whPagination.page);
      } else {
        setWebhookActionError(json.error ?? 'Replay failed.');
      }
    } catch (err) {
      console.error('Replay failed:', err);
      setWebhookActionError('Could not reach the server to replay that webhook.');
    } finally {
      setReplayingId(null);
    }
  };

  const handleRecoverStaleReplay = async (eventId: string) => {
    const confirmed = window.confirm(
      'Only recover this claim after confirming the original replay worker has stopped. '
      + 'Recovering it allows a new payment replay. Continue?',
    );
    if (!confirmed) return;

    setReplayingId(eventId);
    setWebhookActionError(null);
    try {
      const res = await fetch(`/api/webhooks/${eventId}/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'abandon_stale_claim' }),
      });
      const json = await res.json();
      if (json.success) {
        await fetchWebhooks(whPagination.page);
      } else {
        setWebhookActionError(json.error ?? 'Could not recover that stale replay claim.');
      }
    } catch (err) {
      console.error('Stale replay recovery failed:', err);
      setWebhookActionError('Could not reach the server to recover that replay claim.');
    } finally {
      setReplayingId(null);
    }
  };

  const isRecoverableStaleReplay = (event: WebhookEvent) => {
    const processedAt = Date.parse(event.processed_at);
    return event.result === null
      && event.replay_count > 0
      && Number.isFinite(processedAt)
      && Date.now() - processedAt >= 15 * 60 * 1000;
  };

  const resultColors: Record<string, string> = {
    success: 'bg-green-500/20 text-green-400',
    error: 'bg-red-500/20 text-red-400',
    duplicate: 'bg-yellow-500/20 text-yellow-400',
  };

  if (loading) {
    return <DashboardSkeleton />;
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

      {/* Active Alerts Banner */}
      {!alertsLoading && alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert) => {
            const severityStyles = {
              critical: 'border-red-500/50 bg-red-500/10',
              warning: 'border-yellow-500/50 bg-yellow-500/10',
              info: 'border-blue-500/50 bg-blue-500/10',
            };
            const severityTextStyles = {
              critical: 'text-red-400',
              warning: 'text-yellow-400',
              info: 'text-blue-400',
            };
            const severityBadge = {
              critical: 'bg-red-500/20 text-red-400',
              warning: 'bg-yellow-500/20 text-yellow-400',
              info: 'bg-blue-500/20 text-blue-400',
            };
            return (
              <div
                key={alert.id}
                className={`flex items-start justify-between gap-4 rounded-lg border p-4 ${severityStyles[alert.severity]}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${severityBadge[alert.severity]}`}>
                      {alert.severity.toUpperCase()}
                    </span>
                    <h4 className={`text-sm font-semibold ${severityTextStyles[alert.severity]}`}>
                      {alert.title}
                    </h4>
                  </div>
                  <p className="text-sm text-discord-text-muted">{alert.message}</p>
                  {alertGuidanceMetric(alert.alert_type) && (
                    <Guidance
                      metric={alertGuidanceMetric(alert.alert_type)!}
                      on={diag?.guidedMode !== false}
                    />
                  )}
                  <p className="text-xs text-discord-text-muted mt-1">
                    Since {formatDate(alert.created_at)}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  {!alert.acknowledged && (
                    <button
                      onClick={() => handleAcknowledgeAlert(alert.id)}
                      className="rounded-md bg-discord-bg-secondary px-2 py-1 text-xs text-discord-text-secondary hover:bg-discord-bg-tertiary transition-colors"
                    >
                      Acknowledge
                    </button>
                  )}
                  <button
                    onClick={() => handleResolveAlert(alert.id)}
                    className="rounded-md bg-discord-bg-secondary px-2 py-1 text-xs text-discord-text-secondary hover:bg-discord-bg-tertiary transition-colors"
                  >
                    Resolve
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

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
          <Guidance metric="uptime" on={diag?.guidedMode !== false} />
          <Guidance metric="wsPing" on={diag?.guidedMode !== false} />
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
          <Guidance metric="memory" on={diag?.guidedMode !== false} />
          <Guidance metric="snapshotStaleness" on={diag?.guidedMode !== false} />
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
          <Guidance metric="supabase" on={diag?.guidedMode !== false} />
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
          <Guidance metric="valkey" on={diag?.guidedMode !== false} />
        </div>

        {/* Lavalink */}
        <div className="rounded-lg bg-discord-bg-secondary p-4">
          <div className="flex items-center gap-2 mb-3">
            {/* A node stays registered while it reconnects, so "no nodes at all"
                means music was never configured — not that it went down. */}
            <StatusDot
              ok={(diag?.lavalink.nodes ?? []).some((n) => n.connected)}
              muted={(diag?.lavalink.nodes ?? []).length === 0}
            />
            <h3 className="text-sm font-semibold text-discord-text-primary">Lavalink</h3>
          </div>
          <div className="space-y-1.5 text-sm">
            {(diag?.lavalink.nodes ?? []).length === 0 ? (
              <p className="text-discord-text-muted">
                Music not configured — set a Lavalink password to enable it.
              </p>
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
          <Guidance metric="lavalink" on={diag?.guidedMode !== false} />
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

      {/* Alerting thresholds — the numbers the bot actually alerts on. */}
      <div className="rounded-lg bg-discord-bg-secondary p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold text-discord-text-primary">Alerting</h2>
            <p className="mt-1 text-sm text-discord-text-muted">
              When to warn you. Defaults suit a typical server — raise them if you get
              alerts you don&apos;t care about, lower them to hear about problems sooner.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-discord-text-secondary">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={diag?.guidedMode !== false}
                onChange={(e) => void saveThresholds({ diagnostics_guided_mode: e.target.checked })}
                disabled={savingThresholds}
              />
              Explain these numbers
            </label>
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block text-sm">
            <span className="text-discord-text-muted">Memory warning above (MB)</span>
            <input
              key={`memory-threshold-${diag?.thresholds?.memoryRssMb ?? 512}`}
              type="number" min={128} max={8192}
              defaultValue={diag?.thresholds?.memoryRssMb ?? 512}
              onBlur={(e) => void saveThresholds({ memory_alert_threshold_mb: Number(e.target.value) })}
              disabled={savingThresholds}
              className="mt-1 w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-2 py-1 text-discord-text-primary"
            />
          </label>
          <label className="block text-sm">
            <span className="text-discord-text-muted">Health snapshot interval (ms)</span>
            <input
              key={`snapshot-interval-${diag?.snapshotIntervalMs ?? 60_000}`}
              type="number" min={15_000} max={600_000} step={1_000}
              defaultValue={diag?.snapshotIntervalMs ?? 60_000}
              onBlur={(e) => void saveThresholds({ diagnostics_snapshot_interval_ms: Number(e.target.value) })}
              disabled={savingThresholds}
              className="mt-1 w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-2 py-1 text-discord-text-primary"
            />
            <span className="mt-1 block text-xs text-discord-text-muted">15,000–600,000 ms</span>
          </label>
          <label className="block text-sm">
            <span className="text-discord-text-muted">Gateway ping warning above (ms)</span>
            <input
              key={`ping-threshold-${diag?.thresholds?.wsPingMs ?? 500}`}
              type="number" min={50} max={10000}
              defaultValue={diag?.thresholds?.wsPingMs ?? 500}
              onBlur={(e) => void saveThresholds({ ws_ping_alert_threshold_ms: Number(e.target.value) })}
              disabled={savingThresholds}
              className="mt-1 w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-2 py-1 text-discord-text-primary"
            />
          </label>
          <label className="block text-sm">
            <span className="text-discord-text-muted">Webhook failure rate above (0–1)</span>
            <input
              key={`webhook-threshold-${diag?.thresholds?.webhookErrorRate ?? 0.25}`}
              type="number" min={0} max={1} step={0.01}
              defaultValue={diag?.thresholds?.webhookErrorRate ?? 0.25}
              onBlur={(e) => void saveThresholds({ webhook_error_rate_threshold: Number(e.target.value) })}
              disabled={savingThresholds}
              className="mt-1 w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-2 py-1 text-discord-text-primary"
            />
          </label>
        </div>

        {thresholdError && (
          <p className="mt-3 text-sm text-red-400">{thresholdError}</p>
        )}
      </div>

      {/* V53 Phase 2: Latency sparklines */}
      {diag?.healthMetrics && Object.keys(diag.healthMetrics).length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-discord-text-primary mb-4">Latency Trends (24h)</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {diag.healthMetrics.db_latency && (
              <div className="rounded-lg bg-discord-bg-secondary p-4">
                <h3 className="text-xs font-semibold uppercase text-discord-text-muted mb-2">
                  Database Round-trip
                </h3>
                <Sparkline
                  data={diag.healthMetrics.db_latency.map((m) => m.value)}
                  color="#43b581"
                />
              </div>
            )}
            {diag.healthMetrics.valkey_latency && (
              <div className="rounded-lg bg-discord-bg-secondary p-4">
                <h3 className="text-xs font-semibold uppercase text-discord-text-muted mb-2">
                  Valkey Ping
                </h3>
                <Sparkline
                  data={diag.healthMetrics.valkey_latency.map((m) => m.value)}
                  color="#faa61a"
                />
              </div>
            )}
            {diag.healthMetrics.ws_ping && (
              <div className="rounded-lg bg-discord-bg-secondary p-4">
                <h3 className="text-xs font-semibold uppercase text-discord-text-muted mb-2">
                  Discord WebSocket
                </h3>
                <Sparkline
                  data={diag.healthMetrics.ws_ping.map((m) => m.value)}
                  color="#5865f2"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="grid gap-4 sm:grid-cols-4">
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
        <div className="rounded-lg bg-discord-bg-secondary p-4 text-center">
          <p className={`text-2xl font-bold ${(diag?.dlq?.pendingCount ?? 0) > 0 ? 'text-red-400' : 'text-discord-text-primary'}`}>
            {diag?.dlq?.pendingCount ?? 0}
          </p>
          <p className="text-sm text-discord-text-muted">DLQ Pending</p>
          <Guidance metric="deadLetter" on={diag?.guidedMode !== false} />
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
          {webhookActionError && (
            <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
              {webhookActionError}
            </div>
          )}
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
                      {isRecoverableStaleReplay(wh) && (
                        <button
                          onClick={() => handleRecoverStaleReplay(wh.event_id)}
                          disabled={replayingId === wh.event_id}
                          className="rounded-md bg-amber-500/20 px-2 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/30 disabled:opacity-50 transition-colors"
                          title="Use only after confirming the original replay worker stopped"
                        >
                          {replayingId === wh.event_id ? 'Recovering…' : 'Recover stale claim'}
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
