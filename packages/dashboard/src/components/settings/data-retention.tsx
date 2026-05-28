'use client';

/**
 * Data Retention Settings — V5 Audit §5.2
 *
 * Configurable toggle for audit log / transaction data retention period.
 * Default: 180 days. Minimum: 30 days.
 *
 * Important UX note from owner: "New time periods start ON button click,
 * and not surrounding it so people don't expect the ability to rewind
 * data retention."
 */

import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import { Button } from '@/components/shared/button';
import { useToast } from '@/components/shared/toast';
import { Clock, Save, Loader2, AlertTriangle } from 'lucide-react';

const PRESET_OPTIONS = [
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: '180 days', value: 180 },
  { label: '1 year', value: 365 },
  { label: '2 years', value: 730 },
];

export function DataRetentionSettings() {
  const [retentionDays, setRetentionDays] = useState<number>(180);
  const [savedDays, setSavedDays] = useState<number>(180);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const hasChanges = retentionDays !== savedDays;

  const fetchRetention = useCallback(async () => {
    try {
      const res = await fetch('/api/retention');
      if (res.ok) {
        const data = await res.json();
        setRetentionDays(data.retention_days);
        setSavedDays(data.retention_days);
      }
    } catch {
      // Use default
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRetention();
  }, [fetchRetention]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/retention', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retention_days: retentionDays }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to save');
      }

      setSavedDays(retentionDays);
      toast({ title: 'Saved', description: `Retention period set to ${retentionDays} days.`, variant: 'success' });
    } catch (err) {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to save retention setting',
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-blue-400" />
            Data Retention
          </CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-blue-400" />
          Data Retention
        </CardTitle>
        <CardDescription>
          Configure how long audit logs, transaction history, and webhook events are kept.
          Older records are automatically purged.
        </CardDescription>
      </CardHeader>

      <div className="px-6 pb-6 space-y-4">
        {/* Preset buttons */}
        <div className="flex flex-wrap gap-2">
          {PRESET_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setRetentionDays(opt.value)}
              className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                retentionDays === opt.value
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-500'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Custom input */}
        <div className="flex items-center gap-3">
          <label className="text-sm text-zinc-400">Custom:</label>
          <input
            type="number"
            min={30}
            max={3650}
            value={retentionDays}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v)) setRetentionDays(Math.max(30, Math.min(3650, v)));
            }}
            className="w-24 px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <span className="text-sm text-zinc-400">days</span>
        </div>

        {/* Warning note */}
        <div className="flex items-start gap-2 p-3 bg-amber-950/30 border border-amber-800/40 rounded-md">
          <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-300/80">
            The new retention period starts when you click Save. Data older than
            the new limit will be purged on the next cleanup cycle. Previously
            deleted data cannot be recovered — this control does not rewind
            past retention windows.
          </p>
        </div>

        {/* Save button */}
        {hasChanges && (
          <Button
            onClick={handleSave}
            disabled={saving}
            className="gap-2"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving...' : 'Save Retention Setting'}
          </Button>
        )}
      </div>
    </Card>
  );
}
