'use client';

import { useState, useEffect, useCallback } from 'react';
import { DriftCard, type DriftCardData } from '@/components/sync/drift-card';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import { Button } from '@/components/shared/button';
import { Badge } from '@/components/shared/badge';
import { Toggle } from '@/components/shared/input';
import { syncApi } from '@/lib/api/client';
import {
  RefreshCw, Shield, CheckCircle2, AlertTriangle,
  Clock, Settings, Activity,
} from 'lucide-react';

// ============================================================
// Page
// ============================================================

export default function SyncPage() {
  const [driftItems, setDriftItems] = useState<DriftCardData[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState({
    syncEnabled: true,
    syncIntervalMinutes: 15,
    autoRepair: false,
    autoRepairEveryone: true,
  });

  const loadStatus = useCallback(async () => {
    try {
      const data = await syncApi.getStatus();
      setDriftItems(data.driftItems as DriftCardData[]);
      setLastSyncAt(data.lastSyncAt);
      setConfig(data.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sync status');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    // Auto-refresh every 30 seconds
    const interval = setInterval(loadStatus, 30_000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadStatus();
  };

  const handleConfigChange = async (key: string, value: boolean | number) => {
    const newConfig = { ...config, [key]: value };
    setConfig(newConfig);
    try {
      await syncApi.updateConfig(newConfig);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update config');
    }
  };

  const handleRepair = async (item: DriftCardData) => {
    try {
      await syncApi.repair(item.entityType, item.entityDiscordId ?? '', item.entityName, item.type);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to repair');
    }
  };

  const handleAccept = async (item: DriftCardData) => {
    try {
      await syncApi.accept(item.entityType, item.entityDiscordId ?? '', item.entityName, item.type);
      // Remove from local state
      setDriftItems((prev) => prev.filter((d) => d !== item));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept');
    }
  };

  const criticalCount = driftItems.filter((d) => d.severity === 'critical').length;
  const warningCount = driftItems.filter((d) => d.severity === 'warning').length;
  const infoCount = driftItems.filter((d) => d.severity === 'info').length;

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="text-sm text-discord-text-muted">Loading sync status...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-discord-text-primary">
            <Activity size={22} />
            Sync &amp; Drift Detection
          </h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            Monitor changes to your Discord server and keep it in sync with the dashboard configuration.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </Button>
      </div>

      {/* Status banner */}
      {driftItems.length === 0 ? (
        <Card variant="success">
          <div className="flex items-center gap-3">
            <CheckCircle2 size={20} className="text-discord-success" />
            <div>
              <p className="font-medium text-discord-text-primary">All synced</p>
              <p className="text-xs text-discord-text-muted">
                Discord server matches the dashboard configuration.
                {lastSyncAt && ` Last checked ${new Date(lastSyncAt).toLocaleString()}`}
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <Card variant={criticalCount > 0 ? 'danger' : 'warning'}>
          <div className="flex items-center gap-3">
            <AlertTriangle size={20} className={criticalCount > 0 ? 'text-discord-danger' : 'text-discord-warning'} />
            <div className="flex-1">
              <p className="font-medium text-discord-text-primary">
                {driftItems.length} drift item{driftItems.length !== 1 ? 's' : ''} detected
              </p>
              <div className="mt-1 flex gap-2">
                {criticalCount > 0 && <Badge variant="danger">{criticalCount} critical</Badge>}
                {warningCount > 0 && <Badge variant="warning">{warningCount} warning</Badge>}
                {infoCount > 0 && <Badge variant="info">{infoCount} info</Badge>}
              </div>
            </div>
            {lastSyncAt && (
              <div className="flex items-center gap-1 text-xs text-discord-text-muted">
                <Clock size={12} />
                {new Date(lastSyncAt).toLocaleString()}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Drift items */}
      {driftItems.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-discord-text-muted">Drift Items</h2>
          {driftItems.map((item, i) => (
            <DriftCard
              key={`${item.type}-${item.entityName}-${i}`}
              item={item}
              onRepair={() => handleRepair(item)}
              onAccept={() => handleAccept(item)}
              onIgnore={() => handleAccept(item)}
            />
          ))}
        </div>
      )}

      {/* Sync configuration */}
      <Card>
        <CardHeader>
          <CardTitle>
            <div className="flex items-center gap-2">
              <Settings size={16} />
              Sync Configuration
            </div>
          </CardTitle>
        </CardHeader>
        <div className="space-y-4">
          <Toggle
            label="Enable Sync Engine"
            description="Periodically check Discord for changes that don't match the dashboard configuration."
            checked={config.syncEnabled}
            onChange={(v) => handleConfigChange('syncEnabled', v)}
          />
          <Toggle
            label="Auto-repair @everyone"
            description="Automatically reset @everyone permissions to zero if they change. Critical for the onboarding model."
            checked={config.autoRepairEveryone}
            onChange={(v) => handleConfigChange('autoRepairEveryone', v)}
          />
          <Toggle
            label="Auto-repair All Drift"
            description="Automatically fix any detected drift without manual approval. Use with caution."
            checked={config.autoRepair}
            onChange={(v) => handleConfigChange('autoRepair', v)}
          />
        </div>
      </Card>
    </div>
  );
}
