/**
 * Analytics — Commerce, Engagement, Moderation, Levels.
 * Phase D: SOTA intelligence dashboard. Phase F.3: Expanded beyond commerce.
 */
'use client';

import { DashboardSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ShoppingCart } from 'lucide-react';

import { useEffect, useState, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────

interface AnalyticsData {
  period: string;
  revenue: {
    total: number;
    previous: number;
    change: number;
    refunds: number;
    avgOrderValue: number;
    orderCount: number;
    byDay: Record<string, number>;
  };
  customers: {
    total: number;
    new: number;
    previousNew: number;
    avgLTV: number;
  };
  entitlements: {
    active: number;
    churned: number;
    churnRate: number;
  };
  products: Array<{
    id: string;
    name: string;
    price_cents: number;
    type: string;
    active: boolean;
    revenue: number;
    orders: number;
  }>;
  promotions: Array<{
    id: string;
    name: string;
    type: string;
    value: number;
    coupon_code: string | null;
    current_uses: number;
    max_uses: number | null;
    active: boolean;
  }>;
  failedPayments: {
    count: number;
    totalAmount: number;
  };
}

// ── Helpers ───────────────────────────────────────────────

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function changeIndicator(change: number): { icon: string; color: string } {
  if (change > 0) return { icon: '↑', color: 'text-discord-success' };
  if (change < 0) return { icon: '↓', color: 'text-discord-danger' };
  return { icon: '→', color: 'text-discord-text-muted' };
}

const PERIODS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '1y', label: '1 year' },
  { value: 'all', label: 'All time' },
];

