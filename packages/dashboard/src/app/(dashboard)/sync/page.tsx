/**
 * Sync Engine & Drift Detection Page
 *
 * Displays current drift status, allows repair/accept/ignore actions,
 * and configures sync engine settings (interval, auto-repair).
 *
 * Architecture doc §15
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { isApiRecord, requireApiArray, requireApiRecord, requireApiSuccess, requireReadback } from '@/lib/client-api-result';
import {
  canRepairDriftItem,
  EXTRA_RESOURCE_WARNING,
} from '@/components/sync/drift-card';

interface SyncConfig {
  sync_enabled: boolean;
  sync_interval_minutes: number;
  sync_auto_repair: boolean;
  sync_auto_repair_everyone: boolean;
}

interface DriftItem {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  entityType: string;
  entityName: string;
  entityDiscordId?: string;
  templateKey?: string;
  template_key?: string;
  description: string;
  details?: Record<string, { expected: unknown; actual: unknown }>;
  suggestedAction: 'repair' | 'accept' | 'ignore';
}

interface SyncStatus {
  config: SyncConfig;
  lastSyncAt: string | null;
  driftDetected: boolean;
  driftItems: DriftItem[];
}

function isDriftItem(value: unknown): value is DriftItem {
  return isApiRecord(value)
    && typeof value.type === 'string'
    && (value.severity === 'critical' || value.severity === 'warning' || value.severity === 'info')
    && typeof value.entityType === 'string'
    && typeof value.entityName === 'string'
    && (typeof value.entityDiscordId === 'string' || value.entityDiscordId === undefined)
    && typeof value.description === 'string'
    && (value.suggestedAction === 'repair' || value.suggestedAction === 'accept' || value.suggestedAction === 'ignore');
}

function isSameDriftItem(left: DriftItem, right: DriftItem): boolean {
  return left.type === right.type
    && left.entityType === right.entityType
    && left.entityName === right.entityName
    && left.entityDiscordId === right.entityDiscordId;
}

function syncConfigMatches(left: SyncConfig, right: SyncConfig): boolean {
  return left.sync_enabled === right.sync_enabled
    && left.sync_interval_minutes === right.sync_interval_minutes
    && left.sync_auto_repair === right.sync_auto_repair
    && left.sync_auto_repair_everyone === right.sync_auto_repair_everyone;
}

type PendingSyncAction =
  | { readonly action: 'repair' | 'accept' | 'ignore'; readonly item: DriftItem }
  | { readonly action: 'clear_all' };

const SEVERITY_STYLES: Record<string, { bg: string; border: string; icon: string; label: string }> = {
  critical: { bg: 'bg-red-500/10', border: 'border-red-500/30', icon: '🚨', label: 'Critical' },
  warning: { bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', icon: '⚠️', label: 'Warning' },
  info: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', icon: 'ℹ️', label: 'Info' },
};

const DRIFT_TYPE_LABELS: Record<string, string> = {
  EVERYONE_DRIFT: '@everyone Permissions',
  EXTERNAL_CHANGE: 'External Change',
  MISSING_RESOURCE: 'Missing Resource',
  EXTRA_RESOURCE: 'Extra Resource',
  PERMISSION_DRIFT: 'Permission Drift',
  HIERARCHY_DRIFT: 'Hierarchy Change',
};

export default function SyncPage() {
  const { toast } = useToast();

  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingSyncAction | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/sync/status');
      const json = await requireApiSuccess(res, 'Could not load sync status. Retry from this page.');
      const data = requireApiRecord(json, 'data', 'The sync service returned an invalid readback. Retry from this page.');
      const config = requireApiRecord(data, 'config', 'The sync service returned an invalid configuration readback. Retry from this page.');
      const driftItems = requireApiArray(data, 'driftItems', isDriftItem, 'The sync service returned invalid drift items. Retry from this page.');
      if (typeof config.sync_enabled !== 'boolean' || typeof config.sync_interval_minutes !== 'number'
        || typeof config.sync_auto_repair !== 'boolean' || typeof config.sync_auto_repair_everyone !== 'boolean'
        || (typeof data.lastSyncAt !== 'string' && data.lastSyncAt !== null)
        || typeof data.driftDetected !== 'boolean') {
        throw new Error('The sync service returned an invalid readback. Retry from this page.');
      }
      const nextStatus: SyncStatus = {
        config: { sync_enabled: config.sync_enabled, sync_interval_minutes: config.sync_interval_minutes, sync_auto_repair: config.sync_auto_repair, sync_auto_repair_everyone: config.sync_auto_repair_everyone },
        lastSyncAt: data.lastSyncAt,
        driftDetected: data.driftDetected,
        driftItems,
      };
      setStatus(nextStatus);
      return nextStatus;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load sync status. Retry from this page.');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    // Poll every 30 seconds for drift updates
    const interval = setInterval(loadStatus, 30_000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  const handleConfigSave = async () => {
    if (!status) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/sync/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(status.config),
      });
      await requireApiSuccess(res, 'Could not save sync settings. Your edits are still here; correct the value or retry.');
      const nextStatus = await loadStatus();
      requireReadback(
        nextStatus !== null && syncConfigMatches(nextStatus.config, status.config),
        'Settings were accepted, but the authoritative sync configuration still has previous values. Keep this page open and reload before retrying.',
      );
      toast({ title: 'Settings saved', variant: 'success' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const requestDriftAction = (
    action: 'repair' | 'accept' | 'ignore',
    item: DriftItem,
  ) => {
    if (action === 'repair' && !canRepairDriftItem(item)) {
      setError(EXTRA_RESOURCE_WARNING);
      return;
    }
    setPendingAction({ action, item });
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;
    const target = pendingAction.action === 'clear_all' ? 'all drift notices' : pendingAction.item.entityName;
    setActionLoading(`${pendingAction.action}:${target}`);
    setError(null);
    try {
      const res = await fetch('/api/sync/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          pendingAction.action === 'clear_all'
            ? { action: 'clear_all' }
            : { action: pendingAction.action, driftItem: pendingAction.item },
        ),
      });
      await requireApiSuccess(res, `Could not ${pendingAction.action === 'clear_all' ? 'clear the drift notices' : pendingAction.action + ' this drift item'}. No confirmed change was applied.`);
      const nextStatus = await loadStatus();
      requireReadback(
        nextStatus !== null && (pendingAction.action === 'clear_all'
          ? nextStatus.driftItems.length === 0
          : !nextStatus.driftItems.some((item) => isSameDriftItem(item, pendingAction.item))),
        'The sync action was accepted, but the targeted drift still appears in the authoritative readback. Keep this dialog open and reload before retrying.',
      );
      toast({ title: pendingAction.action === 'clear_all' ? 'Drift notices cleared' : `Drift item ${pendingAction.action}ed`, variant: 'success' });
      setPendingAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The sync action failed. No confirmed change was applied.');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return <ConfigSkeleton />;
  }

  if (!status) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-red-400">Failed to load sync status</div>
      </div>
    );
  }

  const criticalItems = status.driftItems.filter((i) => i.severity === 'critical');
  const warningItems = status.driftItems.filter((i) => i.severity === 'warning');
  const infoItems = status.driftItems.filter((i) => i.severity === 'info');

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">
            Sync Engine
          </h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            Monitors your Discord server and detects changes made outside the dashboard.
          </p>
        </div>
        <div className="text-right">
          {status.lastSyncAt && (
            <p className="text-xs text-discord-text-muted">
              Last sync:{' '}
              {new Date(status.lastSyncAt).toLocaleString()}
            </p>
          )}
          <div className={`mt-1 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            status.driftDetected
              ? criticalItems.length > 0
                ? 'bg-red-500/20 text-red-400'
                : 'bg-yellow-500/20 text-yellow-400'
              : 'bg-green-500/20 text-green-400'
          }`}>
            <span className={`h-2 w-2 rounded-full ${
              status.driftDetected
                ? criticalItems.length > 0
                  ? 'bg-red-500 animate-pulse'
                  : 'bg-yellow-500'
                : 'bg-green-500'
            }`} />
            {status.driftDetected
              ? `${status.driftItems.length} drift item${status.driftItems.length !== 1 ? 's' : ''}`
              : 'In sync'}
          </div>
        </div>
      </div>

      {/* Critical Alert Banner */}
      {criticalItems.length > 0 && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🚨</span>
            <div>
              <h3 className="font-medium text-red-400">
                Critical Drift Detected
              </h3>
              <p className="text-sm text-red-300/80">
                {criticalItems.map((i) => i.description).join('. ')}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Drift Items */}
      {status.driftItems.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-discord-text-primary">
              Drift Items
            </h2>
            <button
              onClick={() => setPendingAction({ action: 'clear_all' })}
              className="text-xs text-discord-text-muted hover:text-discord-text-primary"
            >
              Clear All
            </button>
          </div>

          {/* Group by severity */}
          {[criticalItems, warningItems, infoItems]
            .filter((group) => group.length > 0)
            .flat()
            .map((item, idx) => {
              const style = SEVERITY_STYLES[item.severity] ?? SEVERITY_STYLES.info;
              return (
                <div
                  key={`${item.entityType}-${item.entityName}-${idx}`}
                  className={`rounded-lg border ${style.border} ${style.bg} p-4`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span>{style.icon}</span>
                        <span className="text-xs font-medium uppercase text-discord-text-muted">
                          {DRIFT_TYPE_LABELS[item.type] ?? item.type}
                        </span>
                        <span className="text-xs text-discord-text-muted">
                          • {item.entityType}
                        </span>
                      </div>
                      <h3 className="mt-1 font-medium text-discord-text-primary">
                        {item.entityName}
                      </h3>
                      <p className="mt-0.5 text-sm text-discord-text-muted">
                        {item.description}
                      </p>
                      {item.type === 'EXTRA_RESOURCE' && (
                        <p className="mt-2 rounded border border-discord-warning/30 bg-discord-warning/10 p-2 text-xs text-discord-warning">
                          {EXTRA_RESOURCE_WARNING}
                        </p>
                      )}

                      {/* Detail changes */}
                      {item.details && Object.keys(item.details).length > 0 && (
                        <div className="mt-2 space-y-1">
                          {Object.entries(item.details).map(([key, val]) => (
                            <div key={key} className="flex items-center gap-2 text-xs">
                              <span className="text-discord-text-muted">{key}:</span>
                              <span className="text-red-400 line-through">
                                {String(val.actual ?? val.expected)}
                              </span>
                              <span className="text-discord-text-muted">→</span>
                              <span className="text-green-400">
                                {String(val.expected ?? val.actual)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Action buttons */}
                    <div className="flex shrink-0 gap-2">
                      {canRepairDriftItem(item) && (
                        <button
                          onClick={() => requestDriftAction('repair', item)}
                          disabled={!!actionLoading}
                          className="rounded bg-discord-accent/20 px-3 py-1.5 text-xs font-medium text-discord-accent hover:bg-discord-accent/30 disabled:opacity-50"
                          title="Revert Discord to match desired state"
                        >
                          Repair
                        </button>
                      )}
                      {item.type !== 'EVERYONE_DRIFT' && (
                        <button
                          onClick={() => requestDriftAction('accept', item)}
                          disabled={!!actionLoading}
                          className="rounded bg-green-500/20 px-3 py-1.5 text-xs font-medium text-green-400 hover:bg-green-500/30 disabled:opacity-50"
                          title="Update desired state to match Discord"
                        >
                          {item.type === 'EXTRA_RESOURCE' ? 'Accept (adopt)' : 'Accept'}
                        </button>
                      )}
                      <button
                        onClick={() => requestDriftAction('ignore', item)}
                        disabled={!!actionLoading}
                        className="rounded bg-discord-bg-tertiary px-3 py-1.5 text-xs font-medium text-discord-text-muted hover:text-discord-text-primary disabled:opacity-50"
                        title="Dismiss this item"
                      >
                        Ignore
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
        </section>
      )}

      {/* No Drift */}
      {status.driftItems.length === 0 && (
        <section className="flex flex-col items-center justify-center rounded-lg border border-discord-border-subtle bg-discord-bg-secondary py-16">
          <span className="text-4xl">✅</span>
          <h3 className="mt-4 text-lg font-medium text-discord-text-primary">
            Server In Sync
          </h3>
          <p className="mt-1 text-sm text-discord-text-muted">
            No drift detected. Your Discord server matches the desired state.
          </p>
        </section>
      )}

      {/* Configuration */}
      <section className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-medium text-discord-text-primary">
          Sync Settings
        </h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          Configure how often the sync engine checks for drift and whether it auto-repairs.
        </p>

        <div className="mt-6 space-y-5">
          {/* Enable/Disable */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium text-discord-text-primary">
                Enable Sync Engine
              </span>
              <p className="text-xs text-discord-text-muted">
                Periodically compare Discord state against desired state
              </p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={status.config.sync_enabled}
                onChange={(e) =>
                  setStatus((prev) =>
                    prev
                      ? {
                          ...prev,
                          config: { ...prev.config, sync_enabled: e.target.checked },
                        }
                      : null,
                  )
                }
              />
              <div className="peer h-6 w-11 rounded-full bg-discord-bg-tertiary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-green-500 peer-checked:after:translate-x-full" />
            </label>
          </div>

          {/* Interval */}
          <div>
            <label className="block text-sm font-medium text-discord-text-primary">
              Sync Interval (minutes)
            </label>
            <p className="text-xs text-discord-text-muted mb-2">
              How often to check for drift. Minimum: 5 minutes.
            </p>
            <input
              type="number"
              min={5}
              max={1440}
              value={status.config.sync_interval_minutes}
              onChange={(e) =>
                setStatus((prev) =>
                  prev
                    ? {
                        ...prev,
                        config: {
                          ...prev.config,
                          sync_interval_minutes: parseInt(e.target.value) || 15,
                        },
                      }
                    : null,
                )
              }
              className="w-24 rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-discord-accent focus:outline-none"
            />
          </div>

          {/* Auto-repair */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium text-discord-text-primary">
                Auto-Repair Drift
              </span>
              <p className="text-xs text-discord-text-muted">
                Automatically revert external changes to match desired state
              </p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={status.config.sync_auto_repair}
                onChange={(e) =>
                  setStatus((prev) =>
                    prev
                      ? {
                          ...prev,
                          config: { ...prev.config, sync_auto_repair: e.target.checked },
                        }
                      : null,
                  )
                }
              />
              <div className="peer h-6 w-11 rounded-full bg-discord-bg-tertiary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-green-500 peer-checked:after:translate-x-full" />
            </label>
          </div>

          {/* Auto-repair @everyone */}
          <div className="flex items-center justify-between rounded-lg border border-red-500/20 bg-red-500/5 p-4">
            <div>
              <span className="text-sm font-medium text-discord-text-primary">
                Auto-Repair @everyone Drift
              </span>
              <p className="text-xs text-discord-text-muted">
                <strong className="text-red-400">Recommended ON.</strong>{' '}
                Immediately resets @everyone to 0 permissions if someone changes it.
              </p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={status.config.sync_auto_repair_everyone}
                onChange={(e) =>
                  setStatus((prev) =>
                    prev
                      ? {
                          ...prev,
                          config: {
                            ...prev.config,
                            sync_auto_repair_everyone: e.target.checked,
                          },
                        }
                      : null,
                  )
                }
              />
              <div className="peer h-6 w-11 rounded-full bg-discord-bg-tertiary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-green-500 peer-checked:after:translate-x-full" />
            </label>
          </div>
        </div>

        {/* Save */}
        <div className="mt-6 flex items-center gap-4">
          <button
            onClick={handleConfigSave}
            disabled={saving}
            className="rounded-md bg-discord-accent px-6 py-2.5 text-sm font-medium text-white hover:bg-discord-accent-hover disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          {error && <span role="alert" className="text-sm text-red-400">{error}</span>}
        </div>
      </section>

      {/* How It Works */}
      <section className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-medium text-discord-text-primary mb-3">
          How Drift Detection Works
        </h2>
        <div className="space-y-3 text-sm text-discord-text-muted">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-discord-accent font-mono text-xs">1</span>
            <p>
              <strong className="text-discord-text-primary">Snapshot</strong> — The bot periodically
              reads your Discord server&apos;s roles, channels, and permissions.
            </p>
          </div>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-discord-accent font-mono text-xs">2</span>
            <p>
              <strong className="text-discord-text-primary">Diff</strong> — Compares the snapshot
              against the desired state (what the dashboard says it should be).
            </p>
          </div>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-discord-accent font-mono text-xs">3</span>
            <p>
              <strong className="text-discord-text-primary">Classify</strong> — Categorizes each
              difference by type and severity.
            </p>
          </div>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-discord-accent font-mono text-xs">4</span>
            <p>
              <strong className="text-discord-text-primary">Action</strong> — You choose to{' '}
              <span className="text-discord-accent">Repair</span> (revert to desired),{' '}
              <span className="text-green-400">Accept</span> (update desired), or{' '}
              Ignore each item.
            </p>
          </div>
          <div className="mt-2 rounded border border-discord-border-subtle bg-discord-bg-tertiary px-4 py-2 text-xs">
            Additionally, the bot detects changes in real-time via Discord events (role/channel
            create/update/delete). These appear here instantly — no need to wait for the next sync cycle.
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction?.action === 'clear_all' ? 'Clear all drift notices' : pendingAction?.action === 'repair' ? 'Repair Discord resource' : pendingAction?.action === 'accept' ? 'Accept Discord state' : 'Ignore drift item'}
        description={pendingAction ? pendingAction.action === 'clear_all'
          ? `Clear all ${status.driftItems.length} drift notices from this view without repairing Discord or updating desired state.`
          : pendingAction.action === 'repair'
            ? `Repair “${pendingAction.item.entityName}” (${pendingAction.item.entityType}) by changing Discord to match the dashboard’s desired state.`
            : pendingAction.action === 'accept'
              ? pendingAction.item.type === 'EXTRA_RESOURCE'
                ? `Adopt “${pendingAction.item.entityName}” (${pendingAction.item.entityType}) into the dashboard’s desired state. This preserves the existing Discord resource; it does not delete or recreate it.`
                : `Accept Discord’s current state for “${pendingAction.item.entityName}” (${pendingAction.item.entityType}) and replace the dashboard’s desired state.`
              : `Ignore drift for “${pendingAction.item.entityName}” (${pendingAction.item.entityType}). The difference remains in Discord but leaves this active list.` : undefined}
        confirmLabel={pendingAction?.action === 'clear_all' ? 'Clear notices' : pendingAction?.action === 'repair' ? 'Repair resource' : pendingAction?.action === 'accept' ? pendingAction.item.type === 'EXTRA_RESOURCE' ? 'Adopt resource' : 'Accept state' : 'Ignore drift'}
        variant={pendingAction?.action === 'repair' ? 'warning' : 'default'}
        loading={actionLoading !== null}
        onConfirm={executePendingAction}
        onCancel={() => {
          if (!actionLoading) setPendingAction(null);
        }}
      />
    </div>
  );
}
