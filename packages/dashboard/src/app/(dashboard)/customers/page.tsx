/**
 * Customers — Customer 360 view with unified timeline.
 *
 * Left panel: searchable customer list with key metrics.
 * Right panel: full customer detail with tabs for timeline, orders, entitlements, infractions.
 */
'use client';

import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { Users } from 'lucide-react';

import { useEffect, useState, useCallback } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';

// ── Types ─────────────────────────────────────────────────

interface Customer {
  id: string;
  discord_id: string;
  discord_username: string;
  email: string | null;
  total_spent_cents: number;
  total_orders: number;
  created_at: string;
}

interface TimelineEvent {
  id: string;
  type: string;
  category: 'commerce' | 'support' | 'moderation' | 'engagement' | 'system';
  title: string;
  description: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

interface TimelineSummary {
  totalOrders: number;
  totalSpent: number;
  activeEntitlements: number;
  openTickets: number;
  infractions: number;
  activeLicenseSessions: number;
}

interface CustomerTimeline {
  customer: Customer;
  timeline: TimelineEvent[];
  summary: TimelineSummary;
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

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function categoryIcon(cat: string): string {
  switch (cat) {
    case 'commerce': return '💰';
    case 'support': return '🎫';
    case 'moderation': return '🛡️';
    case 'engagement': return '📈';
    case 'system': return '⚙️';
    default: return '📋';
  }
}

function categoryColor(cat: string): string {
  switch (cat) {
    case 'commerce': return 'border-l-green-500';
    case 'support': return 'border-l-blue-500';
    case 'moderation': return 'border-l-red-500';
    case 'engagement': return 'border-l-purple-500';
    case 'system': return 'border-l-gray-500';
    default: return 'border-l-gray-500';
  }
}

// V53 Phase 3 (1.9): Portal session type
interface PortalSession {
  id: string;
  customer_id: string;
  discord_id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked: boolean;
}

// ── Component ─────────────────────────────────────────────

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<CustomerTimeline | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'timeline' | 'commerce' | 'support' | 'moderation' | 'sessions'>('timeline');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  // V53 Phase 3 (1.9): Portal sessions
  const [sessions, setSessions] = useState<PortalSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  const fetchCustomers = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      const res = await fetch(`/api/customers?${params}`);
      const json = await res.json();
      if (json.success) setCustomers(json.data ?? []);
    } catch (err) {
      console.error('Failed to load customers:', err);
    } finally {
      setLoading(false);
    }
  }, [search]);

  const fetchTimeline = useCallback(async (id: string) => {
    setSelectedId(id);
    setTimelineLoading(true);
    setActiveTab('timeline');
    setCategoryFilter(null);
    try {
      const res = await fetch(`/api/customers/${id}/timeline`);
      const json = await res.json();
      if (json.success) setTimeline(json.data);
    } catch (err) {
      console.error('Failed to load timeline:', err);
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  const fetchSessions = useCallback(async (customerId: string) => {
    setSessionsLoading(true);
    try {
      const res = await fetch(`/api/portal/sessions?customer_id=${customerId}`);
      const json = await res.json();
      if (json.success) setSessions(json.data ?? []);
    } catch (err) {
      console.error('Failed to load sessions:', err);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const revokeSession = async (customerId: string, sessionId?: string) => {
    try {
      const res = await fetch('/api/portal/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          sessionId
            ? { customer_id: customerId, session_id: sessionId }
            : { customer_id: customerId, revoke_all: true },
        ),
      });
      const json = await res.json();
      if (json.success) {
        await fetchSessions(customerId);
      }
    } catch (err) {
      console.error('Failed to revoke session:', err);
    }
  };

  // Fetch sessions when sessions tab is activated
  useEffect(() => {
    if (activeTab === 'sessions' && selectedId) {
      fetchSessions(selectedId);
    }
  }, [activeTab, selectedId, fetchSessions]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  // GAP 2: Live updates — auto-refresh when customer data changes in DB
  useAutoRefresh('customers', undefined, fetchCustomers);

  const filteredTimeline = timeline?.timeline.filter((e) => {
    if (categoryFilter) return e.category === categoryFilter;
    if (activeTab === 'commerce') return e.category === 'commerce';
    if (activeTab === 'support') return e.category === 'support';
    if (activeTab === 'moderation') return e.category === 'moderation';
    return true;
  }) ?? [];

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col gap-0 lg:h-[calc(100vh-4rem)] lg:flex-row">
      {/* ── Left: Customer List ─────────────────────────── */}
      <div className="flex w-full flex-shrink-0 flex-col border-b border-discord-border-subtle bg-discord-bg-secondary lg:w-80 lg:border-b-0 lg:border-r">
        <div className="p-4 border-b border-discord-border-subtle">
          <h1 className="text-lg font-bold text-white mb-3">Customers</h1>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, ID, email..."
            className="w-full px-3 py-2 bg-discord-bg-tertiary text-sm text-white rounded border border-discord-border-subtle focus:border-discord-accent focus:outline-none"
          />
        </div>
        <div className="max-h-80 flex-1 overflow-y-auto lg:max-h-none">
          {loading ? (
            <TableSkeleton rows={8} />
          ) : customers.length === 0 ? (
            <EmptyState compact icon={Users} title="No customers found" description="Customers appear here after their first purchase." />
          ) : (
            customers.map((c) => (
              <button
                key={c.id}
                onClick={() => fetchTimeline(c.id)}
                className={`w-full text-left px-4 py-3 border-b border-discord-border-subtle hover:bg-discord-bg-tertiary transition-colors ${
                  selectedId === c.id ? 'bg-discord-bg-tertiary border-l-2 border-l-discord-accent' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white truncate">
                    {c.discord_username}
                  </span>
                  <span className="text-xs text-green-400 font-mono">
                    {formatPrice(c.total_spent_cents)}
                  </span>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs text-discord-text-muted">
                    {c.total_orders} order{c.total_orders !== 1 ? 's' : ''}
                  </span>
                  <span className="text-xs text-discord-text-muted">
                    Since {formatDate(c.created_at)}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Right: Customer 360 ────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center text-discord-text-muted">
            <div className="text-center">
              <p className="text-4xl mb-2">👤</p>
              <p className="text-sm">Select a customer to view their full profile</p>
            </div>
          </div>
        ) : timelineLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-discord-text-muted animate-pulse">Loading customer data...</p>
          </div>
        ) : timeline ? (
          <>
            {/* Header with summary cards */}
            <div className="p-4 border-b border-discord-border-subtle bg-discord-bg-secondary">
              <div className="flex items-center gap-4 mb-4">
                <div className="w-12 h-12 rounded-full bg-discord-accent flex items-center justify-center text-white text-xl font-bold">
                  {timeline.customer.discord_username.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white">{timeline.customer.discord_username}</h2>
                  <p className="text-xs text-discord-text-muted">
                    {timeline.customer.discord_id}
                    {timeline.customer.email && ` • ${timeline.customer.email}`}
                  </p>
                </div>
              </div>

              {/* Summary cards */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                {[
                  { label: 'Total Spent', value: formatPrice(timeline.summary.totalSpent), color: 'text-green-400' },
                  { label: 'Orders', value: String(timeline.summary.totalOrders), color: 'text-blue-400' },
                  { label: 'Active Entitlements', value: String(timeline.summary.activeEntitlements), color: 'text-purple-400' },
                  { label: 'Open Tickets', value: String(timeline.summary.openTickets), color: 'text-yellow-400' },
                  { label: 'Infractions', value: String(timeline.summary.infractions), color: timeline.summary.infractions > 0 ? 'text-red-400' : 'text-discord-text-muted' },
                  { label: 'License Sessions', value: String(timeline.summary.activeLicenseSessions), color: 'text-cyan-400' },
                ].map((card) => (
                  <div key={card.label} className="bg-discord-bg-tertiary rounded-lg p-2.5 text-center">
                    <p className={`text-lg font-bold ${card.color}`}>{card.value}</p>
                    <p className="text-xs text-discord-text-muted">{card.label}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 overflow-x-auto border-b border-discord-border-subtle bg-discord-bg-primary px-4 pt-3">
              {([
                { key: 'timeline', label: 'Timeline', icon: '📋' },
                { key: 'commerce', label: 'Commerce', icon: '💰' },
                { key: 'support', label: 'Support', icon: '🎫' },
                { key: 'moderation', label: 'Moderation', icon: '🛡️' },
                { key: 'sessions', label: 'Sessions', icon: '🔑' },
              ] as const).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => { setActiveTab(tab.key); setCategoryFilter(null); }}
                  className={`whitespace-nowrap px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                    activeTab === tab.key
                      ? 'bg-discord-bg-secondary text-white border-b-2 border-discord-accent'
                      : 'text-discord-text-muted hover:text-white'
                  }`}
                >
                  {tab.icon} {tab.label}
                  {tab.key !== 'timeline' && (
                    <span className="ml-1 text-xs opacity-60">
                      ({timeline.timeline.filter((e) =>
                        tab.key === 'commerce' ? e.category === 'commerce' :
                        tab.key === 'support' ? e.category === 'support' :
                        e.category === 'moderation'
                      ).length})
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Sessions tab — V53 Phase 3 (1.9) */}
            {activeTab === 'sessions' ? (
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-discord-text-muted">
                    {sessions.length} active session{sessions.length !== 1 ? 's' : ''} (max 3 concurrent)
                  </p>
                  {sessions.length > 0 && (
                    <button
                      onClick={() => revokeSession(selectedId!)}
                      className="rounded-md bg-red-500/10 border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors"
                    >
                      Revoke All
                    </button>
                  )}
                </div>
                {sessionsLoading ? (
                  <p className="text-discord-text-muted text-sm text-center mt-8 animate-pulse">Loading sessions...</p>
                ) : sessions.length === 0 ? (
                  <p className="text-discord-text-muted text-sm text-center mt-8">No active sessions</p>
                ) : (
                  sessions.map((session) => (
                    <div
                      key={session.id}
                      className="bg-discord-bg-secondary rounded-lg p-4 border border-discord-border-subtle"
                    >
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-white">
                              {session.ip_address || 'Unknown IP'}
                            </span>
                            <span className="text-xs text-discord-text-muted bg-discord-bg-tertiary rounded px-2 py-0.5">
                              {session.id.slice(0, 8)}
                            </span>
                          </div>
                          <p className="text-xs text-discord-text-muted truncate max-w-md">
                            {session.user_agent || 'Unknown device'}
                          </p>
                          <div className="flex gap-4 text-xs text-discord-text-muted">
                            <span>Created: {formatDateTime(session.created_at)}</span>
                            <span>Last used: {session.last_used_at ? formatDateTime(session.last_used_at) : 'Never'}</span>
                            <span>Expires: {formatDateTime(session.expires_at)}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => revokeSession(selectedId!, session.id)}
                          className="rounded-md border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors flex-shrink-0"
                        >
                          Revoke
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : (
              /* Timeline feed */
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {filteredTimeline.length === 0 ? (
                  <p className="text-discord-text-muted text-sm text-center mt-8">
                    No events in this category
                  </p>
                ) : (
                  filteredTimeline.map((event) => (
                    <div
                      key={event.id}
                      className={`bg-discord-bg-secondary rounded-lg p-3 border-l-4 ${categoryColor(event.category)} hover:bg-discord-bg-tertiary transition-colors`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-2">
                          <span className="text-base mt-0.5">{categoryIcon(event.category)}</span>
                          <div>
                            <p className="text-sm font-medium text-white">{event.title}</p>
                            <p className="text-xs text-discord-text-muted mt-0.5">{event.description}</p>
                          </div>
                        </div>
                        <span className="text-xs text-discord-text-muted whitespace-nowrap ml-4">
                          {formatDateTime(event.timestamp)}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
