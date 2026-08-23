'use client';

import { useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/shared/button';

const graphSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    label: z.string(),
    currentState: z.string(),
    intendedState: z.string(),
  })),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
  revisions: z.object({ product: z.string(), policy: z.string() }),
  operationHistory: z.array(z.object({ operationId: z.string(), action: z.string(), state: z.string() })),
  preview: z.object({ action: z.string(), affectedNodeIds: z.array(z.string()), irreversible: z.array(z.string()) }).nullable(),
  conflicts: z.array(z.object({ id: z.string(), category: z.string(), severity: z.string(), state: z.string(), title: z.string() })),
  evidence: z.object({ orderUpdatedAt: z.string(), entitlementUpdatedAt: z.string().nullable(), checkedAt: z.string() }),
});
type Graph = z.infer<typeof graphSchema>;

export function EntitlementVisualMap({ orderId }: { readonly orderId: string | null }) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (preview: 'refund' | 'revoke' | 'cancel' | null) => {
    if (!orderId) return;
    setLoading(true);
    setError(null);
    try {
      const suffix = preview ? `?preview=${preview}` : '';
      const response = await fetch(`/api/store/entitlement-map/${orderId}${suffix}`);
      const body = await response.json();
      const parsed = graphSchema.safeParse(body.data);
      if (!response.ok || !parsed.success) {
        setError(typeof body.error === 'string' ? body.error : 'Entitlement evidence could not be read.');
      } else {
        setGraph(parsed.data);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Entitlement evidence could not be read.');
    } finally {
      setLoading(false);
    }
  };

  if (!orderId) return null;

  return (
    <section className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5" aria-labelledby="entitlement-map-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="entitlement-map-heading" className="text-lg font-semibold text-discord-text-primary">Entitlement relationship map</h2>
          <p className="mt-1 text-xs text-discord-text-muted">Current versus intended access, policy revisions, failures, operation evidence, and downstream change previews.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void load(null)} disabled={loading}>{loading ? 'Reading…' : 'Read live state'}</Button>
          <Button size="sm" variant="secondary" onClick={() => void load('refund')} disabled={loading}>Preview refund</Button>
          <Button size="sm" variant="secondary" onClick={() => void load('cancel')} disabled={loading}>Preview cancel</Button>
          <Button size="sm" variant="secondary" onClick={() => void load('revoke')} disabled={loading}>Preview revoke</Button>
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-discord-danger" role="alert">{error}</p>}
      {graph && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {graph.nodes.map((node) => {
              const affected = graph.preview?.affectedNodeIds.includes(node.id) ?? false;
              return (
                  <article key={node.id} className={`min-w-0 rounded-input border p-3 ${affected ? 'border-discord-warning bg-discord-warning/10' : node.currentState === node.intendedState ? 'border-discord-success/40 bg-discord-success/5' : 'border-discord-danger/40 bg-discord-danger/5'}`}>
                    <p className="text-[11px] uppercase tracking-wide text-discord-text-muted">{node.kind.replaceAll('_', ' ')}</p>
                    <h3 className="mt-1 text-sm font-medium text-discord-text-primary">{node.label}</h3>
                    <dl className="mt-2 text-xs">
                      <div><dt className="inline text-discord-text-muted">Current: </dt><dd className="inline text-discord-text-secondary">{node.currentState}</dd></div>
                      <div><dt className="inline text-discord-text-muted">Intended: </dt><dd className="inline text-discord-text-secondary">{node.intendedState}</dd></div>
                    </dl>
                  </article>
              );
            })}
          </div>
          <div className="rounded-input bg-discord-bg-primary p-3">
            <h3 className="text-sm font-medium text-discord-text-primary">Relationships</h3>
            <ul className="mt-2 grid gap-1 text-xs text-discord-text-secondary sm:grid-cols-2">
              {graph.edges.map((edge) => {
                const from = graph.nodes.find((node) => node.id === edge.from)?.label ?? edge.from;
                const to = graph.nodes.find((node) => node.id === edge.to)?.label ?? edge.to;
                return <li key={`${edge.from}:${edge.to}`} className="break-words">{from} → {to}</li>;
              })}
            </ul>
          </div>
          {graph.preview && (
            <div className="rounded-input border border-discord-warning/40 bg-discord-warning/10 p-3 text-sm text-discord-text-secondary">
              <strong className="text-discord-text-primary">{graph.preview.action} blast radius:</strong>{' '}
              {graph.preview.affectedNodeIds.length} access nodes change; {graph.preview.irreversible.length} payment record remains immutable.
            </div>
          )}
          {graph.conflicts.length > 0 && (
            <div className="rounded-input border border-discord-danger/40 bg-discord-danger/10 p-3">
              <h3 className="text-sm font-medium text-discord-danger">Conflicts and failures</h3>
              <ul className="mt-2 space-y-1 text-xs text-discord-text-secondary">{graph.conflicts.map((conflict) => <li key={conflict.id}>{conflict.severity}: {conflict.title} ({conflict.state})</li>)}</ul>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-input bg-discord-bg-primary p-3 text-xs text-discord-text-secondary">
              <p>Product revision: <span className="break-all font-mono">{graph.revisions.product}</span></p>
              <p className="mt-1">Policy revision: <span className="break-all font-mono">{graph.revisions.policy}</span></p>
            </div>
            <div className="rounded-input bg-discord-bg-primary p-3 text-xs text-discord-text-secondary">
              <p>Readback: {new Date(graph.evidence.checkedAt).toLocaleString()}</p>
              <p className="mt-1">Operations observed: {graph.operationHistory.length}</p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
