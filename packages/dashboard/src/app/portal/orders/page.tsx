'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleHelp, ReceiptText } from 'lucide-react';
import { Button } from '@/components/shared/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

interface Payment {
  id: string;
  amount_cents: number;
  currency: string;
  status: string;
  provider: string;
  created_at: string;
}

interface Entitlement {
  id: string;
  status: string;
  type: string;
  expires_at: string | null;
  grace_period_ends_at: string | null;
  cancelled_at: string | null;
}

interface Order {
  id: string;
  order_number: string;
  amount_cents: number;
  discount_cents: number;
  currency: string;
  status: string;
  source: string;
  can_self_service_cancel: boolean;
  created_at: string;
  products: { name: string; type: string } | null;
  payments: Payment[];
  entitlements: Entitlement[];
}

type RequestType = 'refund' | 'service';
type Notice = { kind: 'success' | 'error'; message: string };
type PortalControls = {
  self_service_cancellation: boolean;
  cancellation_timing: 'end-of-term' | 'immediate';
  refund_requests_enabled: boolean;
  service_requests_enabled: boolean;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatPrice(cents: number, currency: string = 'USD'): string {
  return `$${(cents / 100).toFixed(2)} ${currency}`;
}

const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-discord-success/20 text-discord-success',
  pending: 'bg-discord-warning/20 text-discord-warning',
  refunded: 'bg-discord-danger/20 text-discord-danger',
  cancelled: 'bg-discord-bg-tertiary text-discord-text-muted',
};

function activeSubscription(order: Order): Entitlement | null {
  return order.entitlements?.find((entitlement) =>
    entitlement.type === 'subscription'
    && ['active', 'grace_period'].includes(entitlement.status)) ?? null;
}

function accessBoundary(entitlement: Entitlement): string | null {
  return entitlement.status === 'grace_period'
    ? entitlement.grace_period_ends_at
    : entitlement.expires_at;
}

