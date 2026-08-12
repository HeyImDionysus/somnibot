'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { FileArchive, KeyRound, RefreshCw } from 'lucide-react';
import { Button } from '@/components/shared/button';
import {
  parseLicensingProducts,
  type LicensingProductSummary,
} from '@/lib/store/licensing-products';

export function LicensingProductOverview() {
  const [products, setProducts] = useState<LicensingProductSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadProducts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/store/products');
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error('Store products are unavailable.');
      setProducts(parseLicensingProducts(payload));
    } catch (caught) {
      setProducts([]);
      setError(caught instanceof Error ? caught.message : 'Store products are unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadProducts(); }, [loadProducts]);

  const dynamicCount = products.filter((product) => product.mode === 'dynamic').length;
  const staticCount = products.length - dynamicCount;

  return (
    <section aria-labelledby="product-licensing-heading" className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="product-licensing-heading" className="text-base font-semibold text-discord-text-primary">Product licensing</h2>
          <p className="mt-1 max-w-2xl text-xs text-discord-text-muted">Authoritative Store readback for every saved Static and Dynamic product. Prompt Generator does not create entries here.</p>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={() => void loadProducts()} disabled={loading}>
          <RefreshCw size={14} aria-hidden="true" />Refresh
        </Button>
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-discord-text-muted" role="status">Loading Store products…</p>
      ) : error ? (
        <div className="mt-4 rounded-input border border-discord-danger/40 bg-discord-danger/10 p-3" role="alert">
          <p className="text-sm font-medium text-discord-danger">Product licensing is unavailable</p>
          <p className="mt-1 text-xs text-discord-text-muted">{error} No status was guessed from stale data.</p>
        </div>
      ) : products.length === 0 ? (
        <div className="mt-4 rounded-input border border-discord-border-subtle bg-discord-bg-primary p-4">
          <p className="text-sm font-medium text-discord-text-primary">No saved products</p>
          <p className="mt-1 text-xs text-discord-text-muted">Create the sellable product in Store. Use Prompt Generator separately when you need an implementation contract.</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <Link href="/store" className="rounded-input bg-discord-accent px-3 py-2 font-medium text-white">Open Store</Link>
            <Link href="/project-licensing" className="rounded-input bg-discord-bg-active px-3 py-2 font-medium text-discord-text-primary">Open Prompt Generator</Link>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <div className="rounded-input bg-discord-bg-tertiary p-3"><p className="text-xl font-bold text-discord-text-primary">{dynamicCount}</p><p className="text-xs text-discord-text-muted">Dynamic products</p></div>
            <div className="rounded-input bg-discord-bg-tertiary p-3"><p className="text-xl font-bold text-discord-text-primary">{staticCount}</p><p className="text-xs text-discord-text-muted">Static products</p></div>
          </div>
          <ul className="grid gap-3 lg:grid-cols-2">
            {products.map((product) => (
              <li key={product.id} className="min-w-0 rounded-input border border-discord-border-subtle bg-discord-bg-primary p-4">
                <div className="flex items-start gap-3">
                  <span className="rounded-input bg-discord-bg-tertiary p-2 text-discord-accent">
                    {product.mode === 'dynamic' ? <KeyRound size={18} aria-hidden="true" /> : <FileArchive size={18} aria-hidden="true" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-discord-text-primary">{product.name}</h3>
                      <span className="rounded-full bg-discord-accent/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-discord-accent">{product.mode}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${product.active ? 'bg-discord-success/15 text-discord-success' : 'bg-discord-bg-tertiary text-discord-text-muted'}`}>{product.active ? 'Active' : 'Inactive'}</span>
                    </div>
                    <p className="mt-1 text-xs text-discord-text-muted">{product.billing} · {product.planCount} active plan(s) · {product.discordBenefitCount} Discord benefit(s)</p>
                    {product.mode === 'dynamic' ? (
                      <p className="mt-2 break-words text-xs text-discord-text-secondary">{product.maxInstallations ?? 'Unverified'} installation limit · {product.heartbeatSeconds ?? 'Unverified'}s heartbeat · {product.offlineGraceSeconds ?? 'Unverified'}s offline grace</p>
                    ) : (
                      <p className="mt-2 text-xs text-discord-text-secondary">{product.fileCount} protected master file(s). Downloads require entitlement, buyer-specific derivation, and signed delivery evidence.</p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
