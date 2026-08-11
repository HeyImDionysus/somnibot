'use client';

import * as React from 'react';
import { useState } from 'react';
import { Button } from '@/components/shared/button';
import { Select } from '@/components/shared/input';
import {
  buildLicenseSdkSnippet,
  buildProductIntegrationGuide,
} from '@/lib/store/commerce-onboarding';
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
        <Button type="button" variant="secondary" size="sm" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
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
  const guide = buildProductIntegrationGuide(product);
  const [runtimePath, setRuntimePath] = useState<'node' | 'browser' | 'native'>('node');
  const selectedRuntime = guide.runtimePaths.find((path) => path.id === runtimePath);
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
          {onRetry && <Button type="button" size="sm" onClick={onRetry} className="mt-2">{recoveryActionLabel}</Button>}
        </div>
      )}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <CopyValue label="Internal product ID" value={product.id} />
        <CopyValue label="PayPal product ID" value={product.paypal_product_id ?? 'Not assigned'} />
        {product.plans?.map((plan) => <CopyValue key={plan.id} label={`${plan.name} — PayPal plan ID`} value={plan.paypal_plan_id ?? 'Not assigned'} />)}
        <CopyValue label="License API base" value={apiBase} />
      </div>
      {guide.kind === 'license' ? (
        <div className="mt-5 space-y-4">
          <Select
            id="license-runtime-path"
            label="Project type or runtime"
            value={runtimePath}
            onChange={(event) => setRuntimePath(event.target.value === 'browser' ? 'browser' : event.target.value === 'native' ? 'native' : 'node')}
            options={guide.runtimePaths.map((path) => ({ value: path.id, label: path.label }))}
          />
          {selectedRuntime?.sameOriginOnly && (
            <p className="rounded-input border border-discord-warning/50 bg-discord-warning/10 p-3 text-xs text-discord-text-secondary" role="status">
              Browser/PWA use is supported only when the app is served from the same origin as this dashboard. Cross-origin browser calls are not supported until an owner configures a product-scoped allowed-origin policy. Do not embed a license key in shipped JavaScript.
            </p>
          )}
          {runtimePath === 'native' ? (
            <div className="rounded-input border border-discord-border-subtle bg-discord-bg-primary p-4">
              <h3 className="text-sm font-semibold text-discord-text-primary">Use the JSON REST lifecycle</h3>
              <p className="mt-1 text-xs text-discord-text-secondary">POST to <code>{apiBase}/license/validate</code>, then heartbeat the returned session and deactivate it on shutdown. Use request timeouts and treat the customer key as a secret.</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <CopyValue label="Validate" value={`${apiBase}/license/validate`} />
                <CopyValue label="Heartbeat" value={`${apiBase}/license/heartbeat`} />
                <CopyValue label="Deactivate" value={`${apiBase}/license/deactivate`} />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {guide.nativeExamples.map((example) => (
                  <a key={example.language} href={example.href} target="_blank" rel="noreferrer" className="rounded-input bg-discord-bg-active px-3 py-2 text-xs font-medium text-discord-text-primary hover:text-white">
                    {example.language} example
                  </a>
                ))}
              </div>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold text-discord-text-primary">1. Install the TypeScript SDK</h3>
                <CopyValue label="npm (published package)" value="npm install @somnibot/license-sdk" />
                <div className="mt-2"><CopyValue label="pnpm (published package)" value="pnpm add @somnibot/license-sdk" /></div>
                <p className="mt-2 text-xs text-discord-text-muted">Inside this monorepo, use <code>pnpm --filter your-app add @somnibot/license-sdk@workspace:*</code>. External projects use the published package.</p>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-discord-text-primary">2. Configure the SDK</h3>
                <pre className="mt-2 max-h-80 overflow-auto rounded-input bg-discord-bg-floating p-3 text-xs text-discord-text-secondary"><code>{snippet}</code></pre>
                <Button type="button" variant="secondary" size="sm" onClick={() => void navigator.clipboard.writeText(snippet)} className="mt-2">Copy TypeScript example</Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-5 rounded-input border border-discord-border-subtle bg-discord-bg-primary p-4">
          <h3 className="text-sm font-semibold text-discord-text-primary">Fulfill {product.name}</h3>
          <p className="mt-1 text-xs text-discord-text-secondary">{guide.summary}</p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-discord-text-secondary">
            {guide.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </div>
      )}
      <div className="mt-5 rounded-input border border-discord-border-subtle bg-discord-bg-primary p-4">
        <h3 className="text-sm font-semibold text-discord-text-primary">Validate safely in sandbox</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-discord-text-secondary">
          <li>Keep PayPal in Sandbox and create or activate this product and plan.</li>
          <li>Buy through the normal storefront with a PayPal sandbox buyer account.</li>
          <li>Wait for the signed webhook and confirm the delivery described above.</li>
          {guide.kind === 'license' && <li>Use the delivered customer key to confirm validation, heartbeat, device visibility, and deactivation.</li>}
        </ol>
        {guide.kind === 'license' ? (
          <p className="mt-2 text-xs text-discord-warning">The dashboard does not mint an administrator test key: that would bypass purchase and fulfillment authority. Sandbox purchase exercises the supported path without real money.</p>
        ) : (
          <p className="mt-2 text-xs text-discord-warning">This delivery type does not issue a license key. Validate the configured download or Discord entitlement through the normal sandbox purchase path.</p>
        )}
      </div>
    </section>
  );
}
