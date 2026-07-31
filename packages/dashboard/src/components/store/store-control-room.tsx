'use client';

import { useCallback, useEffect, useState } from 'react';

type StageState = 'complete' | 'pending' | 'unknown' | 'not_applicable';

interface ControlRoomRow {
  orderId: string;
  orderNumber: string;
  customerName: string;
  productName: string;
  createdAt: string;
  stages: Record<'paid' | 'licensed' | 'downloaded' | 'activated', StageState>;
  stuck: boolean;
  reasons: string[];
}

/**
 * The stuck-row visibility contract, extracted so it is testable as plain
 * logic rather than pinned by source-text assertions:
 *
 *  - only stuck rows are ever shown;
 *  - collapsed view caps at {@link STUCK_ROW_DEFAULT_LIMIT} for readability;
 *  - expanded view shows EVERY stuck row — a hard cap here once hid stuck
 *    customers 21+ entirely while the summary still counted them;
 *  - `total` is always the full stuck count, so the expander label and the
 *    summary can never disagree with the list.
 */
export const STUCK_ROW_DEFAULT_LIMIT = 20;

export function stuckRowView<T extends { stuck: boolean }>(
  rows: readonly T[],
  showAll: boolean,
): { visible: T[]; total: number } {
  const stuck = rows.filter((row) => row.stuck);
  return {
    visible: showAll ? stuck : stuck.slice(0, STUCK_ROW_DEFAULT_LIMIT),
    total: stuck.length,
  };
}

interface ControlRoomData {
  summary: {
    paid: number;
    licensed: number;
    downloaded: number;
    activated: number;
    stuck: number;
  };
  customers: ControlRoomRow[];
  sampledOrders: number;
  totalOrders: number;
}

const STAGES = ['paid', 'licensed', 'downloaded', 'activated'] as const;

function StagePill({ label, state }: { label: string; state: StageState }) {
  return (
    <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${
      state === 'complete'
        ? 'bg-discord-success/15 text-discord-success'
        : state === 'pending'
          ? 'bg-discord-warning/15 text-discord-warning'
          : 'bg-discord-bg-tertiary text-discord-text-muted'
    }`}>
      {label}: {state === 'not_applicable' ? 'N/A' : state}
    </span>
  );
}

export default function StoreControlRoom() {
  const [data, setData] = useState<ControlRoomData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showAllStuck, setShowAllStuck] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const response = await fetch('/api/store/control-room');
      const payload = await response.json();
      if (!response.ok || payload.success !== true) throw new Error('control room unavailable');
      setData(payload.data);
    } catch {
      setData(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <section
      aria-labelledby="store-control-room-heading"
      className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="store-control-room-heading" className="text-lg font-semibold text-discord-text-primary">
            Customer delivery control room
          </h2>
          <p className="text-xs text-discord-text-muted">
            Paid → licensed → downloaded → activated, using durable order and delivery records.
            Pre-ledger download history is shown as unknown, never as a failure.
          </p>
        </div>
        {!loading && (
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-input border border-discord-border-subtle px-3 py-1.5 text-xs text-discord-text-secondary hover:border-discord-border-strong"
          >
            Refresh
          </button>
        )}
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-discord-text-muted" role="status">
          Loading customer delivery state…
        </p>
      ) : error ? (
        <div className="mt-4 rounded-input border border-discord-danger/40 bg-discord-danger/10 p-3">
          <p className="text-sm font-medium text-discord-danger">Delivery state is unavailable</p>
          <p className="mt-1 text-xs text-discord-text-muted">
            One or more source records could not be verified, so no pipeline is shown as healthy.
          </p>
        </div>
      ) : data?.sampledOrders === 0 ? (
        <p className="mt-4 text-sm text-discord-text-muted">
          No paid or review-held orders yet.
        </p>
      ) : data ? (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              ['Paid', data.summary.paid],
              ['Licensed', data.summary.licensed],
              ['Downloaded', data.summary.downloaded],
              ['Activated', data.summary.activated],
              ['Stuck', data.summary.stuck],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className={`rounded-input p-3 ${
                  label === 'Stuck' && Number(value) > 0
                    ? 'bg-discord-danger/10'
                    : 'bg-discord-bg-tertiary'
                }`}
              >
                <p className="text-xl font-bold text-discord-text-primary">{value}</p>
                <p className="text-xs text-discord-text-muted">{label}</p>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            {stuckRowView(data.customers, showAllStuck).visible
              .map((row) => (
                <article
                  key={row.orderId}
                  className="rounded-input border border-discord-danger/30 bg-discord-danger/5 p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-discord-text-primary">
                        {row.customerName} · {row.productName}
                      </p>
                      <p className="text-xs text-discord-text-muted">
                        {row.orderNumber} · {new Date(row.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {STAGES.map((stage) => (
                        <StagePill key={stage} label={stage} state={row.stages[stage]} />
                      ))}
                    </div>
                  </div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-discord-danger">
                    {row.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                </article>
              ))}
            {stuckRowView(data.customers, showAllStuck).total > STUCK_ROW_DEFAULT_LIMIT && (
              <button
                type="button"
                onClick={() => setShowAllStuck((current) => !current)}
                className="w-full rounded-input border border-discord-border-subtle bg-discord-bg-tertiary p-2 text-sm text-discord-text-secondary transition-standard hover:bg-discord-bg-hover hover:text-discord-text-primary"
              >
                {showAllStuck
                  ? 'Show fewer'
                  : `Show all ${stuckRowView(data.customers, showAllStuck).total} stuck orders`}
              </button>
            )}
            {data.summary.stuck === 0 && (
              <div className="rounded-input border border-discord-success/30 bg-discord-success/10 p-3">
                <p className="text-sm font-medium text-discord-success">
                  No customer is beyond a delivery threshold in the sampled orders.
                </p>
              </div>
            )}
          </div>
          {data.totalOrders > data.sampledOrders && (
            <p className="text-xs text-discord-text-muted">
              Showing the newest {data.sampledOrders} of {data.totalOrders} paid or review-held orders.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
