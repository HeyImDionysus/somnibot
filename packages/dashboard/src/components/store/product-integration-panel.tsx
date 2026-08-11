'use client';

import * as React from 'react';
import { useState } from 'react';
import { buildLicenseSdkSnippet } from '@/lib/store/commerce-onboarding';
import type { CommerceProductIdentity } from './onboarding-types';

type Props = {
  readonly product: CommerceProductIdentity;
  readonly apiBase: string;
  readonly environment: 'sandbox' | 'live';
  readonly recoveryMessage?: string | null;
  readonly recoveryActionLabel?: string;
  readonly onRetry?: () => void;
};

function CopyValue({ label, value }: { readonly label: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  };
  return (
    <div className="rounded-input border border-discord-border-subtle bg-discord-bg-primary p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-discord-text-muted">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all text-xs text-discord-text-secondary">{value}</code>
        <button type="button" onClick={() => void copy()} className="rounded-input bg-discord-bg-active px-2 py-1 text-xs text-discord-text-primary">{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

export function ProductIntegrationPanel({
  product,
  apiBase,
  environment,
  recoveryMessage,
  recoveryActionLabel = 'Retry setup',
  onRetry,
}: Props) {
  const snippet = buildLicenseSdkSnippet(product, apiBase);
  return (
    <section className="rounded-card border border-discord-accent/40 bg-discord-bg-secondary p-5" aria-labelledby="integration-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="integration-heading" className="text-lg font-semibold text-discord-text-primary">Integrate {product.name}</h2>
          <p className="mt-1 text-sm text-discord-text-secondary">These values came from the saved product readback. Keep the license key customer-entered; never ship one in source code.</p>
        </div>
        <span className="rounded-full bg-discord-bg-primary px-3 py-1 text-xs font-medium text-discord-text-secondary">PayPal {environment}</span>
      </div>
      {recoveryMessage && (
        <div className="mt-4 rounded-input border border-discord-warning/50 bg-discord-warning/10 p-3" role="alert">
          <p className="text-sm font-medium text-discord-text-primary">Product preserved; setup needs a retry</p>
          <p className="mt-1 text-xs text-discord-text-secondary">{recoveryMessage} The saved product is <strong>{product.name}</strong> ({product.id}).</p>
          {onRetry && <button type="button" onClick={onRetry} className="mt-2 rounded-input bg-discord-accent px-3 py-2 text-xs font-medium text-white">{recoveryActionLabel}</button>}
        </div>
      )}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <CopyValue label="Internal product ID" value={product.id} />
        <CopyValue label="PayPal product ID" value={product.paypal_product_id ?? 'Not assigned'} />
        {product.plans?.map((plan) => <CopyValue key={plan.id} label={`${plan.name} — PayPal plan ID`} value={plan.paypal_plan_id ?? 'Not assigned'} />)}
        <CopyValue label="License API base" value={apiBase} />
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold text-discord-text-primary">1. Install the SDK</h3>
          <CopyValue label="npm (published package)" value="npm install @somnibot/license-sdk" />
          <div className="mt-2"><CopyValue label="pnpm (published package)" value="pnpm add @somnibot/license-sdk" /></div>
          <p className="mt-2 text-xs text-discord-text-muted">Developing inside this monorepo? Use <code>pnpm --filter your-app add @somnibot/license-sdk@workspace:*</code>. External creators should use the published-package commands above.</p>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-discord-text-primary">2. Configure and validate</h3>
          <pre className="mt-2 max-h-80 overflow-auto rounded-input bg-discord-bg-floating p-3 text-xs text-discord-text-secondary"><code>{snippet}</code></pre>
          <button type="button" onClick={() => void navigator.clipboard.writeText(snippet)} className="mt-2 rounded-input bg-discord-bg-active px-3 py-2 text-xs text-discord-text-primary">Copy TypeScript example</button>
        </div>
      </div>
      <div className="mt-5 rounded-input border border-discord-border-subtle bg-discord-bg-primary p-4">
        <h3 className="text-sm font-semibold text-discord-text-primary">3. Validate safely in sandbox</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-discord-text-secondary">
          <li>Keep PayPal in Sandbox and create or activate this product and plan.</li>
          <li>Buy through the normal storefront with a PayPal sandbox buyer account.</li>
          <li>Wait for the signed webhook and fulfillment status, then use the delivered customer key in the SDK example.</li>
          <li>Confirm startup validation, a heartbeat, device visibility, and deactivation before considering Live mode.</li>
        </ol>
        <p className="mt-2 text-xs text-discord-warning">The dashboard does not mint an administrator test key: that would bypass purchase and fulfillment authority. Sandbox purchase exercises the supported path without real money.</p>
      </div>
    </section>
  );
}
