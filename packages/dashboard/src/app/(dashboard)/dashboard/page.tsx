'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import {
  Shield, Users, MessageSquare, Zap, Settings,
  CheckCircle2, XCircle, Loader2,
} from 'lucide-react';
import Link from 'next/link';

interface GuildStatus {
  connected: boolean;
  name?: string;
  memberCount?: number;
  setupCompleted?: boolean;
}

/**
 * Dashboard Home — at-a-glance overview of bot status and server health.
 */
export default function DashboardPage() {
  const [guild, setGuild] = useState<GuildStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/guild');
        if (res.ok) {
          const data = await res.json();
          setGuild({
            connected: true,
            name: data.name,
            memberCount: data.member_count,
            setupCompleted: data.setup_completed,
          });
        } else {
          setGuild({ connected: false });
        }
      } catch {
        setGuild({ connected: false });
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
        {/* Server Status */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Server</CardTitle>
              {guild?.connected ? (
                <CheckCircle2 size={18} className="text-green-500" />
              ) : (
                <XCircle size={18} className="text-red-500" />
              )}
            </div>
            <CardDescription>
              {guild?.connected
                ? guild.name || 'Connected'
                : 'Not connected — configure Discord in Settings'}
            </CardDescription>
          </CardHeader>
        </Card>

        {/* Setup Status */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Setup</CardTitle>
              {guild?.setupCompleted ? (
                <CheckCircle2 size={18} className="text-green-500" />
              ) : (
                <Settings size={18} className="text-discord-text-muted" />
              )}
            </div>
            <CardDescription>
              {guild?.setupCompleted
                ? 'Server setup complete'
                : 'Run the setup wizard to configure roles & channels'}
            </CardDescription>
          </CardHeader>
        </Card>

        {/* Members */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Members</CardTitle>
              <Users size={18} className="text-discord-text-muted" />
            </div>
            <CardDescription>
              {guild?.memberCount != null
                ? `${guild.memberCount} members`
                : '—'}
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
