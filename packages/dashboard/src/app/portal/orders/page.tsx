/**
 * Customer Portal — Order history.
 */
'use client';

import { useEffect, useState } from 'react';

interface Payment {
  id: string;
  amount_cents: number;
  currency: string;
  status: string;
  provider: string;
  created_at: string;
}

interface Order {
  id: string;
  order_number: string;
  amount_cents: number;
  discount_cents: number;
  currency: string;
  status: string;
  source: string;
  created_at: string;
  products: { name: string; type: string } | null;
  payments: Payment[];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatPrice(cents: number, currency: string = 'USD'): string {
  return `$${(cents / 100).toFixed(2)} ${currency}`;
}

const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-discord-success/20 text-discord-success',
  pending: 'bg-yellow-500/20 text-yellow-400',
  refunded: 'bg-red-500/20 text-red-400',
  cancelled: 'bg-discord-bg-tertiary text-discord-text-muted',
};

export default function PortalOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const token = localStorage.getItem('portal_token');
      // V11 Re-Audit UX-1: Redirect to portal login if no token.
      if (!token) {
        window.location.href = '/portal';
        return;
      }
      try {
        const res = await fetch('/api/portal/orders', { headers: { 'x-portal-token': token } });
        if (res.status === 401) {
          localStorage.removeItem('portal_token');
          window.location.href = '/portal';
          return;
        }
        const json = await res.json();
        if (json.success) setOrders(json.data);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-discord-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Order History</h1>
        <p className="mt-1 text-sm text-discord-text-muted">View your past purchases and payment details.</p>
      </div>

      {orders.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">🧾</div>
          <p className="text-discord-text-muted">No orders yet.</p>
        </div>
      ) : (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-discord-border-subtle text-xs text-discord-text-muted">
                <th className="px-4 py-3 text-left font-medium">Order</th>
                <th className="px-4 py-3 text-left font-medium">Product</th>
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-center font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-discord-border-subtle">
              {orders.map((order) => (
                <tr key={order.id} className="hover:bg-discord-bg-tertiary/30 transition-colors">
                  <td className="px-4 py-3">
                    <span className="text-sm font-mono text-discord-text-primary">{order.order_number}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm text-discord-text-primary">{order.products?.name || 'Unknown'}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-discord-text-muted">{formatDate(order.created_at)}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-sm text-discord-text-primary">
                      {formatPrice(order.amount_cents - order.discount_cents, order.currency)}
                    </span>
                    {order.discount_cents > 0 && (
                      <span className="ml-1 text-xs text-discord-success">(-{formatPrice(order.discount_cents, order.currency)})</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[order.status] || ''}`}>
                      {order.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
