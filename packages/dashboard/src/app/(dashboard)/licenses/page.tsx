/**
 * Licenses — License key management dashboard page.
 *
 * Architecture doc §30 — Identity-bound licensing.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useToast } from '@/components/shared/toast';

// ── Types ─────────────────────────────────────────────────

interface LicenseKey {
  id: string;
  order_id: string;
  customer_id: string;
  product_id: string;
  guild_id: string;
  key_prefix: string;
  key_suffix: string;
  bound_discord_id: string;
  status: 'pending_activation' | 'active' | 'expired' | 'revoked' | 'suspended';
  activated_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
  updated_at: string;
  products?: { name: string } | null;
  customers?: { discord_username: string; discord_id: string; email: string | null } | null;
  sessions?: Session[];
}

interface Session {
  id: string;
  device_fingerprint: string;
  device_name: string | null;
  app_version: string | null;
  ip_address: string | null;
  active: boolean;
  first_seen_at: string;
  last_seen_at: string;
  deactivated_at: string | null;
  deactivation_reason: string | null;
}

interface LicenseHealth {
  state: 'empty' | 'healthy' | 'needs_attention';
  keyCounts: Record<'pending_activation' | 'active' | 'expired' | 'revoked' | 'suspended', number>;
  sampledKeys: number;
  totalKeys: number;
  activeSessions: number;
  totalSessions: number;
  validationWindowHours: number;
  validationCount: number;
  unavailable24h: number;
  sessionsOnTerminalKeys: number;
  deviceLimit24h: number;
  invalid24h: number;
  pendingOlderThanDay: number;
  unresolvedAlerts: Array<{
    id: string;
    severity: string;
    title: string;
    created_at: string;
  }>;
  truncated: boolean;
}

// ── Helpers ───────────────────────────────────────────────

function statusBadge(status: string) {
  switch (status) {
    case 'active':
      return { label: 'Active', color: 'bg-discord-success/20 text-discord-success' };
    case 'pending_activation':
      return { label: 'Pending', color: 'bg-yellow-500/20 text-yellow-400' };
    case 'expired':
      return { label: 'Expired', color: 'bg-discord-text-muted/20 text-discord-text-muted' };
    case 'revoked':
      return { label: 'Revoked', color: 'bg-discord-danger/20 text-discord-danger' };
    case 'suspended':
      return { label: 'Suspended', color: 'bg-orange-500/20 text-orange-400' };
    default:
      return { label: status, color: 'bg-discord-bg-tertiary text-discord-text-muted' };
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Component ─────────────────────────────────────────────

export default function LicensesPage() {
  const { toast } = useToast();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revokeTargetId, setRevokeTargetId] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState<LicenseKey | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResult, setSearchResult] = useState<LicenseKey | null>(null);
  const [searchError, setSearchError] = useState('');

  // Session management
  const [sessions, setSessions] = useState<{ sessions: Session[]; max_devices: number; active_count: number } | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [health, setHealth] = useState<LicenseHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState(false);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(false);
    try {
      const response = await fetch('/api/license/health');
      const payload = await response.json();
      if (!response.ok || payload.success !== true) throw new Error('health unavailable');
      setHealth(payload.data);
    } catch {
      setHealth(null);
      setHealthError(true);
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => { void loadHealth(); }, [loadHealth]);

  const lookupKey = useCallback(async () => {
    if (!search.trim()) return;
    setSearchLoading(true);
    setSearchError('');
    setSearchResult(null);
    try {
      const res = await fetch(`/api/license-keys/${encodeURIComponent(search.trim())}`);
      const json = await res.json();
      if (json.success) {
        setSearchResult(json.data);
        setSelectedKey(json.data);
        // Load sessions
        loadSessions(json.data.id);
      } else {
        setSearchError(json.error || 'Key not found');
      }
    } catch {
      setSearchError('Failed to look up key');
    } finally {
      setSearchLoading(false);
    }
  }, [search]);

  const loadSessions = async (keyId: string) => {
    setSessionsLoading(true);
    try {
      const res = await fetch(`/api/license/sessions?key_id=${keyId}`);
      const json = await res.json();
      if (json.success) setSessions(json.data);
    } finally {
      setSessionsLoading(false);
    }
  };

  const revokeKey = async (keyId: string) => {
    await fetch(`/api/license-keys/${keyId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'revoked', revocation_reason: 'Admin revocation' }),
    });
    lookupKey(); // Refresh
  };

  const suspendKey = async (keyId: string) => {
    await fetch(`/api/license-keys/${keyId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    });
    lookupKey();
  };

  const reactivateKey = async (keyId: string) => {
    await fetch(`/api/license-keys/${keyId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    lookupKey();
  };

  const revokeSession = async (sessionId: string) => {
    await fetch(`/api/license/sessions/${sessionId}`, { method: 'DELETE' });
    if (selectedKey) loadSessions(selectedKey.id);
  };

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">License Keys</h1>
        <p className="text-sm text-discord-text-muted">
          Look up, manage, and revoke license keys
        </p>
      </div>

      <section
        aria-labelledby="license-health-heading"
        className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="license-health-heading" className="text-base font-semibold text-discord-text-primary">
              License health
            </h2>
            <p className="text-xs text-discord-text-muted">
              Real key, device, validation, and unresolved-alert records for this server.
            </p>
          </div>
          {!healthLoading && (
            <button
              type="button"
              onClick={() => void loadHealth()}
              className="rounded-input border border-discord-border-subtle px-3 py-1.5 text-xs text-discord-text-secondary hover:border-discord-border-strong"
            >
              Refresh
            </button>
          )}
        </div>

        {healthLoading ? (
          <p className="mt-4 text-sm text-discord-text-muted" role="status">Checking license health…</p>
        ) : healthError ? (
          <div className="mt-4 rounded-input border border-discord-danger/40 bg-discord-danger/10 p-3">
            <p className="text-sm font-medium text-discord-danger">License health is unavailable</p>
            <p className="mt-1 text-xs text-discord-text-muted">
              SomniBot could not verify every required license record. This is not reported as healthy.
            </p>
          </div>
        ) : health?.state === 'empty' ? (
          <p className="mt-4 text-sm text-discord-text-muted">
            No license keys have been issued for this server yet.
          </p>
        ) : health ? (
          <div className="mt-4 space-y-4">
            <div className={`rounded-input border p-3 ${
              health.state === 'healthy'
                ? 'border-discord-success/40 bg-discord-success/10'
                : 'border-discord-warning/40 bg-discord-warning/10'
            }`}>
              <p className={`text-sm font-semibold ${
                health.state === 'healthy' ? 'text-discord-success' : 'text-discord-warning'
              }`}>
                {health.state === 'healthy' ? 'No current license issue detected' : 'License delivery needs attention'}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Active keys', health.keyCounts.active],
                ['Pending keys', health.keyCounts.pending_activation],
                ['Active devices', health.activeSessions],
                [`Validations (${health.validationWindowHours}h)`, health.validationCount],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-input bg-discord-bg-tertiary p-3">
                  <p className="text-xl font-bold text-discord-text-primary">{value}</p>
                  <p className="text-xs text-discord-text-muted">{label}</p>
                </div>
              ))}
            </div>
            {(health.pendingOlderThanDay > 0
              || health.keyCounts.suspended > 0
              || health.sessionsOnTerminalKeys > 0
              || health.unavailable24h > 0
              || health.deviceLimit24h > 0
              || health.invalid24h > 0
              || health.unresolvedAlerts.length > 0) && (
              <ul className="space-y-1 text-sm text-discord-text-secondary">
                {health.pendingOlderThanDay > 0 && <li>{health.pendingOlderThanDay} key(s) have waited over 24 hours for activation.</li>}
                {health.keyCounts.suspended > 0 && <li>{health.keyCounts.suspended} key(s) are suspended.</li>}
                {health.sessionsOnTerminalKeys > 0 && <li>{health.sessionsOnTerminalKeys} device session(s) are still active on revoked or expired keys.</li>}
                {health.unavailable24h > 0 && <li>{health.unavailable24h} validation(s) reported a service outage in the last 24 hours.</li>}
                {health.deviceLimit24h > 0 && <li>{health.deviceLimit24h} validation(s) hit a device limit in the last 24 hours.</li>}
                {health.invalid24h > 0 && <li>{health.invalid24h} validation(s) were rejected as invalid in the last 24 hours.</li>}
                {health.unresolvedAlerts.map((alert) => <li key={alert.id}>{alert.title}</li>)}
              </ul>
            )}
            {health.truncated && (
              <p className="text-xs text-discord-warning">
                This server exceeded a live-panel row limit. The visible counts
                cover {health.sampledKeys} of {health.totalKeys} keys and must not
                be treated as whole-server health.
              </p>
            )}
          </div>
        ) : null}
      </section>

      {/* Search */}
      <div className="flex gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && lookupKey()}
          placeholder="Enter license key (SMNI-XXXX-XXXX-XXXX-XXXX) or key ID…"
          className="flex-1 rounded-input bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none border border-discord-border-subtle max-w-lg font-mono"
        />
        <button
          onClick={lookupKey}
          disabled={searchLoading || !search.trim()}
          className="rounded-input bg-[#FF1493] px-4 py-2 text-sm font-medium text-white hover:bg-[#FF1493]/80 transition-standard disabled:opacity-50"
        >
          {searchLoading ? 'Searching…' : 'Look Up'}
        </button>
      </div>

      {searchError && (
        <div className="rounded-card bg-discord-danger/10 border border-discord-danger/30 p-3 text-sm text-discord-danger">
          {searchError}
        </div>
      )}

      {/* Key Detail */}
      {selectedKey && (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6 space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-bold font-mono text-discord-text-primary">
                  {selectedKey.key_prefix}-****-****-****-{selectedKey.key_suffix}
                </h2>
                {(() => {
                  const b = statusBadge(selectedKey.status);
                  return (
                    <span className={`rounded-full px-2 py-0.5 text-xs ${b.color}`}>
                      {b.label}
                    </span>
                  );
                })()}
              </div>
              <p className="mt-1 text-sm text-discord-text-muted">
                Product: <span className="text-discord-text-secondary">{selectedKey.products?.name ?? 'Unknown'}</span>
              </p>
              <p className="text-sm text-discord-text-muted">
                Bound to: <span className="text-discord-text-secondary">
                  {selectedKey.customers?.discord_username ?? selectedKey.bound_discord_id}
                </span>
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              {selectedKey.status === 'active' && (
                <>
                  <button
                    onClick={() => suspendKey(selectedKey.id)}
                    className="rounded-input bg-orange-500/20 px-3 py-1.5 text-xs text-orange-400 hover:bg-orange-500/30 transition-standard"
                  >
                    Suspend
                  </button>
                  <button
                    onClick={() => { setRevokeTargetId(selectedKey.id); setConfirmRevoke(true); }}
                    className="rounded-input bg-discord-danger/20 px-3 py-1.5 text-xs text-discord-danger hover:bg-discord-danger/30 transition-standard"
                  >
                    Revoke
                  </button>
                </>
              )}
              {(selectedKey.status === 'suspended' || selectedKey.status === 'pending_activation') && (
                <button
                  onClick={() => reactivateKey(selectedKey.id)}
                  className="rounded-input bg-discord-success/20 px-3 py-1.5 text-xs text-discord-success hover:bg-discord-success/30 transition-standard"
                >
                  Activate
                </button>
              )}
            </div>
          </div>

          {/* Key Info Grid */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-input bg-discord-bg-tertiary p-3">
              <p className="text-xs text-discord-text-muted">Created</p>
              <p className="text-sm text-discord-text-primary">{formatDate(selectedKey.created_at)}</p>
            </div>
            {selectedKey.activated_at && (
              <div className="rounded-input bg-discord-bg-tertiary p-3">
                <p className="text-xs text-discord-text-muted">Activated</p>
                <p className="text-sm text-discord-text-primary">{formatDate(selectedKey.activated_at)}</p>
              </div>
            )}
            {selectedKey.expires_at && (
              <div className="rounded-input bg-discord-bg-tertiary p-3">
                <p className="text-xs text-discord-text-muted">Expires</p>
                <p className="text-sm text-discord-text-primary">{formatDate(selectedKey.expires_at)}</p>
              </div>
            )}
            {selectedKey.revoked_at && (
              <div className="rounded-input bg-discord-bg-tertiary p-3">
                <p className="text-xs text-discord-text-muted">Revoked</p>
                <p className="text-sm text-discord-text-primary">{formatDate(selectedKey.revoked_at)}</p>
                {selectedKey.revocation_reason && (
                  <p className="text-xs text-discord-text-muted mt-1">{selectedKey.revocation_reason}</p>
                )}
              </div>
            )}
          </div>

          {/* Sessions */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-discord-text-secondary">
                Device Sessions
                {sessions && (
                  <span className="ml-2 text-xs text-discord-text-muted">
                    {sessions.active_count}/{sessions.max_devices} devices
                  </span>
                )}
              </h3>
            </div>

            {sessionsLoading ? (
              <div className="text-sm text-discord-text-muted">Loading sessions…</div>
            ) : sessions && sessions.sessions.length > 0 ? (
              <div className="space-y-2">
                {sessions.sessions.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between rounded-input bg-discord-bg-tertiary p-3"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${s.active ? 'bg-discord-success' : 'bg-discord-text-muted'}`}
                        />
                        <span className="text-sm text-discord-text-primary">
                          {s.device_name ?? s.device_fingerprint.slice(0, 12)}
                        </span>
                        {s.app_version && (
                          <span className="text-xs text-discord-text-muted">v{s.app_version}</span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-discord-text-muted">
                        <span>Last seen: {relativeTime(s.last_seen_at)}</span>
                        {s.ip_address && <span>• {s.ip_address}</span>}
                        {s.deactivation_reason && (
                          <span className="text-discord-danger">
                            • {s.deactivation_reason.replace(/_/g, ' ')}
                          </span>
                        )}
                      </div>
                    </div>
                    {s.active && (
                      <button
                        onClick={() => revokeSession(s.id)}
                        className="rounded-input bg-discord-danger/20 px-3 py-1 text-xs text-discord-danger hover:bg-discord-danger/30 transition-standard"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-discord-text-muted">No sessions recorded</div>
            )}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!selectedKey && !searchError && (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">🔑</div>
          <p className="text-discord-text-muted">
            Enter a license key or key ID above to view details and manage sessions.
          </p>
        </div>
      )}

      {/* Confirm Revoke Dialog */}
      <ConfirmDialog
        open={confirmRevoke}
        title="Revoke License Key"
        description="Are you sure? All active sessions will be terminated immediately. This action cannot be undone."
        confirmLabel="Revoke"
        variant="danger"
        onConfirm={async () => {
          if (revokeTargetId) {
            await revokeKey(revokeTargetId);
          }
          setConfirmRevoke(false);
          setRevokeTargetId(null);
        }}
        onCancel={() => { setConfirmRevoke(false); setRevokeTargetId(null); }}
      />
    </div>
  );
}
