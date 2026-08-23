'use client';

const EXPORTS = [
  ['orders', 'Orders'],
  ['payments', 'Payments'],
  ['refunds', 'Refunds'],
  ['subscriptions', 'Subscriptions'],
  ['fees', 'Provider fees'],
  ['discounts', 'Discounts'],
  ['disputes', 'Disputes'],
  ['free_claims', 'Free claims'],
  ['product_revenue', 'Product revenue'],
  ['entitlements', 'Entitlements'],
  ['reconciliation', 'Reconciliation'],
] as const;

export function MerchantExports() {
  return (
    <section className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5" aria-labelledby="merchant-exports-heading">
      <h2 id="merchant-exports-heading" className="text-lg font-semibold text-discord-text-primary">Merchant exports</h2>
      <p className="mt-1 text-xs text-discord-text-muted">Deterministic CSV files use stable columns and ordering. PayPal payment state and SomniBot entitlement state remain separate datasets.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {EXPORTS.map(([dataset, label]) => (
          <a key={dataset} href={`/api/store/exports/${dataset}`} download className="rounded-input border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-secondary transition-standard hover:bg-discord-bg-hover hover:text-discord-text-primary">
            Export {label}
          </a>
        ))}
      </div>
    </section>
  );
}
