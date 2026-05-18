'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import {
  Shield, Users, Zap, Settings, Music, ShoppingCart, Ticket,
  CheckCircle2, XCircle, Loader2, Rocket,
  BarChart3, DollarSign, Headphones, Activity, Clock, Wifi,
} from 'lucide-react';
import Link from 'next/link';

interface GuildData {
  guild: {
    id: string;
    name: string;
    bot_joined_at: string;
    setup_completed: boolean;
    setup_confirmed_at: string | null;
    bot_role_position: number | null;
  } | null;
  config: Record<string, unknown> | null;
  totalRoles?: number | null;
}

interface DashboardStats {
  memberCount: number;
  trackedMembers: number;
  activeTickets: number;
  openInfractions: number;
  revenueThisMonth: number;
  activeGiveaways: number;
  eventsToday: number;
  uptime: string;
  uptimeSeconds: number;
  wsPing: number | null;
  activeVoice: number;
  valkeyConnected: boolean;
  memoryMb: number | null;
  lastSnapshot: string | null;
  recentEvents: Array<{
    type: string;
    description: string;
    timestamp: string;
    success: boolean;
  }>;
}

/**
 * Dashboard Home — at-a-glance overview of bot status and server health.
 */
export default function DashboardPage() {
  const [data, setData] = useState<GuildData | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [guildRes, statsRes] = await Promise.all([
          fetch('/api/guild'),
          fetch('/api/dashboard/stats'),
        ]);
        if (guildRes.ok) {
          const json = await guildRes.json();
          setData(json);
        } else {
          setError(true);
        }
        if (statsRes.ok) {
          const statsJson = await statsRes.json();
          setStats(statsJson);
        }
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // GAP 2: Live updates — refresh dashboard stats when key tables change
  const refreshStats = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard/stats');
      if (res.ok) setStats(await res.json());
    } catch { /* non-critical */ }
  }, []);
  useAutoRefresh('orders', undefined, refreshStats);
  useAutoRefresh('tickets', undefined, refreshStats);
  useAutoRefresh('audit_log', undefined, refreshStats);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-discord-accent" />
      </div>
    );
  }

  const guild = data?.guild;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-discord-text-primary">Dashboard</h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          {guild?.name ? `Overview of ${guild.name}` : 'Overview of your SomniBot instance'}
        </p>
      </div>

      {/* Status Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Server Connection */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Server</CardTitle>
              {guild ? (
                <CheckCircle2 size={18} className="text-green-500" />
              ) : (
                <XCircle size={18} className="text-red-500" />
              )}
            </div>
            <CardDescription>
              {guild ? guild.name : 'No guild connected'}
            </CardDescription>
          </CardHeader>
        </Card>

        {/* Bot Status */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Bot</CardTitle>
              {guild?.bot_joined_at ? (
                <CheckCircle2 size={18} className="text-green-500" />
              ) : (
                <XCircle size={18} className="text-discord-text-muted" />
              )}
            </div>
            <CardDescription>
              {guild?.bot_joined_at
                ? (() => {
                    const pos = guild.bot_role_position;
                    const total = data?.totalRoles;
                    const ping = stats?.wsPing;
                    let statusText = 'Online';
                    if (pos != null && total && total > 0) {
                      const fromTop = total - pos;
                      statusText = fromTop <= 1
                        ? 'Online · Highest role ✓'
                        : `Online · ${fromTop - 1} role${fromTop - 1 === 1 ? '' : 's'} above bot`;
                    }
                    if (ping != null) statusText += ` · ${ping}ms`;
                    return statusText;
                  })()
                : 'Bot not connected'}
            </CardDescription>
          </CardHeader>
        </Card>

        {/* Setup Status */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Setup</CardTitle>
              {guild?.setup_completed ? (
                <CheckCircle2 size={18} className="text-green-500" />
              ) : (
                <Rocket size={18} className="text-discord-text-muted" />
              )}
            </div>
            <CardDescription>
              {guild?.setup_completed
                ? 'Server setup complete'
                : 'Run the setup wizard to deploy roles & channels'}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      {/* Live Metrics */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-discord-text-muted uppercase tracking-wide">
          Live Metrics
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-4">
          <MetricCard
            icon={Users}
            label="Members"
            value={stats?.memberCount ?? '—'}
            subValue={stats?.trackedMembers ? `${stats.trackedMembers} tracked` : undefined}
            color="text-green-400"
          />
          <MetricCard
            icon={Ticket}
            label="Open Tickets"
            value={stats?.activeTickets ?? '—'}
            color="text-yellow-400"
          />
          <MetricCard
            icon={Shield}
            label="Active Infractions"
            value={stats?.openInfractions ?? '—'}
            color="text-red-400"
          />
          <MetricCard
            icon={DollarSign}
            label="Revenue (Month)"
            value={stats?.revenueThisMonth != null ? `$${(stats.revenueThisMonth / 100).toFixed(2)}` : '—'}
            color="text-emerald-400"
          />
          <MetricCard
            icon={Headphones}
            label="Voice Connections"
            value={stats?.activeVoice ?? '—'}
            color="text-purple-400"
          />
          <MetricCard
            icon={Activity}
            label="Active Giveaways"
            value={stats?.activeGiveaways ?? '—'}
            color="text-pink-400"
          />
          <MetricCard
            icon={Clock}
            label="Uptime"
            value={stats?.uptime ?? '—'}
            color="text-cyan-400"
          />
          <MetricCard
            icon={Wifi}
            label="Events Today"
            value={stats?.eventsToday ?? '—'}
            subValue={stats?.valkeyConnected ? 'Cache ✓' : 'No cache'}
            color="text-blue-400"
          />
        </div>
      </div>

      {/* Recent Activity */}
      {stats?.recentEvents && stats.recentEvents.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold text-discord-text-muted uppercase tracking-wide">
            Recent Activity
          </h2>
          <Card>
            <div className="divide-y divide-discord-bg-tertiary">
              {stats.recentEvents.slice(0, 8).map((event, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <ActivityDot type={event.type} />
                  <span className="flex-1 text-sm text-discord-text-secondary">
                    {event.description}
                  </span>
                  <span className="text-xs text-discord-text-muted">
                    {formatTimeAgo(event.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Quick Actions */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-discord-text-muted uppercase tracking-wide">
          Quick Actions
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Moderation', href: '/moderation/rules', icon: Shield, desc: 'AutoMod rules & infractions' },
            { label: 'Tickets', href: '/tickets', icon: Ticket, desc: 'Ticket panels & transcripts' },
            { label: 'Levels & XP', href: '/levels', icon: BarChart3, desc: 'XP rates, rewards & leaderboard' },
            { label: 'Music', href: '/music', icon: Music, desc: 'Music config & player' },
            { label: 'Store', href: '/store', icon: ShoppingCart, desc: 'Products, licenses & orders' },
            { label: 'Automations', href: '/automations', icon: Zap, desc: 'Event triggers & actions' },
            { label: 'Welcome', href: '/welcome', icon: Users, desc: 'Onboarding, greetings & cards' },
            { label: 'Settings', href: '/settings', icon: Settings, desc: 'Bot config & feature toggles' },
          ].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="group flex items-center gap-3 rounded-md bg-discord-bg-secondary p-3 text-sm transition-standard hover:bg-discord-bg-tertiary"
            >
              <link.icon
                size={20}
                className="text-discord-text-muted group-hover:text-discord-accent transition-colors"
              />
              <div>
                <div className="font-medium text-discord-text-secondary group-hover:text-discord-text-primary transition-colors">
                  {link.label}
                </div>
                <div className="text-xs text-discord-text-muted">{link.desc}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────

function MetricCard({
  icon: Icon,
  label,
  value,
  subValue,
  color,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string | number;
  subValue?: string;
  color: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Icon size={16} className={color} />
          <CardTitle className="text-xs font-medium text-discord-text-muted">{label}</CardTitle>
        </div>
        <div className="mt-1">
          <span className="text-2xl font-bold text-discord-text-primary">{value}</span>
          {subValue && (
            <span className="ml-2 text-xs text-discord-text-muted">{subValue}</span>
          )}
        </div>
      </CardHeader>
    </Card>
  );
}

function ActivityDot({ type }: { type: string }) {
  const colorMap: Record<string, string> = {
    'ticket.opened': 'bg-yellow-400',
    'ticket.closed': 'bg-green-400',
    'moderation.warn': 'bg-amber-400',
    'moderation.ban': 'bg-red-500',
    'moderation.kick': 'bg-orange-400',
    'moderation.mute': 'bg-amber-300',
    'purchase.completed': 'bg-emerald-400',
    'member.joined': 'bg-blue-400',
    'member.left': 'bg-gray-400',
    'giveaway.ended': 'bg-pink-400',
    'giveaway.started': 'bg-pink-300',
  };
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${colorMap[type] ?? 'bg-discord-text-muted'}`}
    />
  );
}

function formatTimeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
