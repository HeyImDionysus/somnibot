'use client';

import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/shared/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { LAUNCH_STAGE_KEYS } from '@/lib/store/commerce-operations';

const productSchema = z.object({ id: z.string().uuid(), name: z.string(), active: z.boolean() });
const runSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  is_tutorial: z.boolean(),
  tutorial_visibility: z.enum(['visible', 'hidden', 'disabled']),
  environment: z.enum(['sandbox', 'live']),
  state: z.enum(['draft', 'validating', 'sandbox_verifying', 'ready', 'live', 'failed', 'retired']),
  stages: z.record(z.enum(['pending', 'verified', 'failed', 'not_applicable'])),
  launch_receipt_hash: z.string().nullable(),
  version: z.number().int().positive(),
  products: z.object({ name: z.string(), active: z.boolean() }).nullable(),
});
type Product = z.infer<typeof productSchema>;
type LaunchRun = z.infer<typeof runSchema>;

export function ProductLaunchRuns() {
  const [products, setProducts] = useState<Product[]>([]);
  const [runs, setRuns] = useState<LaunchRun[]>([]);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<LaunchRun | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [productResponse, runResponse] = await Promise.all([
        fetch('/api/store/products'),
        fetch('/api/store/launch-runs'),
      ]);
      const [productBody, runBody] = await Promise.all([productResponse.json(), runResponse.json()]);
      const parsedProducts = z.array(productSchema).safeParse(productBody.data);
      const parsedRuns = z.array(runSchema).safeParse(runBody.data);
      if (!productResponse.ok || !runResponse.ok || !parsedProducts.success || !parsedRuns.success) {
        setError('Product launch state could not be verified.');
        return;
      }
      setProducts(parsedProducts.data);
      setRuns(parsedRuns.data);
      setSelectedProductId((current) => current || parsedProducts.data[0]?.id || '');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Product launch state could not be verified.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const start = async () => {
    if (!selectedProductId) return;
    setBusy('start');
    setError(null);
    try {
      const response = await fetch('/api/store/launch-runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', productId: selectedProductId, tutorial: false }),
      });
      const body = await response.json();
      if (!response.ok) setError(typeof body.error === 'string' ? body.error : 'The launch run could not be started.');
      else await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The launch run could not be started.');
    } finally {
      setBusy(null);
    }
  };

  const createTutorial = async () => {
    setBusy('tutorial');
    setError(null);
    try {
      const response = await fetch('/api/store/launch-runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create_tutorial' }),
      });
      const body = await response.json();
      if (!response.ok) setError(typeof body.error === 'string' ? body.error : 'The tutorial product could not be created.');
      else await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The tutorial product could not be created.');
    } finally {
      setBusy(null);
    }
  };

  const act = async (run: LaunchRun, action: 'restart' | 'hide' | 'disable' | 'remove') => {
    setBusy(run.id);
    setError(null);
    try {
      const response = await fetch('/api/store/launch-runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, runId: run.id, version: run.version }),
      });
      const body = await response.json();
      if (!response.ok) setError(typeof body.error === 'string' ? body.error : 'The launch run could not be updated.');
      else await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The launch run could not be updated.');
    } finally {
      setBusy(null);
    }
  };

  const verify = async (run: LaunchRun) => {
    setBusy(run.id);
    setError(null);
    try {
      const response = await fetch(`/api/store/launch-runs/${run.id}/verify`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) setError(typeof body.error === 'string' ? body.error : 'Live launch evidence could not be read.');
      else await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Live launch evidence could not be read.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5" aria-labelledby="product-launch-heading">
      <h2 id="product-launch-heading" className="text-lg font-semibold text-discord-text-primary">Product Launch Runs</h2>
      <p className="mt-1 text-xs text-discord-text-muted">
        Products remain inactive while SomniBot reads back policy, Sandbox payment, signed webhook, entitlement, fulfillment, refund, cancellation, and revocation evidence.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
        <label className="text-sm text-discord-text-secondary">
          Existing product
          <select value={selectedProductId} onChange={(event) => setSelectedProductId(event.target.value)} className="mt-1 block w-full rounded-input border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-discord-text-primary">
            {products.map((product) => <option key={product.id} value={product.id}>{product.name}{product.active ? ' · deactivate before launch testing' : ''}</option>)}
          </select>
        </label>
        <Button onClick={() => void start()} disabled={!selectedProductId || busy !== null}>{busy === 'start' ? 'Starting…' : 'Start run'}</Button>
        <Button variant="secondary" onClick={() => void createTutorial()} disabled={busy !== null}>{busy === 'tutorial' ? 'Creating…' : 'Create tutorial product'}</Button>
      </div>
      {error && <p className="mt-3 text-sm text-discord-danger" role="alert">{error}</p>}
      <div className="mt-4 space-y-3">
        {runs.map((run) => (
          <article key={run.id} className="rounded-input border border-discord-border-subtle bg-discord-bg-primary p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-medium text-discord-text-primary">{run.products?.name ?? 'Unknown product'}{run.is_tutorial ? ' · tutorial' : ''}</h3>
                <p className="text-xs text-discord-text-muted">{run.state} · {run.environment} · {run.tutorial_visibility}</p>
                {run.is_tutorial && (
                  <p className="mt-2 max-w-2xl text-xs text-discord-text-secondary">
                    Follow the stages below to review pricing, fulfillment, entitlements, SDK handoff, a sandbox claim or purchase, signed webhook evidence, cancellation, refund, revocation, and the final launch receipt. It never accepts live money until you complete the run and activate it.
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void verify(run)} disabled={busy !== null}>Verify live records</Button>
                <Button size="sm" variant="secondary" onClick={() => void act(run, 'restart')} disabled={busy !== null}>Restart</Button>
                {run.tutorial_visibility === 'visible' && <Button size="sm" variant="ghost" onClick={() => void act(run, 'hide')} disabled={busy !== null}>Hide</Button>}
                <Button size="sm" variant="ghost" onClick={() => void act(run, 'disable')} disabled={busy !== null}>Disable</Button>
                <Button size="sm" variant="danger" onClick={() => setRemoveTarget(run)} disabled={busy !== null}>Remove</Button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {LAUNCH_STAGE_KEYS.map((stage) => (
                <span key={stage} className={`rounded-full px-2 py-1 text-[11px] ${run.stages[stage] === 'verified' || run.stages[stage] === 'not_applicable' ? 'bg-discord-success/15 text-discord-success' : run.stages[stage] === 'failed' ? 'bg-discord-danger/15 text-discord-danger' : 'bg-discord-warning/15 text-discord-warning'}`}>
                  {stage.replaceAll('_', ' ')}: {run.stages[stage] ?? 'pending'}
                </span>
              ))}
            </div>
            {run.launch_receipt_hash && <p className="mt-3 break-all font-mono text-[11px] text-discord-text-muted">Receipt {run.launch_receipt_hash}</p>}
          </article>
        ))}
      </div>
      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove Product Launch Run?"
        description="This removes the launch evidence and tutorial state, but keeps the Store product inactive and intact. You can start the run again later."
        confirmLabel="Remove launch run"
        variant="danger"
        onConfirm={() => { if (removeTarget) void act(removeTarget, 'remove'); setRemoveTarget(null); }}
        onCancel={() => setRemoveTarget(null)}
      />
    </section>
  );
}
