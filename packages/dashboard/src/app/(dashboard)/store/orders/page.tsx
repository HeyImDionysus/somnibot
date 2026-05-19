/**
 * Store / Orders — Order management dashboard page.
 *
 * Architecture doc §31 — Order lifecycle.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useToast } from '@/components/shared/toast';
import { TableSkeleton } from '@/components/shared/loading-skeleton';

// ── Types ─────────────────────────────────────────────────

interface Order {
  id: string;
  order_number: string;
  customer_id: string;
  guild_id: string;
  product_id: string;
  plan_id: string | null;
  paypal_order_id: string | null;
  paypal_subscription_id: string | null;
  amount_cents: number;
  currency: string;
  discount_cents: number;
  promotion_id: string | null;
  source: string;
  status: 'pending' | 'completed' | 'refunded' | 'disputed' | 'cancelled';
  created_at: string;
  updated_at: string;
  customers?: { discord_id: string; discord_username: string } | null;
  products?: { name: string } | null;
}

// ── Helpers ───────────────────────────────────────────────

function formatPrice(cents: number, currency: string = 'USD'): string {
  return `$${(cents / 100).toFixed(2)} ${currency}`;
}

function statusBadge(status: string) {
  switch (status) {
    case 'completed':
      return { label: 'Completed', color: 'bg-discord-success/20 text-discord-success' };
    case 'pending':
      return { label: 'Pending', color: 'bg-yellow-500/20 text-yellow-400' };
    case 'refunded':
      return { label: 'Refunded', color: 'bg-discord-danger/20 text-discord-danger' };
    case 'disputed':
      return { label: 'Disputed', color: 'bg-orange-500/20 text-orange-400' };
    case 'cancelled':
      return { label: 'Cancelled', color: 'bg-discord-bg-tertiary text-discord-text-muted' };
    default:
      return { label: status, color: 'bg-discord-bg-tertiary text-discord-text-muted' };
  }
}

function sourceBadge(source: string) {
  switch (source) {
    case 'purchase':
      return '💳';
    case 'giveaway':
      return '🎉';
    case 'manual':
      return '✋';
    case 'automation':
      return '⚡';
    default:
      return '❓';
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Component ─────────────────────────────────────────────

export default function OrdersPage() {
  const { toast } = useToast();
  const [confirmRefund, setConfirmRefund] = useState<{ id: string; orderNumber: string } | null>(null);

  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (filterStatus) params.set('status', filterStatus);
      const res = await fetch(`/api/orders?${params}`);
      const json = await res.json();
      if (json.success) {
        setOrders(json.data);
        setTotal(json.total);
      }
    } finally {
      setLoading(false);
    }
  }, [search, filterStatus]);

  useEffect(() => { load(); }, [load]);

  // GAP 2: Live updates — auto-refresh when order data changes in DB
  useAutoRefresh('orders', undefined, load);

  const refundOrder = async (orderId: string) => {
    await fetch(`/api/orders/${orderId}/refund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    load();
  };

  // Stats
  const completedOrders = orders.filter((o) => o.status === 'completed');
  const totalRevenue = completedOrders.reduce((sum, o) => sum + o.amount_cents, 0);
  const pendingCount = orders.filter((o) => o.status === 'pending').length;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Orders</h1>
        <p className="text-sm text-discord-text-muted">View and manage customer orders</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: 'Total Orders', value: total },
          { label: 'Revenue', value: formatPrice(totalRevenue) },
          { label: 'Completed', value: completedOrders.length },
          { label: 'Pending', value: pendingCount },
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

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search orders…"
          className="rounded-input bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none border border-discord-border-subtle w-64"
        />
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="rounded-input bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none border border-discord-border-subtle"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="completed">Completed</option>
          <option value="refunded">Refunded</option>
          <option value="disputed">Disputed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {/* Order List */}
      {loading ? (
        <TableSkeleton rows={8} />
      ) : orders.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">📦</div>
          <p className="text-discord-text-muted">No orders found.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {orders.map((order) => {
            const badge = statusBadge(order.status);
            return (
              <div
                key={order.id}
                className="flex items-center justify-between rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4"
              >
                <div className="flex items-center gap-4">
                  <span className="text-lg">{sourceBadge(order.source)}</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium text-discord-text-primary">
                        {order.order_number}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${badge.color}`}>
                        {badge.label}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-discord-text-muted">
                      <span>{order.products?.name ?? 'Unknown Product'}</span>
                      <span>•</span>
                      <span>{order.customers?.discord_username ?? 'Unknown'}</span>
                      <span>•</span>
                      <span>{formatDate(order.created_at)}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span className="font-semibold text-discord-text-primary">
                    {formatPrice(order.amount_cents, order.currency)}
                  </span>
                  {order.status === 'completed' && (
                    <button
                      onClick={() => setConfirmRefund({ id: order.id, orderNumber: order.order_number })}
                      className="rounded-input bg-discord-danger/20 px-3 py-1 text-xs text-discord-danger hover:bg-discord-danger/30 transition-standard"
                    >
                      Refund
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Confirm Refund Dialog */}
      <ConfirmDialog
        open={!!confirmRefund}
        title="Refund Order"
        description={`Issue a refund for order ${confirmRefund?.orderNumber}? Entitlements and license keys will be revoked.`}
        confirmLabel="Refund"
        variant="danger"
        onConfirm={async () => {
          if (confirmRefund) {
            await refundOrder(confirmRefund.id);
            setConfirmRefund(null);
          }
        }}
        onCancel={() => setConfirmRefund(null)}
      />
    </div>
  );
}
