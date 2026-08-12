/**
 * Store / Orders — Order management dashboard page.
 *
 * Architecture doc §31 — Order lifecycle.
 */
'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useToast } from '@/components/shared/toast';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { useCsrf } from '@/hooks/use-csrf';
import { requestOrderRefund } from '@/lib/api/order-refund-client';
import {
  parseOrderListPayload,
  runLatestOrderListLoad,
  type PersistedRefundUiState,
} from '@/lib/api/order-list-client';
import {
  canOfferOwnerRefund,
  completedRefundRefreshFailureToast,
  interpretRefundResult,
  refundActionLabel,
  refundDialogCopy,
  type RefundDialogState,
  type RefundProviderContext,
} from '@/lib/api/order-refund-ui';

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
  refund_state: PersistedRefundUiState | null;
  refund_context: RefundProviderContext | null;
}

interface RefundSelection {
  id: string;
  orderNumber: string;
  state: RefundDialogState;
  providerContext: RefundProviderContext;
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
  const { csrfHeaders, refreshCsrf } = useCsrf();
  const [confirmRefund, setConfirmRefund] = useState<RefundSelection | null>(null);
  const [refundStates, setRefundStates] = useState<Record<string, RefundDialogState>>({});
  const [refundPending, setRefundPending] = useState(false);
  const refundInFlight = useRef(false);
  const loadSequence = useRef(0);

  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const load = useCallback(async (): Promise<boolean | null> => {
    return runLatestOrderListLoad(
      loadSequence,
      async () => {
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        if (filterStatus) params.set('status', filterStatus);
        const res = await fetch(`/api/orders?${params}`);
        const json: unknown = await res.json().catch(() => null);
        const parsed = parseOrderListPayload<Order>(res.ok, json);
        if (!parsed.ok) throw new Error(parsed.error);
        return parsed;
      },
      {
        onStart: () => setLoading(true),
        onSuccess: (result) => {
          setOrders(result.orders);
          setTotal(result.total);
          setRefundStates(result.refundStates);
        },
        onFailure: () => {
          // A stale order list could advertise an action that is no longer
          // valid. Only the latest-started failure may clear it and notify.
          setOrders([]);
          setTotal(0);
          setRefundStates({});
          toast({ title: 'Orders could not be refreshed', variant: 'error' });
        },
        onFinish: () => setLoading(false),
      },
    );
  }, [search, filterStatus, toast]);

  useEffect(() => {
    void load();
    return () => { loadSequence.current += 1; };
  }, [load]);

  // GAP 2: Live updates — auto-refresh when order data changes in DB
  useAutoRefresh('orders', undefined, load);

  const refundOrder = async (orderId: string) => {
    if (refundInFlight.current) return null;
    refundInFlight.current = true;
    setRefundPending(true);
    const recoveringRefundedOrder = orders.some(
      (order) => order.id === orderId && order.status === 'refunded',
    );
    try {
      let activeCsrfHeaders: Record<string, string> = csrfHeaders['X-CSRF-Token']
        ? { 'X-CSRF-Token': csrfHeaders['X-CSRF-Token'] }
        : {};
      if (!activeCsrfHeaders['X-CSRF-Token']) {
        const token = await refreshCsrf();
        activeCsrfHeaders = token ? { 'X-CSRF-Token': token } : {};
      }

      let result = await requestOrderRefund(orderId, activeCsrfHeaders);
      // Middleware rejects a stale/session-rebound token before the mutation.
      // Refresh once and retry the same durable operation contract.
      if (!result.ok && result.httpStatus === 403 && /csrf/i.test(result.error)) {
        const token = await refreshCsrf();
        if (token) {
          result = await requestOrderRefund(orderId, { 'X-CSRF-Token': token });
        }
      }
      const outcome = interpretRefundResult(result);
      // A list request started before this mutation must not overwrite its
      // newer durable state when it eventually resolves.
      loadSequence.current += 1;
      setLoading(false);
      setRefundStates((current) => {
        const next = { ...current };
        if (outcome.nextState === 'ready') delete next[orderId];
        else next[orderId] = outcome.nextState;
        return next;
      });
      setOrders((current) => current.map((order) => order.id === orderId
        ? {
            ...order,
            refund_state: outcome.nextState === 'ready' ? null : outcome.nextState,
            refund_context: outcome.nextState === 'ready' ? null : order.refund_context,
          }
        : order));
      setConfirmRefund((current) => current?.id === orderId
        ? recoveringRefundedOrder && outcome.nextState === 'failed'
          ? null
          : { ...current, state: outcome.nextState }
        : current);

      let refreshed: boolean | null = true;
      if (outcome.refreshOrders) refreshed = await load();
      const toastMessage = result.ok && result.status === 'completed' && refreshed === false
        ? completedRefundRefreshFailureToast()
        : outcome.toast;
      toast(toastMessage);
      return outcome;
    } finally {
      refundInFlight.current = false;
      setRefundPending(false);
    }
  };

  // Stats
  const completedOrders = orders.filter((o) => o.status === 'completed');
  const totalRevenue = completedOrders.reduce((sum, o) => sum + o.amount_cents, 0);
  const pendingCount = orders.filter((o) => o.status === 'pending').length;
  const dialogCopy = refundDialogCopy(
    confirmRefund?.state ?? 'ready',
    confirmRefund?.orderNumber ?? 'this order',
    confirmRefund?.providerContext ?? 'provider',
  );

  return (
    <div className="space-y-6 p-0 sm:p-6">
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
          className="w-full rounded-input border border-discord-border-subtle bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none sm:w-64"
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
                className="flex flex-col items-stretch gap-3 rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-3 sm:items-center sm:gap-4">
                  <span className="text-lg">{sourceBadge(order.source)}</span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-medium text-discord-text-primary">
                        {order.order_number}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${badge.color}`}>
                        {badge.label}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-discord-text-muted">
                      <span className="break-words">{order.products?.name ?? 'Unknown Product'}</span>
                      <span>•</span>
                      <span>{order.customers?.discord_username ?? 'Unknown'}</span>
                      <span>•</span>
                      <span>{formatDate(order.created_at)}</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-end">
                  <span className="whitespace-nowrap font-semibold text-discord-text-primary">
                    {formatPrice(order.amount_cents, order.currency)}
                  </span>
                  {canOfferOwnerRefund(order) && (
                    <button
                      onClick={() => setConfirmRefund({
                        id: order.id,
                        orderNumber: order.order_number,
                        state: refundStates[order.id] ?? 'ready',
                        providerContext: order.refund_context ?? 'provider',
                      })}
                      className="rounded-input bg-discord-danger/20 px-3 py-1 text-xs text-discord-danger hover:bg-discord-danger/30 transition-standard"
                    >
                      {refundActionLabel(refundStates[order.id])}
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
        description={dialogCopy.description}
        confirmLabel={dialogCopy.confirmLabel}
        variant="danger"
        loading={refundPending}
        onConfirm={async () => {
          if (confirmRefund) {
            const outcome = await refundOrder(confirmRefund.id);
            if (outcome?.closeDialog) setConfirmRefund(null);
          }
        }}
        onCancel={() => {
          if (!refundInFlight.current) setConfirmRefund(null);
        }}
      />
    </div>
  );
}
