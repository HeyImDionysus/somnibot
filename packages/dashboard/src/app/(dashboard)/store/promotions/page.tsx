/**
 * Store / Promotions — DISABLED (Finding 8).
 *
 * This page used to offer full coupon/discount CRUD. Nothing redeemed them.
 *
 * `promotions` is referenced only by this page's CRUD route and by
 * `api/analytics` (display). There is no redemption path anywhere: checkout
 * (`packages/bot/src/features/commerce/payment-handler.ts`) reads
 * `product.price_cents` directly, never touches `promotions`, and never sets
 * `orders.discount_cents`. An operator could publish "SUMMER25" and every
 * customer would still be charged full price.
 *
 * The write surface was also broken end-to-end and had never created a single
 * row: the DB CHECK accepts type IN ('percentage','fixed_amount'), the request
 * schema accepts z.enum(['percent','fixed']), and this page used to send
 * `discount_value` / `starts_at` / `ends_at` where the API expects `value` /
 * `start_date` / `end_date`. Every create failed validation — and the old
 * `save()` ignored the HTTP response and toasted "Promotion created" anyway.
 *
 * Rather than leave a UI that promises a discount the checkout will not honour,
 * the write surface is removed here and refused server-side (POST/PUT → 501).
 * Reading and deleting stay available so nothing is hidden and any legacy row
 * can be cleaned up. Wiring real redemption is a separate, larger change —
 * see the commit message for what it requires.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useToast } from '@/components/shared/toast';
import { TableSkeleton } from '@/components/shared/loading-skeleton';

// ── Types ─────────────────────────────────────────────────

/** Mirrors the actual `promotions` columns, not the old page's invented ones. */
interface Promotion {
  id: string;
  guild_id: string;
  name: string;
  type: string;
  coupon_code: string | null;
  value: number | null;
  max_uses: number | null;
  current_uses: number | null;
  min_purchase_cents: number | null;
  first_purchase_only: boolean;
  start_date: string | null;
  end_date: string | null;
  active: boolean;
  created_at: string;
}

function formatDiscount(type: string, value: number | null): string {
  if (value == null) return '—';
  if (type === 'percentage' || type === 'percent') return `${value}%`;
  if (type === 'fixed_amount' || type === 'fixed') return `$${(value / 100).toFixed(2)}`;
  return String(value);
}

// ── Component ─────────────────────────────────────────────

export default function PromotionsPage() {
  const { toast } = useToast();
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const [promos, setPromos] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/store/promotions');
      const json = await res.json();
      if (json.success) setPromos(json.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const deletePromo = async (id: string) => {
    const res = await fetch(`/api/store/promotions?id=${id}`, { method: 'DELETE' });
    const json = await res.json().catch(() => ({ success: false }));
    toast(
      json.success
        ? { title: 'Promotion deleted', variant: 'success' }
        : { title: 'Could not delete promotion', variant: 'error' },
    );
    load();
  };

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Promotions</h1>
        <p className="text-sm text-discord-text-muted">Coupons and discount codes</p>
      </div>

      {/* The honest notice. This is the whole point of the page right now. */}
      <div className="rounded-card border border-yellow-500/40 bg-yellow-500/10 p-6">
        <h2 className="flex items-center gap-2 text-base font-bold text-yellow-400">
          <span aria-hidden="true">⚠️</span>
          Coupons are not available
        </h2>
        <div className="mt-3 space-y-3 text-sm text-discord-text-secondary">
          <p>
            Creating promotions is turned off because{' '}
            <strong className="text-discord-text-primary">
              nothing in checkout redeems them
            </strong>
            . There is no place for a customer to enter a code, and the store charges the
            product&apos;s full price regardless of any promotion listed here. Leaving the form
            available would let you publish a discount code that quietly never applies — customers
            would be charged full price and would rightly ask for the difference back.
          </p>
          <p>
            This concerns the <strong className="text-discord-text-primary">real-money store</strong>{' '}
            only. It has no effect on the in-server coin economy or its shop.
          </p>
          <p className="text-discord-text-muted">
            Existing rows are listed below so nothing is hidden, and can be deleted. Discount
            redemption has to be built end to end — validated and applied server-side while the
            order price is frozen — before this page comes back.
          </p>
        </div>
      </div>

      {/* Existing rows — read + delete only */}
      {loading ? (
        <TableSkeleton rows={3} />
      ) : promos.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="mb-3 text-4xl" aria-hidden="true">🏷️</div>
          <p className="text-discord-text-muted">No promotions exist.</p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-discord-text-muted">
            Existing rows — not applied at checkout
          </p>
          {promos.map((p) => (
            <div
              key={p.id}
              className="flex flex-col items-stretch gap-3 rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-discord-text-primary [overflow-wrap:anywhere]">{p.name}</span>
                  <span className="rounded-full bg-discord-bg-tertiary px-2 py-0.5 text-xs text-discord-text-muted">
                    never applied
                  </span>
                  {p.coupon_code && (
                    <span className="rounded-full bg-discord-bg-tertiary px-2 py-0.5 font-mono text-xs text-discord-text-secondary">
                      {p.coupon_code}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-discord-text-muted">
                  <span className="font-semibold text-discord-text-secondary">
                    {formatDiscount(p.type, p.value)}
                  </span>
                  <span>{p.current_uses ?? 0}{p.max_uses ? `/${p.max_uses}` : ''} uses</span>
                  {p.end_date && <span>Ends {new Date(p.end_date).toLocaleDateString()}</span>}
                </div>
              </div>
              <button
                onClick={() => setConfirmDelete({ id: p.id, name: p.name })}
                className="w-full rounded-input bg-discord-danger/20 px-3 py-1 text-xs text-discord-danger transition-standard hover:bg-discord-danger/30 sm:w-auto sm:shrink-0"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Promotion"
        description={`Delete "${confirmDelete?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmDelete) {
            await deletePromo(confirmDelete.id);
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
