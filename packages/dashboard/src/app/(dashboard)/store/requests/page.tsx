'use client';

/**
 * Store → Requests — the owner's queue of customer refund/support requests.
 *
 * Buyers have been able to file these since the portal shipped. Nothing read
 * the queue, so every request sat at 'pending' forever: to the customer, asking
 * looked like it worked. The API landed first; this is the screen that makes it
 * usable.
 *
 * Two things this page is careful about:
 *   * Resolving a refund request does NOT move money. The confirm copy says so
 *     explicitly, because a seller who assumes otherwise leaves a buyer
 *     believing they were refunded.
 *   * A final decision needs a note, because it is sent to the customer. A bare
 *     "rejected" is not an answer, so the button stays disabled without one.
 */
import { useCallback, useEffect, useState } from 'react';

interface PortalRequest {
  id: string;
  type: 'refund' | 'service';
  status: 'pending' | 'reviewing' | 'resolved' | 'rejected';
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  reviewer_id: string | null;
  resolution_note: string | null;
  customer_notified: boolean;
  order_id: string | null;
  ageHours: number | null;
  stale: boolean;
  customers?: { discord_id?: string | null; email?: string | null } | null;
  orders?: { order_number?: string | null; amount_cents?: number | null; currency?: string | null } | null;
}

interface Summary {
  pending: number;
  awaitingDelivery: number;
  stale: number;
}

const STATUS_STYLES: Record<PortalRequest['status'], string> = {
  pending: 'bg-yellow-500/20 text-yellow-400',
  reviewing: 'bg-blue-500/20 text-blue-400',
  resolved: 'bg-green-500/20 text-green-400',
  rejected: 'bg-red-500/20 text-red-400',
};

function formatAge(hours: number | null): string {
  if (hours === null) return 'unknown';
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function StoreRequestsPage() {
  const [requests, setRequests] = useState<PortalRequest[]>([]);
  const [summary, setSummary] = useState<Summary>({ pending: 0, awaitingDelivery: 0, stale: 0 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'' | PortalRequest['status']>('pending');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`/api/commerce/requests?${params}`);
      if (!res.ok) {
        setError('Could not load the request queue.');
        return;
      }
      const body = await res.json();
      setRequests((body.data ?? []) as PortalRequest[]);
      setSummary(body.summary ?? { pending: 0, awaitingDelivery: 0, stale: 0 });
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);

  const decide = async (
    id: string,
    status: 'reviewing' | 'resolved' | 'rejected',
  ) => {
    setSaving(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/commerce/requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          ...(status === 'reviewing' ? {} : { resolution_note: notes[id] ?? '' }),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: string }).error ?? 'Could not save that decision.');
        return;
      }
      // The API returns this when a refund request is resolved — surfaced so the
      // seller cannot mistake a decision for a completed payment.
      if ((body as { notice?: string }).notice) setNotice((body as { notice: string }).notice);
      await load();
    } catch {
      setError('Could not reach the server to save that decision.');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Customer Requests</h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          Refund and support requests your buyers filed from the customer portal.
          They cannot be told anything until you decide.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          { label: 'Waiting for you', value: summary.pending, tone: 'text-yellow-400' },
          { label: 'Waiting over 48h', value: summary.stale, tone: 'text-red-400' },
          { label: 'Decided, not yet delivered', value: summary.awaitingDelivery, tone: 'text-blue-400' },
        ].map((s) => (
          <div key={s.label} className="rounded-lg bg-discord-bg-secondary p-4">
            <p className="text-sm text-discord-text-muted">{s.label}</p>
            <p className={`mt-1 text-2xl font-bold ${s.tone}`}>{s.value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {([
          ['pending', 'Waiting'],
          ['reviewing', 'In review'],
          ['resolved', 'Approved'],
          ['rejected', 'Declined'],
          ['', 'All'],
        ] as const).map(([value, label]) => (
          <button
            key={label}
            onClick={() => setStatusFilter(value as '' | PortalRequest['status'])}
            className={`rounded-md px-3 py-1.5 text-sm ${
              statusFilter === value
                ? 'bg-discord-blurple text-white'
                : 'bg-discord-bg-secondary text-discord-text-secondary'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && (
        <p className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-300">
          {notice}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-discord-text-muted">Loading…</p>
      ) : requests.length === 0 ? (
        <div className="rounded-lg bg-discord-bg-secondary p-6 text-center">
          <p className="text-sm text-discord-text-muted">
            Nothing here. Requests your customers file from the portal show up on this page.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => {
            const decided = r.status === 'resolved' || r.status === 'rejected';
            const note = notes[r.id] ?? '';
            return (
              <div
                key={r.id}
                className={`rounded-lg border p-4 ${
                  r.stale ? 'border-red-500/40 bg-red-500/5' : 'border-discord-border-subtle bg-discord-bg-secondary'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[r.status]}`}>
                        {r.status}
                      </span>
                      <span className="text-sm font-semibold text-discord-text-primary">
                        {r.type === 'refund' ? 'Refund request' : 'Support request'}
                      </span>
                      {r.orders?.order_number && (
                        <span className="text-xs text-discord-text-muted">
                          order {r.orders.order_number}
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-sm text-discord-text-secondary">
                      {r.reason?.trim() || <span className="italic text-discord-text-muted">No reason given.</span>}
                    </p>
                    <p className="mt-1 text-xs text-discord-text-muted">
                      From {r.customers?.discord_id ? `<@${r.customers.discord_id}>` : (r.customers?.email ?? 'a customer')}
                      {' • '}filed {formatAge(r.ageHours)}
                    </p>
                  </div>
                </div>

                {decided ? (
                  <div className="mt-3 rounded-md bg-discord-bg-tertiary p-3">
                    <p className="text-xs text-discord-text-muted">
                      You said:
                    </p>
                    <p className="text-sm text-discord-text-secondary">
                      {r.resolution_note || '—'}
                    </p>
                    <p className="mt-2 text-xs text-discord-text-muted">
                      {r.customer_notified
                        ? 'The customer has been told.'
                        : 'Not yet delivered to the customer — the bot sends this shortly.'}
                    </p>
                  </div>
                ) : (
                  <div className="mt-3 space-y-2">
                    <textarea
                      value={note}
                      onChange={(e) => setNotes((p) => ({ ...p, [r.id]: e.target.value }))}
                      placeholder="What should the customer be told? This is sent to them."
                      rows={2}
                      className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary"
                    />
                    <div className="flex flex-wrap gap-2">
                      {r.status === 'pending' && (
                        <button
                          onClick={() => void decide(r.id, 'reviewing')}
                          disabled={saving === r.id}
                          className="rounded-md bg-discord-bg-tertiary px-3 py-1.5 text-sm text-discord-text-secondary disabled:opacity-50"
                        >
                          Mark as in review
                        </button>
                      )}
                      <button
                        onClick={() => void decide(r.id, 'resolved')}
                        disabled={saving === r.id || note.trim().length === 0}
                        title={note.trim().length === 0 ? 'Add a note — the customer receives it' : undefined}
                        className="rounded-md bg-green-600/80 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => void decide(r.id, 'rejected')}
                        disabled={saving === r.id || note.trim().length === 0}
                        title={note.trim().length === 0 ? 'Add a note — the customer receives it' : undefined}
                        className="rounded-md bg-red-600/80 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                      >
                        Decline
                      </button>
                    </div>
                    {r.type === 'refund' && (
                      <p className="text-xs text-discord-text-muted">
                        Approving records your decision — it does <strong>not</strong> send the money.
                        Use the order&apos;s refund action for that.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
