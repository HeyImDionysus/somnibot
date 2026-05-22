/**
 * Economy Analytics — Charts and KPIs for the economy system.
 *
 * V53 Phase 5 (Finding 5.1 — S-4)
 *
 * Displays: circulation KPIs, transaction volume by type,
 * market activity, top earners, popular items, feature participation.
 * Uses vanilla SVG bar charts (no chart library dependency).
 */
'use client';

import { DashboardSkeleton } from '@/components/shared/loading-skeleton';
import { useEffect, useState, useCallback } from 'react';

interface AnalyticsData {
  days: number;
  circulation: { total_wallet: number; total_bank: number; total: number; active_wallets: number };
  daily_totals: Array<{ day: string; total_circulation: number; active_users: number }>;
  tx_volume: Array<{ tx_type: string; tx_count: number; total_amount: number }>;
  market_activity: Array<{ day: string; listings_created: number; listings_sold: number; avg_price: number }>;
  top_earners: Array<{ user_id: string; net_worth: number; total_earned: number; total_spent: number }>;
  popular_items: Array<{ item_id: string; item_name: string; purchase_count: number; total_revenue: number }>;
  feature_participation: Array<{ feature: string; daily_active_users: number; total_sessions: number }>;
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4">
      <p className="text-xs text-discord-text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold text-discord-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-discord-text-muted">{sub}</p>}
    </div>
  );
}

function BarChart({ data, labelKey, valueKey, color = '#5865F2' }: { data: Array<Record<string, unknown>>; labelKey: string; valueKey: string; color?: string }) {
  if (!data.length) return <p className="text-sm text-discord-text-muted">No data</p>;
  const max = Math.max(...data.map(d => Number(d[valueKey]) || 0), 1);
  return (
    <div className="space-y-1.5">
      {data.slice(0, 10).map((d, i) => {
        const val = Number(d[valueKey]) || 0;
        const pct = (val / max) * 100;
        return (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 truncate text-discord-text-muted" title={String(d[labelKey])}>
              {String(d[labelKey])}
            </span>
            <div className="flex-1 h-5 rounded bg-discord-bg-tertiary overflow-hidden">
              <div className="h-full rounded" style={{ width: `${pct}%`, backgroundColor: color }} />
            </div>
            <span className="w-16 text-right text-discord-text-secondary">{formatNum(val)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function EconomyAnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/economy/analytics?days=${days}`);
      const json = await res.json();
      if (json.success) setData(json);
    } catch { /* */ }
    setLoading(false);
  }, [days]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading && !data) return <DashboardSkeleton />;
  if (!data) return <p className="p-6 text-discord-text-muted">Failed to load analytics</p>;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Economy Analytics</h1>
          <p className="mt-1 text-sm text-discord-text-muted">Last {days} days</p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded border border-discord-border bg-discord-bg-secondary px-3 py-1.5 text-sm text-discord-text-primary"
        >
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
          <option value={60}>60 days</option>
          <option value={90}>90 days</option>
        </select>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <KpiCard label="Total Circulation" value={formatNum(data.circulation.total)} sub={`${formatNum(data.circulation.active_wallets)} active wallets`} />
        <KpiCard label="In Wallets" value={formatNum(data.circulation.total_wallet)} />
        <KpiCard label="In Banks" value={formatNum(data.circulation.total_bank)} />
        <KpiCard label="Transactions" value={formatNum(data.tx_volume.reduce((s, t) => s + t.tx_count, 0))} sub={`${data.tx_volume.length} types`} />
      </div>

      {/* Charts Grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Transaction Volume by Type */}
        <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4">
          <h3 className="mb-3 text-sm font-semibold text-discord-text-primary">Transaction Volume by Type</h3>
          <BarChart data={data.tx_volume} labelKey="tx_type" valueKey="tx_count" color="#5865F2" />
        </div>

        {/* Popular Items */}
        <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4">
          <h3 className="mb-3 text-sm font-semibold text-discord-text-primary">Most Popular Items</h3>
          <BarChart data={data.popular_items} labelKey="item_name" valueKey="purchase_count" color="#57F287" />
        </div>

        {/* Feature Participation */}
        <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4">
          <h3 className="mb-3 text-sm font-semibold text-discord-text-primary">Feature Participation (DAU)</h3>
          <BarChart data={data.feature_participation} labelKey="feature" valueKey="daily_active_users" color="#FEE75C" />
        </div>

        {/* Top Earners */}
        <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4">
          <h3 className="mb-3 text-sm font-semibold text-discord-text-primary">Top 10 Earners</h3>
          <div className="space-y-1.5">
            {data.top_earners.map((e, i) => (
              <div key={e.user_id} className="flex items-center gap-2 text-xs">
                <span className="w-5 text-center text-discord-text-muted font-mono">{i + 1}</span>
                <span className="flex-1 truncate text-discord-text-secondary">{e.user_id}</span>
                <span className="text-discord-text-primary font-medium">{formatNum(e.net_worth)}</span>
              </div>
            ))}
            {data.top_earners.length === 0 && <p className="text-sm text-discord-text-muted">No data</p>}
          </div>
        </div>
      </div>

      {/* Market Activity Table */}
      <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4">
        <h3 className="mb-3 text-sm font-semibold text-discord-text-primary">Market Activity (Last 7 Days)</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-discord-border text-left text-discord-text-muted">
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2 text-right">Listed</th>
                <th className="px-2 py-2 text-right">Sold</th>
                <th className="px-2 py-2 text-right">Avg Price</th>
              </tr>
            </thead>
            <tbody>
              {data.market_activity.slice(-7).map((d) => (
                <tr key={d.day} className="border-b border-discord-border/30">
                  <td className="px-2 py-1.5 text-discord-text-secondary">{new Date(d.day).toLocaleDateString()}</td>
                  <td className="px-2 py-1.5 text-right text-discord-text-secondary">{d.listings_created}</td>
                  <td className="px-2 py-1.5 text-right text-discord-text-secondary">{d.listings_sold}</td>
                  <td className="px-2 py-1.5 text-right text-discord-text-secondary">{formatNum(Math.round(d.avg_price))}</td>
                </tr>
              ))}
              {data.market_activity.length === 0 && (
                <tr><td colSpan={4} className="px-2 py-4 text-center text-discord-text-muted">No market activity</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
