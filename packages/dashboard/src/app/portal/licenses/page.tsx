/**
 * Customer Portal — License keys and sessions.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/shared/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

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
  products: {
    name: string;
    type: string;
    product_license_config?:
      | {
          rotation_policy?: 'rotate-and-invalidate' | 'disabled';
          self_service_device_removal?: boolean;
        }
      | Array<{
          rotation_policy?: 'rotate-and-invalidate' | 'disabled';
          self_service_device_removal?: boolean;
        }>;
  } | null;
  license_sessions: LicenseSession[];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function productLicenseConfig(product: LicenseKey['products']) {
  const config = product?.product_license_config;
  return Array.isArray(config) ? config[0] : config;
}

export default function PortalLicenses() {
  const [keys, setKeys] = useState<LicenseKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<LicenseSession | null>(null);
  const [rotateTarget, setRotateTarget] = useState<LicenseKey | null>(null);
  const [mutation, setMutation] = useState<'remove' | 'rotate' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const loadKeys = useCallback(async () => {
    const token = localStorage.getItem('portal_token');
    if (!token) {
      window.location.href = '/portal';
      return;
    }
    const response = await fetch('/api/portal/licenses', {
      headers: { 'x-portal-token': token },
    });
    if (response.status === 401) {
      localStorage.removeItem('portal_token');
      window.location.href = '/portal';
      return;
    }
    const body = await response.json();
    if (!response.ok || body.success !== true || !Array.isArray(body.data)) {
      throw new Error(body.error || 'Licenses could not be loaded.');
    }
    setKeys(body.data);
  }, []);

  const removeDevice = async () => {
    const token = localStorage.getItem('portal_token');
    if (!token || !removeTarget) return;
    setMutation('remove');
    setNotice(null);
    try {
      const response = await fetch(`/api/portal/licenses/sessions/${removeTarget.id}`, {
        method: 'DELETE',
        headers: { 'x-portal-token': token },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success !== true) {
        throw new Error(body.error || 'The device could not be removed.');
      }
      const successMessage = 'The device session was removed and can no longer use this license.';
      setRemoveTarget(null);
      setNotice({ kind: 'success', message: successMessage });
      try {
        await loadKeys();
      } catch {
        setNotice({
          kind: 'success',
          message: `${successMessage} The license list could not be refreshed; reload this page to see the latest device count.`,
        });
      }
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'The device could not be removed.' });
    } finally {
      setMutation(null);
    }
  };

  const rotateKey = async () => {
    const token = localStorage.getItem('portal_token');
    if (!token || !rotateTarget) return;
    setMutation('rotate');
    setNotice(null);
    try {
      const response = await fetch(`/api/portal/licenses/${rotateTarget.id}/rotate`, {
        method: 'POST',
        headers: { 'x-portal-token': token },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success !== true) {
        throw new Error(body.error || 'The license key could not be rotated.');
      }
      const successMessage = body.alreadyRotated
        ? `This key was already rotated. Check your Discord DMs for the replacement ending in ${body.newKeySuffix}.`
        : `The old key stopped working. A replacement ending in ${body.newKeySuffix} is on its way by Discord DM.`;
      setRotateTarget(null);
      setNotice({ kind: 'success', message: successMessage });
      try {
        await loadKeys();
      } catch {
        setNotice({
          kind: 'success',
          message: `${successMessage} The license list could not be refreshed; reload this page to see the latest key ending.`,
        });
      }
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'The license key could not be rotated.' });
    } finally {
      setMutation(null);
    }
  };

  useEffect(() => {
    async function load() {
      try {
        await loadKeys();
      } catch (error) {
        setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Licenses could not be loaded.' });
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [loadKeys]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24" role="status" aria-label="Loading licenses">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-discord-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Your Licenses</h1>
        <p className="mt-1 text-sm text-discord-text-muted">View licenses, replace a compromised key, and remove old devices.</p>
      </div>

      {notice && (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`rounded-input border p-3 text-sm ${notice.kind === 'error'
            ? 'border-discord-danger/40 bg-discord-danger/10 text-discord-danger'
            : 'border-discord-success/40 bg-discord-success/10 text-discord-text-primary'}`}
        >
          {notice.message}
        </div>
      )}

      {keys.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <KeyRound className="mx-auto mb-3 text-discord-text-muted" size={36} aria-hidden="true" />
          <p className="text-discord-text-muted">No licenses yet. Purchased products will appear here.</p>
        </div>
      ) : (
        keys.map((key) => {
          const activeSessions = key.license_sessions?.filter(s => s.active) || [];
          const licenseConfig = productLicenseConfig(key.products);
          const rotationAllowed = licenseConfig?.rotation_policy !== 'disabled';
          const removalAllowed = licenseConfig?.self_service_device_removal !== false;
          return (
            <div key={key.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary">
              <button
                onClick={() => setExpandedId(expandedId === key.id ? null : key.id)}
                aria-expanded={expandedId === key.id}
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

                  {key.status === 'active' && rotationAllowed && (
                    <div className="rounded-input border border-discord-warning/30 bg-discord-warning/10 p-3">
                      <p className="text-xs text-discord-text-secondary">
                        Replace this key if it was shared or exposed. The current key stops working immediately, and the replacement is delivered only through Discord DM.
                      </p>
                      <Button className="mt-3" size="sm" variant="danger" onClick={() => setRotateTarget(key)}>
                        Rotate key
                      </Button>
                    </div>
                  )}

                  <div>
                    <h4 className="text-xs font-semibold uppercase text-discord-text-muted mb-2">Active Sessions</h4>
                    {activeSessions.length === 0 ? (
                      <p className="text-xs text-discord-text-muted">No active sessions.</p>
                    ) : (
                      <div className="space-y-1">
                        {activeSessions.map((session) => (
                          <div key={session.id} className="flex flex-col items-start gap-2 rounded-md bg-discord-bg-tertiary p-2 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <span className="text-xs text-discord-text-primary">
                                {session.device_name || session.device_fingerprint.slice(0, 16)}
                              </span>
                              {session.ip_address && (
                                <span className="ml-2 text-[10px] text-discord-text-muted">{session.ip_address}</span>
                              )}
                            </div>
                            <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
                              <span className="text-[10px] text-discord-text-muted">
                                Last seen: {formatDate(session.last_seen_at)}
                              </span>
                              {removalAllowed && (
                                <button
                                  type="button"
                                  disabled={mutation !== null}
                                  onClick={() => setRemoveTarget(session)}
                                  className="inline-flex h-8 items-center rounded-input bg-discord-danger/20 px-3 text-xs font-medium text-discord-danger transition-standard hover:bg-discord-danger/30 disabled:opacity-50"
                                >
                                  Remove device
                                </button>
                              )}
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

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title="Remove this device?"
        description={`${removeTarget?.device_name || 'This device'} will be signed out of the license. It can be activated again later if a seat is available.`}
        confirmLabel="Remove device"
        variant="danger"
        loading={mutation === 'remove'}
        onConfirm={removeDevice}
        onCancel={() => setRemoveTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(rotateTarget)}
        title={`Rotate the key for ${rotateTarget?.products?.name || 'this product'}?`}
        description="The current key stops working immediately. The replacement is delivered only through Discord DM, and this action cannot be undone."
        confirmLabel="Rotate key"
        variant="danger"
        loading={mutation === 'rotate'}
        onConfirm={rotateKey}
        onCancel={() => setRotateTarget(null)}
      />
    </div>
  );
}
