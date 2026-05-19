'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Home } from 'lucide-react';

/**
 * Route label overrides — maps URL segments to human-readable names.
 * Nested sub-pages (e.g. /moderation/infractions) are handled automatically
 * by splitting the pathname and looking up each segment.
 */
const LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  roles: 'Roles & Permissions',
  channels: 'Channels',
  onboarding: 'Onboarding',
  welcome: 'Welcome & Goodbye',
  sync: 'Sync',
  moderation: 'Moderation',
  rules: 'Auto-Mod Rules',
  infractions: 'Infractions',
  levels: 'Levels & XP',
  'reaction-roles': 'Reaction Roles',
  giveaways: 'Giveaways',
  'scheduled-messages': 'Scheduled Messages',
  music: 'Music',
  'temp-channels': 'Temp Channels',
  'stats-channels': 'Stats Channels',
  embeds: 'Embed Builder',
  automations: 'Automations',
  commands: 'Custom Commands',
  analytics: 'Analytics',
  store: 'Store',
  orders: 'Orders',
  customers: 'Customers',
  licenses: 'License Keys',
  promotions: 'Promotions',
  incidents: 'Incidents',
  fraud: 'Fraud Controls',
  workflows: 'Workflows',
  'admin-changes': 'Admin Changes',
  audit: 'Audit Log',
  diagnostics: 'Diagnostics',
  settings: 'Settings',
  team: 'Team',
  tickets: 'Ticket Panels',
  transcripts: 'Transcripts',
  'server-setup': 'Server Setup',
};

interface Crumb {
  label: string;
  href: string;
}

export function Breadcrumb() {
  const pathname = usePathname();

  // Don't render on the main dashboard
  if (pathname === '/dashboard') return null;

  const segments = pathname.replace(/^\//, '').split('/').filter(Boolean);
  if (segments.length < 1) return null;

  const crumbs: Crumb[] = [];
  let currentPath = '';
  for (const seg of segments) {
    currentPath += `/${seg}`;
    crumbs.push({
      label: LABELS[seg] || seg.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      href: currentPath,
    });
  }

  return (
    <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1.5 text-sm">
      <Link
        href="/dashboard"
        className="flex items-center gap-1 text-discord-text-muted hover:text-discord-text-primary transition-colors"
      >
        <Home size={14} />
      </Link>
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={crumb.href} className="flex items-center gap-1.5">
            <ChevronRight size={12} className="text-discord-text-muted/50" />
            {isLast ? (
              <span className="font-medium text-discord-text-primary">{crumb.label}</span>
            ) : (
              <Link
                href={crumb.href}
                className="text-discord-text-muted hover:text-discord-text-primary transition-colors"
              >
                {crumb.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
