'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, LockKeyhole, ShieldCheck, XCircle } from 'lucide-react';
import { z } from 'zod';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/shared/card';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { cn } from '@/lib/utils/cn';
import {
  CONNECTION_SECTIONS,
  type SettingSource,
} from './connection-settings-config';

const settingsResponseSchema = z.object({
  values: z.record(z.string()),
  sources: z.record(z.enum(['env', 'db', 'none'])),
  statuses: z.record(z.enum(['connected', 'disconnected', 'checking', 'bot-side']))
    .refine((statuses) => CONNECTION_SECTIONS.every((section) => statuses[section.id] !== undefined)),
});

type ReadbackState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'failed' }
  | { readonly phase: 'loaded'; readonly data: z.infer<typeof settingsResponseSchema> };

function sourceLabel(source: SettingSource): string {
  if (source === 'db') return 'Saved installation value';
  if (source === 'env') return 'Launcher/deployment value';
  return 'Not configured';
}

export function ConnectionSettings() {
  const [state, setState] = useState<ReadbackState>({ phase: 'loading' });

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const response = await fetch('/api/settings');
      if (!response.ok) {
        setState({ phase: 'failed' });
        return;
      }
      const parsed = settingsResponseSchema.safeParse(await response.json());
      setState(parsed.success ? { phase: 'loaded', data: parsed.data } : { phase: 'failed' });
    } catch {
      setState({ phase: 'failed' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === 'loading') return <ConfigSkeleton />;
  if (state.phase === 'failed') {
    return <EmptyState
      icon={AlertCircle}
      title="Connection status unavailable"
      description="Connection state is unknown because its authoritative readback could not be loaded. Retry with an installation-operator session. Manage installation connections in the SomniBot Launcher."
      action={{ label: 'Retry', onClick: () => { void load(); } }}
    />;
  }
  const { values, sources, statuses } = state.data;
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
            Connection state is visible here for diagnosis. The SomniBot Launcher is the authoritative place to change installation credentials, deployment, services, updates, and recovery settings.
          </p>
        </div>
      </div>

      {CONNECTION_SECTIONS.map((section) => {
        const Icon = section.icon;
        const status = statuses[section.id] ?? 'disconnected';
        const isConfigured = status === 'connected' || status === 'bot-side';
        return (
          <Card key={section.id}>
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <div className={cn('shrink-0 rounded-lg bg-discord-bg-tertiary p-2', section.iconColor)}>
                    <Icon size={20} aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="text-base">{section.title}</CardTitle>
                    <CardDescription>{section.description}</CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-discord-text-muted">
                  {isConfigured ? (
                    <CheckCircle2 size={14} className="text-discord-success" aria-hidden="true" />
                  ) : (
                    <XCircle size={14} aria-hidden="true" />
                  )}
                  {status === 'checking' ? 'Checking' : isConfigured ? 'Configured' : 'Not configured'}
                </div>
              </div>
            </CardHeader>
            <div className="space-y-3 px-4 pb-5 sm:px-6 sm:pb-6">
              {section.fields.map((field) => {
                const source = sources[field.key] ?? 'none';
                const value = values[field.key] ?? '';
                return (
                  <div key={field.key}>
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-discord-text-secondary">{field.label}</span>
                      <span className="flex items-center gap-1 rounded bg-discord-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-discord-text-muted">
                        <LockKeyhole size={10} aria-hidden="true" />
                        {sourceLabel(source)}
                      </span>
                    </div>
                    <div className="select-text overflow-x-auto rounded-input bg-discord-bg-tertiary px-3 py-2 font-mono text-sm text-discord-text-muted ring-1 ring-discord-border-subtle">
                      {field.secret ? (source === 'none' ? 'Not configured' : '••••••••') : (value || 'Not configured')}
                    </div>
                  </div>
                );
              })}
              <p className="border-t border-discord-border-subtle pt-4 text-xs text-discord-text-muted">
                Open the SomniBot Launcher on the machine that owns this installation to change these values.
              </p>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