export default function PortalOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<Order | null>(null);
  const [requestTarget, setRequestTarget] = useState<Order | null>(null);
  const [requestType, setRequestType] = useState<RequestType>('service');
  const [requestReason, setRequestReason] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [controls, setControls] = useState<PortalControls | null>(null);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const requestReasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    async function load() {
      const token = localStorage.getItem('portal_token');
      if (!token) {
        window.location.href = '/portal';
        return;
      }
      try {
        const res = await fetch('/api/portal/orders', {
          headers: { 'x-portal-token': token },
        });
        if (res.status === 401) {
          localStorage.removeItem('portal_token');
          window.location.href = '/portal';
          return;
        }
        const json = await res.json();
        const loadedControls = json.controls as Partial<PortalControls> | undefined;
        if (
          res.ok
          && json.success
          && Array.isArray(json.data)
          && typeof loadedControls?.self_service_cancellation === 'boolean'
          && ['end-of-term', 'immediate'].includes(String(loadedControls.cancellation_timing))
          && typeof loadedControls.refund_requests_enabled === 'boolean'
          && typeof loadedControls.service_requests_enabled === 'boolean'
        ) {
          setOrders(json.data);
          setControls(loadedControls as PortalControls);
          setOrdersLoaded(true);
        } else {
          setNotice({ kind: 'error', message: json.error || 'Order history could not be loaded.' });
        }
      } catch {
        setNotice({ kind: 'error', message: 'Order history could not be loaded. Please try again.' });
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  useEffect(() => {
    if (requestTarget) requestReasonRef.current?.focus();
  }, [requestTarget]);

  const cancelEntitlement = useMemo(
    () => cancelTarget ? activeSubscription(cancelTarget) : null,
    [cancelTarget],
  );

  const scheduleCancellation = async () => {
    const token = localStorage.getItem('portal_token');
    if (!token || !cancelTarget || !cancelEntitlement) return;
    setCancelling(true);
    setNotice(null);
    try {
      const response = await fetch('/api/portal/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-portal-token': token },
        body: JSON.stringify({
          entitlement_id: cancelEntitlement.id,
          cancellation_timing: controls?.cancellation_timing,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success !== true) {
        throw new Error(body.error || 'Cancellation could not be scheduled.');
      }
      setOrders((current) => current.map((order) => order.id === cancelTarget.id
        ? {
            ...order,
            entitlements: order.entitlements.map((entitlement) =>
              entitlement.id === cancelEntitlement.id
                ? {
                    ...entitlement,
                    status: body.data.status,
                    expires_at: body.data.access_until,
                    cancelled_at: body.data.cancellation_scheduled_at,
                  }
                : entitlement),
          }
        : order));
      const immediate = body.data.cancellation_timing === 'immediate';
      const until = body.data.access_until ? formatDate(body.data.access_until) : 'the current access deadline';
      setNotice({
        kind: 'success',
        message: immediate
          ? body.deduped
            ? 'The subscription was already cancelled. Access ended immediately.'
            : 'Subscription cancelled. Access ended immediately.'
          : body.deduped
            ? `Renewal was already cancelled. Access remains available through ${until}.`
            : `Renewal cancelled. Access remains available through ${until}.`,
      });
      setCancelTarget(null);
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Cancellation could not be scheduled.',
      });
    } finally {
      setCancelling(false);
    }
  };

  const openRequest = (order: Order, type: RequestType) => {
    setRequestTarget(order);
    setRequestType(type);
    setRequestReason('');
    setNotice(null);
  };

  const submitRequest = async () => {
    const token = localStorage.getItem('portal_token');
    if (!token || !requestTarget) return;
    setRequesting(true);
    setNotice(null);
    try {
      const response = await fetch('/api/portal/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-portal-token': token },
        body: JSON.stringify({
          type: requestType,
          order_id: requestTarget.id,
          reason: requestReason.trim() || null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success !== true) {
        throw new Error(body.error || 'Your request could not be sent.');
      }
      setNotice({
        kind: 'success',
        message: body.deduped
          ? 'That request is already waiting for the seller. No duplicate was created.'
          : 'Your request was sent to the seller. This does not automatically move money or change access.',
      });
      setRequestTarget(null);
      setRequestReason('');
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Your request could not be sent.',
      });
    } finally {
      setRequesting(false);
    }
  };

  const orderActions = (order: Order) => {
    const subscription = activeSubscription(order);
    const subscriptionBoundary = subscription ? accessBoundary(subscription) : null;
    return (
      <div className="flex flex-wrap gap-2">
        {controls?.self_service_cancellation && order.can_self_service_cancel && subscription && !subscription.cancelled_at && (
          <Button size="sm" variant="danger" onClick={() => setCancelTarget(order)}>
            Cancel renewal
          </Button>
        )}
        {subscription?.cancelled_at && (
          <span className="self-center text-xs text-discord-warning">
            Renewal cancelled{subscriptionBoundary ? ` · Access through ${formatDate(subscriptionBoundary)}` : ''}
          </span>
        )}
        {controls?.refund_requests_enabled && !['refunded', 'cancelled'].includes(order.status) && (
          <Button size="sm" variant="secondary" onClick={() => openRequest(order, 'refund')}>
            Request refund
          </Button>
        )}
        {controls?.service_requests_enabled && (
          <Button size="sm" variant="ghost" onClick={() => openRequest(order, 'service')}>
            Contact seller
          </Button>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24" role="status" aria-label="Loading order history">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-discord-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Order History</h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          View purchases, stop a subscription renewal, or ask the seller for help.
        </p>
      </div>

      {notice && (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`rounded-input border p-3 text-sm ${notice.kind === 'error'
            ? 'border-discord-danger/40 bg-discord-danger/10 text-discord-danger'
            : 'border-discord-success/40 bg-discord-success/10 text-discord-text-primary'}`}
        >
          {notice.message}
        </div>
      )}

      {requestTarget && (
        <section className="rounded-card border border-discord-border-subtle bg-discord-bg-elevated p-5" aria-labelledby="portal-request-title">
          <div className="flex items-start gap-3">
            <CircleHelp className="mt-0.5 text-discord-accent" size={20} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h2 id="portal-request-title" className="font-medium text-discord-text-primary">
                {requestType === 'refund' ? 'Request a refund' : 'Contact the seller'}
              </h2>
              <p className="mt-1 text-xs text-discord-text-muted">
                Order {requestTarget.order_number}. This opens one seller-review request; it does not automatically refund money or change access.
              </p>
              <label htmlFor="portal-request-reason" className="mt-4 block text-sm font-medium text-discord-text-primary">
                What should the seller know? <span className="text-discord-text-muted">(optional)</span>
              </label>
              <textarea
                id="portal-request-reason"
                ref={requestReasonRef}
                maxLength={2000}
                value={requestReason}
                onChange={(event) => setRequestReason(event.target.value)}
                className="mt-1 min-h-24 w-full resize-y rounded-input border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-discord-accent"
              />
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={() => setRequestTarget(null)} disabled={requesting}>Cancel</Button>
                <Button onClick={() => void submitRequest()} disabled={requesting}>
                  {requesting ? 'Sending…' : 'Send request'}
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}

      {orders.length === 0 ? (
        ordersLoaded ? (
          <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
            <ReceiptText className="mx-auto mb-3 text-discord-text-muted" size={36} aria-hidden="true" />
            <p className="text-discord-text-muted">No orders yet.</p>
          </div>
        ) : null
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            {orders.map((order) => (
              <article key={order.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-medium text-discord-text-primary">{order.products?.name || 'Unknown product'}</h2>
                    <p className="mt-1 font-mono text-xs text-discord-text-muted">{order.order_number}</p>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[order.status] || 'bg-discord-bg-tertiary text-discord-text-muted'}`}>
                    {order.status}
                  </span>
                </div>
                <dl className="my-4 grid grid-cols-2 gap-3 text-xs">
                  <div><dt className="text-discord-text-muted">Date</dt><dd className="mt-0.5 text-discord-text-primary">{formatDate(order.created_at)}</dd></div>
                  <div><dt className="text-discord-text-muted">Amount</dt><dd className="mt-0.5 text-discord-text-primary">{formatPrice(order.amount_cents - order.discount_cents, order.currency)}</dd></div>
                </dl>
                {orderActions(order)}
              </article>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-card border border-discord-border-subtle bg-discord-bg-secondary md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b border-discord-border-subtle text-xs text-discord-text-muted">
                  <th className="px-4 py-3 text-left font-medium">Order</th>
                  <th className="px-4 py-3 text-left font-medium">Product</th>
                  <th className="px-4 py-3 text-left font-medium">Date</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3 text-center font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-discord-border-subtle">
                {orders.map((order) => (
                  <tr key={order.id} className="align-top transition-colors hover:bg-discord-bg-tertiary/30">
                    <td className="px-4 py-3"><span className="font-mono text-sm text-discord-text-primary">{order.order_number}</span></td>
                    <td className="px-4 py-3"><span className="text-sm text-discord-text-primary">{order.products?.name || 'Unknown'}</span></td>
                    <td className="px-4 py-3"><span className="text-xs text-discord-text-muted">{formatDate(order.created_at)}</span></td>
                    <td className="px-4 py-3 text-right"><span className="text-sm text-discord-text-primary">{formatPrice(order.amount_cents - order.discount_cents, order.currency)}</span></td>
                    <td className="px-4 py-3 text-center">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[order.status] || 'bg-discord-bg-tertiary text-discord-text-muted'}`}>{order.status}</span>
                    </td>
                    <td className="px-4 py-3">{orderActions(order)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <ConfirmDialog
        open={Boolean(cancelTarget && cancelEntitlement)}
        title={`Cancel renewal for ${cancelTarget?.products?.name || 'this subscription'}?`}
        description={controls?.cancellation_timing === 'immediate'
          ? 'PayPal renewal will stop and your access ends immediately.'
          : `PayPal renewal will stop. Your current access remains available through ${cancelEntitlement && accessBoundary(cancelEntitlement) ? formatDate(accessBoundary(cancelEntitlement)!) : 'the current access deadline'}.`}
        confirmLabel="Cancel renewal"
        variant="danger"
        loading={cancelling}
        onConfirm={scheduleCancellation}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
}
