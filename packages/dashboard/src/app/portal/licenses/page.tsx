/**
 * Customer Portal — License keys and sessions.
 */
'use client';

import { useEffect, useState } from 'react';

interface LicenseSession {
  id: string;
  device_name: string | null;
  device_fingerprint: string;
  ip_address: string | null;
  active: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

interface LicenseKey {
  id: string;
  key_prefix: string;
  key_suffix: string;
  status: string;
  max_devices: number;
  expires_at: string | null;
  created_at: string;
  products: { name: string; type: string } | null;
  license_sessions: LicenseSession[];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function PortalLicenses() {
  const [keys, setKeys] = useState<LicenseKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const removeDevice = async (sessionId: string) => {
    const token = localStorage.getItem('portal_token');
    if (!token) return;
    setRemoving(sessionId);
    try {
      const response = await fetch(`/api/portal/licenses/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: { 'x-portal-token': token },
      });
      if (response.ok) {
        setKeys((current) => current.map((key) => ({
          ...key,
          license_sessions: key.license_sessions.map((session) =>
            session.id === sessionId ? { ...session, active: false } : session),
        })));
      }
    } finally {
      setRemoving(null);
    }
  };

  useEffect(() => {
    async function load() {
      const token = localStorage.getItem('portal_token');
      // V11 Re-Audit UX-1: Redirect to portal login if no token instead of
      // silently leaving the user on an infinite loading spinner.
      if (!token) {
        window.location.href = '/portal';
        return;
      }
      try {
        const res = await fetch('/api/portal/licenses', { headers: { 'x-portal-token': token } });
        if (res.status === 401) {
          localStorage.removeItem('portal_token');
          window.location.href = '/portal';
          return;
        }
        const json = await res.json();
        if (json.success) setKeys(json.data);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-discord-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Your Licenses</h1>
        <p className="mt-1 text-sm text-discord-text-muted">View your license keys and active device sessions.</p>
      </div>

      {keys.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">🔑</div>
          <p className="text-discord-text-muted">No licenses yet. Purchased products will appear here.</p>
        </div>
      ) : (
        keys.map((key) => {
          const activeSessions = key.license_sessions?.filter(s => s.active) || [];
          return (
            <div key={key.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary">
              <button
                onClick={() => setExpandedId(expandedId === key.id ? null : key.id)}
                className="w-full text-left px-4 py-4 hover:bg-discord-bg-tertiary/30 transition-colors rounded-lg"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-discord-text-primary">{key.products?.name || 'Unknown Product'}</p>
                    <p className="mt-0.5 text-xs font-mono text-discord-text-muted">
                      {key.key_prefix}…{key.key_suffix}
                    </p>
                  </div>
                  <div className="text-right">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      key.status === 'active' ? 'bg-discord-success/20 text-discord-success' :
                      key.status === 'suspended' ? 'bg-yellow-500/20 text-yellow-400' :
                      'bg-discord-bg-tertiary text-discord-text-muted'
                    }`}>
                      {key.status}
                    </span>
                    <p className="mt-1 text-xs text-discord-text-muted">
                      {activeSessions.length}/{key.max_devices} devices
                    </p>
                  </div>
                </div>
              </button>

              {expandedId === key.id && (
                <div className="border-t border-discord-border-subtle px-4 py-3 space-y-3">
                  <div className="grid gap-2 text-xs text-discord-text-muted sm:grid-cols-3">
                    <div>Created: {formatDate(key.created_at)}</div>
                    <div>Expires: {key.expires_at ? formatDate(key.expires_at) : 'Never'}</div>
                    <div>Max Devices: {key.max_devices}</div>
                  </div>

                  <div>
                    <h4 className="text-xs font-semibold uppercase text-discord-text-muted mb-2">Active Sessions</h4>
                    {activeSessions.length === 0 ? (
                      <p className="text-xs text-discord-text-muted">No active sessions.</p>
                    ) : (
                      <div className="space-y-1">
                        {activeSessions.map((session) => (
                          <div key={session.id} className="flex items-center justify-between rounded-md bg-discord-bg-tertiary p-2">
                            <div>
                              <span className="text-xs text-discord-text-primary">
                                {session.device_name || session.device_fingerprint.slice(0, 16)}
                              </span>
                              {session.ip_address && (
                                <span className="ml-2 text-[10px] text-discord-text-muted">{session.ip_address}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-discord-text-muted">
                                Last seen: {formatDate(session.last_seen_at)}
                              </span>
                              <button
                                type="button"
                                disabled={removing === session.id}
                                onClick={() => void removeDevice(session.id)}
                                className="rounded-md bg-discord-danger/20 px-2 py-1 text-[10px] text-discord-danger disabled:opacity-50"
                              >
                                {removing === session.id ? 'Removing…' : 'Remove'}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
