'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import type { ControlCenterDestination } from '@/lib/dashboard/control-center';

interface SearchPayload {
  readonly data: { readonly destinations: readonly ControlCenterDestination[] };
}

export function GlobalDashboardSearch() {
  const [destinations, setDestinations] = useState<readonly ControlCenterDestination[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void fetch('/api/dashboard/control-center')
      .then(async (response) => {
        if (!response.ok) return;
        const payload: SearchPayload = await response.json();
        setDestinations(payload.data.destinations);
      })
      .catch(() => undefined);
  }, []);

  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (normalized === '') return [];
    return destinations
      .filter((destination) => [
        destination.label,
        destination.description,
        destination.domain,
        ...destination.keywords,
      ].some((value) => value.toLocaleLowerCase().includes(normalized)))
      .slice(0, 8);
  }, [destinations, query]);
  return (
    <div className="relative px-3 pb-2">
      <label htmlFor="sidebar-dashboard-search" className="sr-only">Search authorized dashboard features</label>
      <Search className="pointer-events-none absolute left-6 top-3 text-discord-text-muted" size={15} aria-hidden="true" />
      <input id="sidebar-dashboard-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search dashboard" className="min-h-11 w-full rounded-input border border-discord-border-subtle bg-discord-bg-tertiary py-2 pl-9 pr-3 text-sm text-discord-text-primary placeholder:text-discord-text-muted focus:border-discord-accent focus:outline-none" />
      <span className="sr-only" aria-live="polite">{query === '' ? '' : `${results.length} results`}</span>
      {query !== '' && <div className="absolute left-3 right-3 top-full z-20 max-h-64 overflow-y-auto rounded-card border border-discord-border-strong bg-discord-bg-floating p-1 shadow-lg">{results.length === 0 ? <p className="px-3 py-3 text-xs text-discord-text-muted">No authorized destinations</p> : results.map((result) => <Link key={result.id} href={result.href} onClick={() => setQuery('')} className="block min-h-11 rounded-input px-3 py-2 hover:bg-discord-bg-hover"><span className="block text-sm font-medium text-discord-text-primary">{result.label}</span><span className="block truncate text-xs text-discord-text-muted">{result.domain}</span></Link>)}</div>}
    </div>
  );
}
