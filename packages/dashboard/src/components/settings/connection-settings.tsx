'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useToast } from '@/components/shared/toast';
import { useUnsavedWarning } from '@/hooks/use-unsaved-warning';
import { cn } from '@/lib/utils/cn';
import { ConnectionSectionCard } from './connection-section-card';
import {
  CONNECTION_SECTIONS,
  type ConnectionStatus,
  type SettingSource,
} from './connection-settings-config';

interface SettingsResponse {
  values?: Record<string, string>;
  sources?: Record<string, SettingSource>;
  statuses?: Record<string, ConnectionStatus>;
  lockedFields?: string[];
  environmentFallbacks?: Record<string, boolean>;
}

export function ConnectionSettings() {
  const { toast } = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<Record<string, SettingSource>>({});
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({});
  const [lockedFields, setLockedFields] = useState<string[]>([]);
  const [editingSecrets, setEditingSecrets] = useState<Record<string, boolean>>({});
  const [secretEdits, setSecretEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetSection, setResetSection] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(() => new Set());
  useUnsavedWarning(dirtyFields.size > 0);

  const applyResponse = useCallback((data: SettingsResponse) => {
    setValues(data.values ?? {});
    setSources(data.sources ?? {});
    setStatuses(data.statuses ?? {});
    setLockedFields(data.lockedFields ?? []);
  }, []);

  const load = useCallback(async () => {
    const response = await fetch('/api/settings');
    const data = await response.json() as SettingsResponse & { error?: string };
    if (!response.ok) throw new Error(data.error ?? 'Settings could not be loaded');
    applyResponse(data);
  }, [applyResponse]);

  useEffect(() => {
    void load()
      .catch((error: unknown) => {
        toast({
          title: error instanceof Error ? error.message : 'Settings could not be loaded',
          variant: 'error',
        });
      })
      .finally(() => setLoading(false));
  }, [load, toast]);

  const markDirty = (key: string) => {
    setDirtyFields((current) => new Set(current).add(key));
  };

  const updateField = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    markDirty(key);
  };

  const updateSecret = (key: string, value: string) => {
    setSecretEdits((current) => ({ ...current, [key]: value }));
    markDirty(key);
  };

  const cancelSecret = (key: string) => {
    setEditingSecrets((current) => ({ ...current, [key]: false }));
    setSecretEdits((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setDirtyFields((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };

  const save = async (sectionId: string) => {
    const section = CONNECTION_SECTIONS.find((candidate) => candidate.id === sectionId);
    if (!section || section.bootstrapOnly) return;
    const sectionValues: Record<string, string> = {};
    for (const field of section.fields) {
      if (!dirtyFields.has(field.key)) continue;
      if (field.secret) {
        const secret = editingSecrets[field.key]
          ? secretEdits[field.key]?.trim()
          : (sources[field.key] ?? 'none') === 'none' ? values[field.key]?.trim() : undefined;
        if (secret) sectionValues[field.key] = secret;
      } else if (values[field.key]?.trim()) {
        sectionValues[field.key] = values[field.key].trim();
      }
    }

    setSaving(sectionId);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: sectionId, values: sectionValues }),
      });
      const result = await response.json() as { error?: string; restartRequired?: boolean };
      if (!response.ok) throw new Error(result.error ?? 'Settings could not be saved');
      await load();
      for (const field of section.fields) if (field.secret) cancelSecret(field.key);
      setDirtyFields((current) => {
        const next = new Set(current);
        for (const field of section.fields) next.delete(field.key);
        return next;
      });
      toast({
        title: `${section.title} override saved`,
        description: result.restartRequired
          ? 'Restart the bot and dashboard to apply the connection change.'
          : undefined,
        variant: 'success',
      });
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : 'Settings could not be saved',
        variant: 'error',
      });
    } finally {
      setSaving(null);
    }
  };

  const reset = async () => {
    const section = CONNECTION_SECTIONS.find((candidate) => candidate.id === resetSection);
    if (!section) return;
    const keys = section.fields
      .map((field) => field.key)
      .filter((key) => sources[key] === 'db');
    if (keys.length === 0) return;

    setResetting(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: section.id, keys }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Deployment defaults could not be restored');
      await load();
      setResetSection(null);
      toast({
        title: `${section.title} saved overrides removed`,
        description: 'After restart, fields with deployment values use them; the others become unconfigured.',
        variant: 'success',
      });
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : 'Deployment defaults could not be restored',
        variant: 'error',
      });
    } finally {
      setResetting(false);
    }
  };

  const locked = useMemo(() => new Set(lockedFields), [lockedFields]);
  if (loading) return <ConfigSkeleton />;
  const configured = Object.values(statuses).filter((status) => (
    status === 'connected' || status === 'bot-side'
  )).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-card border border-discord-border-subtle bg-discord-bg-secondary px-4 py-3">
        <ShieldCheck size={20} className="mt-0.5 shrink-0 text-discord-accent" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-discord-text-primary">
            {configured} of {CONNECTION_SECTIONS.length} connection sections configured
          </p>
          <p className="mt-0.5 text-xs text-discord-text-muted">
            Deployment values are defaults. Saving Discord, PayPal, Lavalink, or Valkey creates an encrypted installation override; Supabase remains deployment-only so the dashboard can always boot.
          </p>
        </div>
        <div className="ml-auto hidden h-2 w-24 shrink-0 overflow-hidden rounded-full bg-discord-bg-tertiary sm:block">
          <div
            className={cn('h-full rounded-full bg-discord-accent transition-all')}
            style={{ width: `${(configured / CONNECTION_SECTIONS.length) * 100}%` }}
          />
        </div>
      </div>

      {CONNECTION_SECTIONS.map((section) => (
        <ConnectionSectionCard
          key={section.id}
          section={section}
          values={values}
          sources={sources}
          lockedFields={locked}
          status={statuses[section.id] ?? 'disconnected'}
          saving={saving === section.id}
          canSave={section.fields.some((field) => dirtyFields.has(field.key))}
          canReset={
            !section.fields.some((field) => dirtyFields.has(field.key))
            && section.fields.some((field) => (
              sources[field.key] === 'db'
            ))
          }
          editingSecrets={editingSecrets}
          secretEdits={secretEdits}
          onFieldChange={updateField}
          onStartSecretEdit={(key) => {
            setEditingSecrets((current) => ({ ...current, [key]: true }));
            setSecretEdits((current) => ({ ...current, [key]: '' }));
          }}
          onSecretEdit={updateSecret}
          onCancelSecretEdit={cancelSecret}
          onSave={() => void save(section.id)}
          onReset={() => setResetSection(section.id)}
        />
      ))}

      <ConfirmDialog
        open={resetSection !== null}
        title="Remove saved overrides?"
        description="Saved overrides in this section will be removed. After restart, fields with deployment values use them; fields without one become unconfigured."
        confirmLabel="Remove saved overrides"
        variant="warning"
        loading={resetting}
        onConfirm={reset}
        onCancel={() => setResetSection(null)}
      />
    </div>
  );
}
