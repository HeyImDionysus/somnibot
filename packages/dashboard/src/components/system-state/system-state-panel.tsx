'use client';

import {
  SystemStateSchema,
  type SystemState,
} from '@somnibot/shared/system-state/contract';
import React, { useEffect, useState } from 'react';

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly state: SystemState }
  | { readonly kind: 'error'; readonly message: string };

function valueOrUnknown(value: string | number | null): string {
  return value === null ? 'Unknown' : String(value);
}

export function SystemStatePanel() {
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/system-state', { signal: controller.signal })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok || body === null || typeof body !== 'object' || !('data' in body)) {
          throw new Error('System state is unavailable.');
        }
        const parsed = SystemStateSchema.safeParse(body.data);
        if (!parsed.success) throw new Error('System state readback was malformed.');
        setLoadState({ kind: 'loaded', state: parsed.data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoadState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'System state is unavailable.',
        });
      });
    return () => controller.abort();
  }, []);

  if (loadState.kind === 'loading') {
    return <section aria-busy="true" aria-label="Deployment state" className="rounded-card bg-discord-bg-elevated p-5 text-sm text-discord-text-muted">Loading deployment state…</section>;
  }
  if (loadState.kind === 'error') {
    return <section role="alert" className="rounded-card border border-red-500/30 bg-red-500/10 p-5 text-sm text-red-300">{loadState.message}</section>;
  }

  const state = loadState.state;
  const healthy = state.mode === 'normal' && state.recovery.status === 'ready';
  const details: ReadonlyArray<readonly [string, string]> = [
    ['Deployment profile', state.identity.deploymentProfile],
    ['Exact SHA', state.identity.exactSha ? state.identity.exactSha.slice(0, 12) : 'Unknown'],
    ['Migration head', valueOrUnknown(state.identity.migrationHead)],
    ['Configuration generation', valueOrUnknown(state.identity.configurationGeneration)],
    ['Database backup', state.backups.database.status],
    ['Valkey backup', state.backups.valkey.status],
  ];
  const recoveryDetails: ReadonlyArray<readonly [string, string]> = [
    ['Database captured', valueOrUnknown(state.backups.database.capturedAt)],
    ['Database SHA-256', valueOrUnknown(state.backups.database.checksumSha256)],
    ['Database restore rehearsal', valueOrUnknown(state.backups.database.lastRestoreRehearsalAt)],
    ['Valkey captured', valueOrUnknown(state.backups.valkey.capturedAt)],
    ['Valkey SHA-256', valueOrUnknown(state.backups.valkey.checksumSha256)],
    ['Valkey restore rehearsal', valueOrUnknown(state.backups.valkey.lastRestoreRehearsalAt)],
    ['Recovery point objective (minutes)', valueOrUnknown(state.recovery.recoveryPointObjectiveMinutes)],
    ['Recovery time objective (minutes)', valueOrUnknown(state.recovery.recoveryTimeObjectiveMinutes)],
  ];

  return (
    <section aria-labelledby="deployment-state-title" className="rounded-card bg-discord-bg-elevated p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="deployment-state-title" className="text-lg font-medium text-discord-text-primary">Deployment state</h2>
          <p className="mt-1 text-sm text-discord-text-muted">Observed runtime identity, recovery readiness, and release compatibility evidence.</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${healthy ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-300'}`}>
          {healthy ? 'Ready' : 'Action required'}
        </span>
      </div>
      <dl className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {details.map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-input bg-discord-bg-secondary p-3">
            <dt className="text-xs text-discord-text-muted">{label}</dt>
            <dd className="mt-1 break-words font-mono text-sm text-discord-text-secondary" title={label === 'Exact SHA' ? state.identity.exactSha ?? undefined : undefined}>{value}</dd>
          </div>
        ))}
      </dl>
      <details className="mt-5 rounded-input bg-discord-bg-secondary p-3">
        <summary className="cursor-pointer text-sm font-medium text-discord-text-primary">
          Backup and recovery evidence — {state.recovery.status}
        </summary>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          {recoveryDetails.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-discord-text-muted">{label}</dt>
              <dd className="mt-1 break-words font-mono text-sm text-discord-text-secondary">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-sm text-discord-text-muted">
          Backups must be less than 24 hours old.{' '}
          {state.recovery.rehearsalScope === 'database'
            ? 'The verified rehearsal covers the database only; it does not prove a Valkey restore or restore Storage object files.'
            : 'Missing restore evidence or recovery objectives remain unknown.'}
          {' '}Create backups and run isolated recovery rehearsals in Launcher.
        </p>
      </details>
      {!healthy && (
        <p className="mt-4 text-sm text-yellow-300">Review provider health, backup evidence, and recovery readiness below before upgrading or changing deployment state.</p>
      )}
    </section>
  );
}