// ── Component ─────────────────────────────────────────────

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [engagement, setEngagement] = useState<{
    moderation: { totalInfractions: number; activeInfractions: number; pardonedInfractions: number; byType: Record<string, number>; byDay: Record<string, number> };
    tickets: { total: number; open: number; closed: number; avgResolutionHours: number };
    levels: { totalTrackedMembers: number; avgLevel: number; maxLevel: number; totalMessages: number; totalVoiceMinutes: number; distribution: Record<number, number> };
    members: { joins: number; returningJoins: number; leaves: number; netGrowth: number };
    giveaways: { total: number; totalEntries: number; totalWinners: number };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('30d');
  const [activeTab, setActiveTab] = useState<'commerce' | 'engagement'>('commerce');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [commerceRes, engagementRes] = await Promise.all([
        fetch(`/api/analytics?period=${period}`),
        fetch(`/api/analytics/engagement?period=${period}`),
      ]);
      const commerceJson = await commerceRes.json();
      const engagementJson = await engagementRes.json();
      if (commerceJson.success) setData(commerceJson.data);
      if (engagementJson.success) setEngagement(engagementJson.data);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  if (loading || !data) {
    return <DashboardSkeleton />;
  }

  const revChange = changeIndicator(data.revenue.change);
  const custChange = changeIndicator(
    data.customers.previousNew > 0
      ? ((data.customers.new - data.customers.previousNew) / data.customers.previousNew) * 100
      : data.customers.new > 0 ? 100 : 0,
  );

  // Build chart bars from revenue by day
  const days = Object.keys(data.revenue.byDay).sort();
  const maxRevDay = Math.max(...Object.values(data.revenue.byDay), 1);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Analytics</h1>
          <p className="mt-1 text-sm text-discord-text-muted">Commerce, engagement, and moderation insights</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap rounded-md bg-discord-bg-tertiary p-0.5">
            <button
              onClick={() => setActiveTab('commerce')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                activeTab === 'commerce' ? 'bg-discord-accent text-white' : 'text-discord-text-muted hover:text-white'
              }`}
            >💰 Commerce</button>
            <button
              onClick={() => setActiveTab('engagement')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                activeTab === 'engagement' ? 'bg-discord-accent text-white' : 'text-discord-text-muted hover:text-white'
              }`}
            >📊 Engagement</button>
          </div>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="rounded-md bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-accent"
        >
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        </div>
      </div>

      {activeTab === 'engagement' && engagement ? (
        /* ── Engagement Tab ───────────────────────────── */
        <div className="space-y-6">
          {/* Engagement KPIs */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            {[
              { label: 'Member Joins', value: String(engagement.members.joins), sub: `${engagement.members.returningJoins} returning`, color: 'text-green-400' },
              { label: 'Net Growth', value: (engagement.members.netGrowth >= 0 ? '+' : '') + engagement.members.netGrowth, sub: `${engagement.members.leaves} left`, color: engagement.members.netGrowth >= 0 ? 'text-green-400' : 'text-red-400' },
              { label: 'Infractions', value: String(engagement.moderation.totalInfractions), sub: `${engagement.moderation.activeInfractions} active`, color: engagement.moderation.totalInfractions > 0 ? 'text-yellow-400' : 'text-discord-text-muted' },
              { label: 'Tickets', value: String(engagement.tickets.total), sub: `${engagement.tickets.open} open · avg ${engagement.tickets.avgResolutionHours}h resolve`, color: 'text-blue-400' },
              { label: 'Avg Level', value: String(engagement.levels.avgLevel), sub: `${engagement.levels.totalTrackedMembers} tracked · max ${engagement.levels.maxLevel}`, color: 'text-purple-400' },
            ].map((card) => (
              <div key={card.label} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
                <p className="text-xs text-discord-text-muted uppercase tracking-wide">{card.label}</p>
                <p className={`mt-1 text-2xl font-bold ${card.color}`}>{card.value}</p>
                <p className="mt-1 text-xs text-discord-text-muted">{card.sub}</p>
              </div>
            ))}
          </div>

          {/* Moderation Breakdown */}
          <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
            <h3 className="text-sm font-semibold text-discord-text-primary mb-3">🛡️ Moderation by Type</h3>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {Object.entries(engagement.moderation.byType).map(([type, count]) => (
                <div key={type} className="flex items-center justify-between bg-discord-bg-tertiary rounded p-2.5">
                  <span className="text-xs text-discord-text-secondary capitalize">{type}</span>
                  <span className="text-sm font-bold text-discord-text-primary">{count}</span>
                </div>
              ))}
              {Object.keys(engagement.moderation.byType).length === 0 && (
                <p className="text-xs text-discord-text-muted col-span-4">No infractions this period</p>
              )}
            </div>
          </div>

          {/* Level Distribution */}
          <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
            <h3 className="text-sm font-semibold text-discord-text-primary mb-3">📈 Level Distribution</h3>
            <div className="flex items-end gap-1 h-32">
              {Object.entries(engagement.levels.distribution)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([bucket, count]) => {
                  const maxCount = Math.max(...Object.values(engagement.levels.distribution), 1);
                  const height = (count / maxCount) * 100;
                  return (
                    <div key={bucket} className="flex-1 flex flex-col items-center gap-1">
                      <span className="text-xs text-discord-text-muted">{count}</span>
                      <div
                        className="w-full bg-discord-accent rounded-t"
                        style={{ height: `${Math.max(height, 4)}%` }}
                      />
                      <span className="text-xs text-discord-text-muted">{bucket}-{Number(bucket) + 4}</span>
                    </div>
                  );
                })}
              {Object.keys(engagement.levels.distribution).length === 0 && (
                <p className="text-xs text-discord-text-muted w-full text-center">No level data</p>
              )}
            </div>
            <div className="flex items-center gap-4 mt-3 text-xs text-discord-text-muted">
              <span>💬 {engagement.levels.totalMessages.toLocaleString()} messages</span>
              <span>🎙️ {Math.round(engagement.levels.totalVoiceMinutes / 60).toLocaleString()} voice hours</span>
            </div>
          </div>

          {/* Giveaway Stats */}
          {engagement.giveaways.total > 0 && (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
              <h3 className="text-sm font-semibold text-discord-text-primary mb-3">🎉 Giveaways</h3>
              <div className="grid grid-cols-3 gap-4">
                <div className="text-center">
                  <p className="text-lg font-bold text-discord-text-primary">{engagement.giveaways.total}</p>
                  <p className="text-xs text-discord-text-muted">Total</p>
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-discord-text-primary">{engagement.giveaways.totalEntries}</p>
                  <p className="text-xs text-discord-text-muted">Entries</p>
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-discord-text-primary">{engagement.giveaways.totalWinners}</p>
                  <p className="text-xs text-discord-text-muted">Winners</p>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
      <>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
          <p className="text-xs text-discord-text-muted uppercase tracking-wide">Revenue</p>
          <p className="mt-1 text-2xl font-bold text-discord-text-primary">{formatPrice(data.revenue.total)}</p>
          <p className={`mt-1 text-xs ${revChange.color}`}>
            {revChange.icon} {Math.abs(data.revenue.change)}% vs previous period
          </p>
        </div>
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
          <p className="text-xs text-discord-text-muted uppercase tracking-wide">Orders</p>
          <p className="mt-1 text-2xl font-bold text-discord-text-primary">{data.revenue.orderCount}</p>
          <p className="mt-1 text-xs text-discord-text-muted">Avg: {formatPrice(data.revenue.avgOrderValue)}</p>
        </div>
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
          <p className="text-xs text-discord-text-muted uppercase tracking-wide">New Customers</p>
          <p className="mt-1 text-2xl font-bold text-discord-text-primary">{data.customers.new}</p>
          <p className={`mt-1 text-xs ${custChange.color}`}>
            {custChange.icon} {data.customers.total} total
          </p>
        </div>
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
          <p className="text-xs text-discord-text-muted uppercase tracking-wide">Avg LTV</p>
          <p className="mt-1 text-2xl font-bold text-discord-text-primary">{formatPrice(data.customers.avgLTV)}</p>
          <p className="mt-1 text-xs text-discord-text-muted">Per customer</p>
        </div>
      </div>

      {/* Second Row KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
          <p className="text-xs text-discord-text-muted uppercase tracking-wide">Active Entitlements</p>
          <p className="mt-1 text-2xl font-bold text-discord-success">{data.entitlements.active}</p>
        </div>
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
          <p className="text-xs text-discord-text-muted uppercase tracking-wide">Churn Rate</p>
          <p className={`mt-1 text-2xl font-bold ${data.entitlements.churnRate > 10 ? 'text-discord-danger' : 'text-discord-text-primary'}`}>
            {data.entitlements.churnRate}%
          </p>
          <p className="mt-1 text-xs text-discord-text-muted">{data.entitlements.churned} cancelled/expired</p>
        </div>
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
          <p className="text-xs text-discord-text-muted uppercase tracking-wide">Refunds</p>
          <p className="mt-1 text-2xl font-bold text-discord-danger">{formatPrice(data.revenue.refunds)}</p>
        </div>
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
          <p className="text-xs text-discord-text-muted uppercase tracking-wide">Failed Payments</p>
          <p className="mt-1 text-2xl font-bold text-discord-danger">{data.failedPayments.count}</p>
          <p className="mt-1 text-xs text-discord-text-muted">{formatPrice(data.failedPayments.totalAmount)} lost</p>
        </div>
      </div>

      {/* Revenue Chart */}
      {days.length > 0 && (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
          <h2 className="text-sm font-semibold text-discord-text-secondary mb-4">Revenue by Day</h2>
          <div className="flex items-end gap-1 h-32">
            {days.map((day) => {
              const value = data.revenue.byDay[day] || 0;
              const height = Math.max((value / maxRevDay) * 100, 2);
              return (
                <div key={day} className="flex-1 group relative flex flex-col items-center justify-end">
                  <div
                    className="w-full rounded-t bg-[#FF1493]/70 group-hover:bg-[#FF1493] transition-colors min-h-[2px]"
                    style={{ height: `${height}%` }}
                  />
                  <div className="absolute -top-8 hidden group-hover:block bg-discord-bg-tertiary text-discord-text-primary text-xs px-2 py-1 rounded shadow-lg whitespace-nowrap z-10">
                    {day}: {formatPrice(value)}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-2 text-xs text-discord-text-muted">
            <span>{days[0]}</span>
            <span>{days[days.length - 1]}</span>
          </div>
        </div>
      )}

      {/* Product Performance */}
      <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
        <h2 className="text-sm font-semibold text-discord-text-secondary mb-4">Product Performance</h2>
        {data.products.length === 0 ? (
          <EmptyState compact icon={ShoppingCart} title="No products yet" description="Create a product in the Store to see analytics." />
        ) : (
          <div className="space-y-2">
            {data.products.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-md bg-discord-bg-tertiary p-3">
                <div className="flex items-center gap-3">
                  <div>
                    <span className="text-sm font-medium text-discord-text-primary">{p.name}</span>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-discord-text-muted">{formatPrice(p.price_cents)}</span>
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${p.active ? 'bg-discord-success/20 text-discord-success' : 'bg-discord-bg-secondary text-discord-text-muted'}`}>
                        {p.active ? 'Active' : 'Inactive'}
                      </span>
                      <span className="rounded-full bg-discord-bg-secondary px-1.5 py-0.5 text-[10px] text-discord-text-muted">
                        {p.type}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-discord-text-primary">{formatPrice(p.revenue)}</p>
                  <p className="text-xs text-discord-text-muted">{p.orders} orders</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Promotion Performance */}
      {data.promotions.length > 0 && (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
          <h2 className="text-sm font-semibold text-discord-text-secondary">Promotion Performance</h2>
          {/* Finding 8: nothing in checkout redeems a promotion, so these rows
              have never discounted an order. Say so rather than implying they
              are live. */}
          <p className="mb-4 mt-1 text-xs text-yellow-400">
            Coupons are disabled — none of these were applied at checkout, and every order was
            charged full price.
          </p>
          <div className="space-y-2">
            {data.promotions.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-md bg-discord-bg-tertiary p-3">
                <div>
                  <span className="text-sm font-medium text-discord-text-primary">{p.name}</span>
                  <div className="flex items-center gap-2 mt-0.5">
                    {p.coupon_code && (
                      <code className="text-xs bg-discord-bg-secondary px-1.5 py-0.5 rounded text-discord-accent">
                        {p.coupon_code}
                      </code>
                    )}
                    <span className="text-xs text-discord-text-muted">
                      {p.type === 'percentage' ? `${p.value}% off` : `$${(p.value / 100).toFixed(2)} off`}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-discord-text-primary">
                    {p.current_uses}{p.max_uses ? `/${p.max_uses}` : ''} uses
                  </p>
                  <span className={`text-xs ${p.active ? 'text-discord-success' : 'text-discord-text-muted'}`}>
                    {p.active ? 'Active' : 'Inactive'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
