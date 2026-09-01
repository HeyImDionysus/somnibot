'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Search, Server, Wrench } from 'lucide-react';
import { AdoptionMap } from './adoption-map';
import { type AttentionDefinition, type AttentionView, type ControlCenterDestination, type ControlCenterSearchResult } from '@/lib/dashboard/control-center';

interface ControlCenterPayload {
  readonly success: true;
  readonly data: {
    readonly guild: { readonly id: string; readonly name: string; readonly setup_completed: boolean } | null;
    readonly attentionViews: readonly { readonly id: AttentionView; readonly items: readonly AttentionDefinition[] }[];
    readonly destinations: readonly ControlCenterDestination[];
    readonly searchResults: readonly ControlCenterSearchResult[];
    readonly searchDegraded: boolean;
    readonly canManageAdoption: boolean;
    readonly deployment: {
      readonly version: string;
      readonly exactSha: string | null;
      readonly bootId: string | null;
      readonly snapshotAt: string | null;
    };
  };
}

const VIEW_LABEL: Record<AttentionView, string> = {
  owner: 'Owner',
  administrator: 'Administrator',
  moderator: 'Moderator',
  finance: 'Finance',
  support: 'Support',
};

export function DashboardControlCenter() {
  const [payload, setPayload] = useState<ControlCenterPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AttentionView | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void fetch('/api/dashboard/control-center')
      .then(async (response) => {
        if (!response.ok) throw new Error('control-center-unavailable');
        const result: ControlCenterPayload = await response.json();
        setPayload(result);
        setActiveView(result.data.attentionViews[0]?.id ?? null);
      })
      .catch(() => setError('Control-center context could not be loaded. Open Diagnostics or retry.'));
  }, []);

  useEffect(() => {
    if (query.trim() === '') {
      setSearchError(null);
      return;
    }
    const controller = new AbortController();
    setSearchError(null);
    void fetch(`/api/dashboard/control-center?q=${encodeURIComponent(query)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('dashboard-search-unavailable');
        const result: ControlCenterPayload = await response.json();
        setPayload((current) => current ? { ...current, data: { ...current.data, searchResults: result.data.searchResults, searchDegraded: result.data.searchDegraded } } : current);
      })
      .catch((searchError: unknown) => {
        if (searchError instanceof DOMException && searchError.name === 'AbortError') return;
        setSearchError('Dynamic search is temporarily unavailable. Navigation and authorized route results remain available.');
      });
    return () => controller.abort();
  }, [query]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  const results = query.trim() === '' ? [] : payload?.data.searchResults ?? [];
  const attention = payload?.data.attentionViews.find((view) => view.id === activeView)?.items ?? [];

  if (error) {
    return (
      <section aria-label="Dashboard control center" className="rounded-card border border-discord-danger/40 bg-discord-danger/10 p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 shrink-0 text-discord-danger" size={20} aria-hidden="true" />
          <div>
            <h2 className="font-medium text-discord-text-primary">Control-center data unavailable</h2>
            <p className="mt-1 text-sm text-discord-text-secondary">{error}</p>
            <button type="button" onClick={() => window.location.reload()} className="mt-3 min-h-11 text-sm font-medium text-discord-accent hover:underline">Retry dashboard</button>
          </div>
        </div>
      </section>
    );
  }

  if (!payload) {
    return <section aria-label="Dashboard control center loading" className="h-48 animate-pulse rounded-card bg-discord-bg-elevated motion-reduce:animate-none" />;
  }

  const deployment = payload.data.deployment;
  return (
    <section aria-labelledby="control-center-heading" className="space-y-5">
      <div className="rounded-panel bg-discord-bg-elevated p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-discord-text-muted">Selected server</p>
            <h2 id="control-center-heading" className="mt-1 text-xl font-semibold text-discord-text-primary">
              {payload.data.guild?.name ?? 'Server unavailable'} control center
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-discord-text-secondary">Attention, configuration, staff work, commerce, and readiness stay organized in this dashboard.</p>
          </div>
          <dl className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-2 text-xs sm:grid-cols-4 lg:grid-cols-2">
            <div><dt className="text-discord-text-muted">Version</dt><dd className="truncate text-discord-text-primary">{deployment.version}</dd></div>
            <div><dt className="text-discord-text-muted">Exact SHA</dt><dd className="truncate font-mono text-discord-text-primary" title={deployment.exactSha ?? 'Not reported'}>{deployment.exactSha?.slice(0, 12) ?? 'Not reported'}</dd></div>
            <div><dt className="text-discord-text-muted">Boot</dt><dd className="truncate font-mono text-discord-text-primary" title={deployment.bootId ?? 'Not observed'}>{deployment.bootId?.slice(0, 12) ?? 'Not observed'}</dd></div>
            <div><dt className="text-discord-text-muted">Observed</dt><dd className="text-discord-text-primary">{deployment.snapshotAt ? new Date(deployment.snapshotAt).toLocaleString() : 'No snapshot'}</dd></div>
          </dl>
        </div>

        <div className="relative mt-5">
          <label htmlFor="dashboard-global-search" className="mb-1 block text-sm font-medium text-discord-text-primary">Search this dashboard</label>
          <Search className="pointer-events-none absolute bottom-3 left-3 text-discord-text-muted" size={18} aria-hidden="true" />
          <input ref={searchRef} id="dashboard-global-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search features, settings, staff work, or recovery" className="min-h-11 w-full rounded-input border border-discord-border-strong bg-discord-bg-primary py-2 pl-10 pr-14 text-sm text-discord-text-primary placeholder:text-discord-text-muted focus:border-discord-accent focus:outline-none" />
          <span className="pointer-events-none absolute bottom-3 right-3 text-xs text-discord-text-muted" aria-hidden="true">/</span>
        </div>
        <p className="sr-only" aria-live="polite">{query === '' ? '' : `${results.length} authorized results`}</p>
        {searchError && <p role="status" className="mt-2 text-xs text-discord-warning">{searchError}</p>}
        {query !== '' && (
          <div className="mt-2 max-h-72 overflow-y-auto rounded-card border border-discord-border-subtle bg-discord-bg-floating p-2">
            {results.length === 0 ? <p className="px-3 py-4 text-sm text-discord-text-muted">No authorized dashboard records match that search.</p> : results.map((result) => (
              <Link key={`${result.kind}:${result.id}`} href={result.href} className="flex min-h-11 items-center gap-3 rounded-input px-3 py-2 hover:bg-discord-bg-hover">
                <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-discord-text-primary">{result.label}</span><span className="block truncate text-xs text-discord-text-muted">{result.kind.replace('_', ' ')} · {result.description}</span></span>
                <ArrowRight size={16} className="shrink-0 text-discord-text-muted" aria-hidden="true" />
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)]">
        <section aria-labelledby="attention-heading" className="rounded-card bg-discord-bg-elevated p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div><h3 id="attention-heading" className="font-medium text-discord-text-primary">Current attention</h3><p className="mt-1 text-xs text-discord-text-muted">Organized for your authorized staff responsibilities.</p></div>
            {payload.data.attentionViews.length > 1 && <label className="text-xs text-discord-text-muted">View<select value={activeView ?? ''} onChange={(event) => { const nextView = payload.data.attentionViews.find((view) => view.id === event.target.value); if (nextView) setActiveView(nextView.id); }} className="ml-2 min-h-11 rounded-input border border-discord-border-strong bg-discord-bg-primary px-3 text-sm text-discord-text-primary">{payload.data.attentionViews.map((view) => <option key={view.id} value={view.id}>{VIEW_LABEL[view.id]}</option>)}</select></label>}
          </div>
          <div className="mt-4 divide-y divide-discord-border-subtle">{attention.length === 0 ? <p className="py-4 text-sm text-discord-text-muted">No attention destinations are available for this role. Use search to open authorized settings.</p> : attention.map((item) => <Link key={item.id} href={item.href} className="flex min-h-16 items-center gap-3 py-3"><Wrench size={18} className={item.priority === 'critical' ? 'text-discord-danger' : item.priority === 'high' ? 'text-discord-warning' : 'text-discord-accent'} aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-discord-text-primary">{item.label}</span><span className="block text-xs text-discord-text-muted">{item.description}</span></span><ArrowRight size={16} className="shrink-0 text-discord-text-muted" aria-hidden="true" /></Link>)}</div>
        </section>
        <aside aria-label="Guild context" className="rounded-card bg-discord-bg-elevated p-5"><Server size={20} className="text-discord-accent" aria-hidden="true" /><h3 className="mt-3 font-medium text-discord-text-primary">Guild context</h3><p className="mt-1 text-sm text-discord-text-secondary">{payload.data.guild?.setup_completed ? 'Initial setup is recorded. Use the adoption map to verify each independent feature track.' : 'Core setup remains incomplete. Other tracks show their dependency blocks without hiding optional work.'}</p></aside>
      </div>

      <AdoptionMap canManage={payload.data.canManageAdoption} />
    </section>
  );
}
