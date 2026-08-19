'use client';

import { FolderOpen, KeyRound } from 'lucide-react';

import { Badge } from '@/components/shared/badge';
import { Button } from '@/components/shared/button';

interface StoreProductCardProduct {
  readonly id: string;
  readonly name: string;
  readonly type: 'one_time' | 'subscription' | 'free';
  readonly delivery_type: 'file' | 'link' | 'access_pass' | 'license_key' | 'mixed';
  readonly price_cents: number;
  readonly currency: string;
  readonly granted_role_ids: readonly string[];
  readonly active: boolean;
  readonly plans?: readonly unknown[];
}

interface StoreProductCardActions {
  readonly onToggleActive: () => void;
  readonly onOpenFiles: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}

interface StoreProductCardProps {
  readonly product: StoreProductCardProduct;
  readonly licensed: boolean;
  readonly activationLocked: boolean;
  readonly actions: StoreProductCardActions;
}

const productTypeBadges = {
  one_time: { label: 'One-Time', variant: 'info' },
  subscription: { label: 'Subscription', variant: 'pink' },
  free: { label: 'Free', variant: 'success' },
} as const;

const deliveryTypeLabels: Record<StoreProductCardProduct['delivery_type'], string> = {
  license_key: 'Dynamic',
  file: 'Static',
  link: 'Link',
  access_pass: 'Access Pass',
  mixed: 'Mixed',
};

function formatPrice(cents: number, currency: string): string {
  return cents === 0 ? 'Free' : `$${(cents / 100).toFixed(2)} ${currency}`;
}

export function StoreProductCard({
  product,
  licensed,
  activationLocked,
  actions,
}: StoreProductCardProps) {
  const headingId = `store-product-${product.id}`;
  const typeBadge = productTypeBadges[product.type];

  return (
    <article
      aria-labelledby={headingId}
      className="grid gap-4 rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-2 h-2 w-2 shrink-0 rounded-full ${product.active ? 'bg-discord-success' : 'bg-discord-text-muted'}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2
              id={headingId}
              className="min-w-0 text-sm font-medium text-discord-text-primary [overflow-wrap:anywhere]"
            >
              {product.name}
            </h2>
            <Badge variant={typeBadge.variant}>{typeBadge.label}</Badge>
            <span className="text-xs text-discord-text-muted">
              {deliveryTypeLabels[product.delivery_type]}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-discord-text-muted">
            <span className="font-semibold text-discord-text-secondary">
              {formatPrice(product.price_cents, product.currency)}
            </span>
            {product.granted_role_ids.length > 0 && (
              <span>{product.granted_role_ids.length} role(s)</span>
            )}
            {product.plans && product.plans.length > 0 && (
              <span>{product.plans.length} plan(s)</span>
            )}
            {licensed && (
              <span className="inline-flex items-center gap-1">
                <KeyRound aria-hidden="true" className="h-3.5 w-3.5 text-discord-warning" />
                Licensed
              </span>
            )}
          </div>
        </div>
      </div>

      <div
        aria-label={`${product.name} actions`}
        className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end"
        role="group"
      >
        <Button
          className="w-full sm:w-auto"
          size="sm"
          variant={product.active ? 'success' : 'secondary'}
          onClick={actions.onToggleActive}
          disabled={activationLocked}
          title={activationLocked ? 'Retry and verify the requested license policy before activation' : undefined}
        >
          {product.active ? 'Active' : 'Inactive'}
        </Button>
        <Button
          className="w-full sm:w-auto"
          size="sm"
          variant="secondary"
          onClick={actions.onOpenFiles}
        >
          <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
          Files
        </Button>
        <Button
          className="w-full sm:w-auto"
          size="sm"
          variant="secondary"
          onClick={actions.onEdit}
        >
          Edit
        </Button>
        <Button
          className="w-full sm:w-auto"
          size="sm"
          variant="danger"
          onClick={actions.onDelete}
        >
          Delete
        </Button>
      </div>
    </article>
  );
}
