'use client';

import * as React from 'react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/shared/button';
import { buildProductIntegrationGuide } from '@/lib/store/commerce-onboarding';
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
  const guide = buildProductIntegrationGuide(product);
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
      <div className="mt-5 rounded-input border border-discord-border-subtle bg-discord-bg-primary p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-discord-text-primary">{guide.title}</h3>
            <p className="mt-1 text-xs text-discord-text-secondary">{guide.summary}</p>
          </div>
          <span className="rounded-full bg-discord-accent/15 px-3 py-1 text-xs font-medium text-discord-accent">
            {guide.mode === 'dynamic' ? 'Dynamic' : 'Static'}
          </span>
        </div>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-discord-text-secondary">
          {guide.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <p className="mt-4 text-xs text-discord-text-muted">
          Generate the final implementation contract from this authoritative saved product and license policy. The generator reads these values but never changes them.
        </p>
        <Link href={`/project-licensing?productId=${encodeURIComponent(product.id)}`} className="mt-2 inline-flex h-8 items-center rounded-input bg-discord-bg-active px-3 text-xs font-medium text-discord-text-primary hover:bg-discord-border-strong">
          Open Prompt Generator
        </Link>
      </div>
      <div className="mt-5 rounded-input border border-discord-border-subtle bg-discord-bg-primary p-4">
        <h3 className="text-sm font-semibold text-discord-text-primary">Validate safely in sandbox</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-discord-text-secondary">
          {product.type === 'free' ? (
            <li>Claim the product through the normal free storefront path. PayPal is not required.</li>
          ) : (
            <>
              <li>Keep PayPal in Sandbox and activate this product and plan.</li>
              <li>Buy through the normal storefront with a PayPal sandbox buyer account.</li>
              <li>Wait for the signed webhook and confirm the delivery described above.</li>
            </>
          )}
          {guide.mode === 'dynamic'
            ? <li>Use the delivered customer key to confirm validation, heartbeat, device visibility, revocation, and deactivation.</li>
            : <li>Confirm the buyer-specific derivative, signed manifest, single-use download, and future-access revocation.</li>}
        </ol>
        {guide.mode === 'dynamic' ? (
          <p className="mt-2 text-xs text-discord-warning">The dashboard does not mint an administrator test key: that would bypass purchase and fulfillment authority. Sandbox purchase exercises the supported path without real money.</p>
        ) : (
          <p className="mt-2 text-xs text-discord-warning">Static revocation blocks future delivery but cannot erase a copy already downloaded. Watermarking supports attribution; it is not a remote-delete promise.</p>
        )}
      </div>
    </section>
  );
}
