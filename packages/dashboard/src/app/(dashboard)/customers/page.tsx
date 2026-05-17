/**
 * Customers — Customer management dashboard page.
 *
 * Architecture doc §31.4 — Customer management.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────

interface Customer {
  id: string;
  guild_id: string;
  discord_id: string;
  discord_username: string;
  paypal_customer_id: string | null;
  email: string | null;
  first_purchase_at: string | null;
  total_spent_cents: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface CustomerDetail extends Customer {
  orders: Array<{
    id: string;
    order_number: string;
    status: string;
    amount_cents: number;
    currency: string;
    created_at: string;
    products: { name: string } | null;
  }>;
  entitlements: Array<{
    id: string;
    product_id: string;
    status: string;
    type: string;
    created_at: string;
    expires_at: string | null;
    products: { name: string } | null;
  }>;
}

// ── Helpers ───────────────────────────────────────────────

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function statusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-discord-success/20 text-discord-success';
    case 'expired':
    case 'cancelled':
      return 'bg-discord-danger/20 text-discord-danger';
    case 'pending':
      return 'bg-yellow-500/20 text-yellow-400';
    case 'grace_period':
    case 'suspended':
      return 'bg-orange-500/20 text-orange-400';
    default:
      return 'bg-discord-bg-tertiary text-discord-text-muted';
  }
}

// ── Component ─────────────────────────────────────────────

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      const res = await fetch(`/api/customers?${params}`);
      const json = await res.json();
      if (json.success) {
        setCustomers(json.data);
        setTotal(json.total);
      }
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => { load(); }, [load]);

  const loadDetail = async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/customers/${id}`);
      const json = await res.json();
      if (json.success) setDetail(json.data);
    } finally {
      setDetailLoading(false);
    }
  };

  // Stats
  const totalSpent = customers.reduce((sum, c) => sum + c.total_spent_cents, 0);
  const withEmail = customers.filter((c) => c.email).length;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Customers</h1>
        <p className="text-sm text-discord-text-muted">View and manage your customer base</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: 'Total Customers', value: total },
          { label: 'Total Revenue', value: formatPrice(totalSpent) },
          { label: 'With Email', value: withEmail },
          { label: 'Avg Spend', value: customers.length ? formatPrice(Math.round(totalSpent / customers.length)) : '$0.00' },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 text-center"
          >
            <p className="text-2xl font-bold text-discord-text-primary">{s.value}</p>
            <p className="text-xs text-discord-text-muted">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Search */}
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by username, Discord ID, or email…"
        className="rounded-input bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none border border-discord-border-subtle w-full max-w-md"
      />

      <div className="flex gap-6">
        {/* Customer List */}
        <div className="flex-1 space-y-2">
          {loading ? (
            <div className="text-center py-12 text-discord-text-muted">Loading customers…</div>
          ) : customers.length === 0 ? (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
              <div className="text-4xl mb-3">👤</div>
              <p className="text-discord-text-muted">No customers found.</p>
            </div>
          ) : (
            customers.map((c) => (
              <button
                key={c.id}
                onClick={() => loadDetail(c.id)}
                className={`w-full text-left flex items-center justify-between rounded-card border p-4 transition-standard ${
                  selectedId === c.id
                    ? 'border-[#FF1493] bg-discord-bg-secondary'
                    : 'border-discord-border-subtle bg-discord-bg-secondary hover:border-discord-border-subtle/80'
                }`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-discord-text-primary">
                      {c.discord_username}
                    </span>
                    <span className="text-xs text-discord-text-muted">
                      {c.discord_id}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-discord-text-muted">
                    {c.email ?? 'No email'} • Joined {formatDate(c.created_at)}
                  </div>
                </div>
                <div className="text-right">
                  <span className="font-semibold text-discord-text-primary">
                    {formatPrice(c.total_spent_cents)}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Detail Panel */}
        {selectedId && (
          <div className="w-96 shrink-0 rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
            {detailLoading ? (
              <div className="text-center py-8 text-discord-text-muted">Loading…</div>
            ) : detail ? (
              <div className="space-y-4">
                <div>
                  <h2 className="text-lg font-bold text-discord-text-primary">
                    {detail.discord_username}
                  </h2>
                  <p className="text-xs text-discord-text-muted">ID: {detail.discord_id}</p>
                  {detail.email && (
                    <p className="text-xs text-discord-text-muted">Email: {detail.email}</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-input bg-discord-bg-tertiary p-2 text-center">
                    <p className="text-sm font-bold text-discord-text-primary">
                      {formatPrice(detail.total_spent_cents)}
                    </p>
                    <p className="text-xs text-discord-text-muted">Total Spent</p>
                  </div>
                  <div className="rounded-input bg-discord-bg-tertiary p-2 text-center">
                    <p className="text-sm font-bold text-discord-text-primary">
                      {detail.orders?.length ?? 0}
                    </p>
                    <p className="text-xs text-discord-text-muted">Orders</p>
                  </div>
                </div>

                {/* Entitlements */}
                <div>
                  <h3 className="text-sm font-semibold text-discord-text-secondary mb-2">
                    Entitlements ({detail.entitlements?.length ?? 0})
                  </h3>
                  {detail.entitlements?.map((e) => (
                    <div
                      key={e.id}
                      className="mb-2 rounded-input bg-discord-bg-tertiary p-2 flex items-center justify-between"
                    >
                      <div>
                        <span className="text-sm text-discord-text-primary">
                          {e.products?.name ?? 'Unknown'}
                        </span>
                        <p className="text-xs text-discord-text-muted">
                          {e.type} • {e.expires_at ? `Expires ${formatDate(e.expires_at)}` : 'No expiry'}
                        </p>
                      </div>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${statusColor(e.status)}`}>
                        {e.status}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Recent Orders */}
                <div>
                  <h3 className="text-sm font-semibold text-discord-text-secondary mb-2">
                    Recent Orders
                  </h3>
                  {detail.orders?.slice(0, 5).map((o) => (
                    <div
                      key={o.id}
                      className="mb-2 rounded-input bg-discord-bg-tertiary p-2 flex items-center justify-between"
                    >
                      <div>
                        <span className="text-sm font-mono text-discord-text-primary">
                          {o.order_number}
                        </span>
                        <p className="text-xs text-discord-text-muted">
                          {o.products?.name ?? 'Unknown'} • {formatDate(o.created_at)}
                        </p>
                      </div>
                      <span className="text-sm text-discord-text-primary">
                        {formatPrice(o.amount_cents)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
