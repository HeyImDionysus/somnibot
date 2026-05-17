'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import {
  Shield, Users, MessageSquare, Zap, Settings,
  CheckCircle2, XCircle, Loader2, Rocket,
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

/**
 * Dashboard Home — at-a-glance overview of bot status and server health.
 */
export default function DashboardPage() {
  const [data, setData] = useState<GuildData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/guild');
        if (res.ok) {
          const json = await res.json();
          setData(json);
        } else {
          setError(true);
        }
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
          Overview of your SomniBot instance
        </p>
      </div>

      {/* Status Cards */}
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
                    if (pos == null) return 'Online';
                    // Discord positions go bottom-up: 0 = @everyone.
                    // "Position from top" = total - pos (1 = highest)
                    if (total && total > 0) {
                      const fromTop = total - pos;
                      return fromTop <= 1
                        ? 'Online · Highest role ✓'
                        : `Online · ${fromTop - 1} role${fromTop - 1 === 1 ? '' : 's'} above bot`;
                    }
                    return 'Online';
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

      {/* Quick Links */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-discord-text-muted uppercase tracking-wide">
          Quick Actions
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Roles & Permissions', href: '/roles', icon: Shield },
            { label: 'Channels', href: '/channels', icon: MessageSquare },
            { label: 'Moderation', href: '/moderation/rules', icon: Shield },
            { label: 'Sync', href: '/sync', icon: Zap },
          ].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="flex items-center gap-3 rounded-md bg-discord-bg-secondary p-3 text-sm text-discord-text-secondary transition-standard hover:bg-discord-bg-tertiary hover:text-discord-text-primary"
            >
              <link.icon size={18} />
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
