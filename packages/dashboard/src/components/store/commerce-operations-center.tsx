'use client';

import { useState } from 'react';
import { Button } from '@/components/shared/button';
import { EntitlementVisualMap } from './entitlement-visual-map';
import { MerchantExports } from './merchant-exports';
import { ProductLaunchRuns } from './product-launch-runs';
import { RevenueExceptions } from './revenue-exceptions';

export function CommerceOperationsCenter() {
  const [inspectedOrderId, setInspectedOrderId] = useState<string | null>(null);
  const [orderInput, setOrderInput] = useState('');
  return (
    <div className="space-y-6">
      <ProductLaunchRuns />
      <RevenueExceptions onInspectOrder={setInspectedOrderId} />
      <section className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5" aria-labelledby="access-inspector-heading">
        <h2 id="access-inspector-heading" className="text-lg font-semibold text-discord-text-primary">Inspect any order</h2>
        <p className="mt-1 text-xs text-discord-text-muted">Use an order ID from Store orders to inspect healthy access as well as exceptions.</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <label className="min-w-0 flex-1 text-xs text-discord-text-secondary">
            Order ID
            <input value={orderInput} onChange={(event) => setOrderInput(event.target.value)} className="mt-1 w-full rounded-input border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 font-mono text-sm text-discord-text-primary" />
          </label>
          <Button className="sm:self-end" disabled={!orderInput.trim()} onClick={() => setInspectedOrderId(orderInput.trim())}>Open access map</Button>
        </div>
      </section>
      <EntitlementVisualMap orderId={inspectedOrderId} />
      <MerchantExports />
    </div>
  );
}
