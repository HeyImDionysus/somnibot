'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import {
  LayoutDashboard,
  Settings,
  Shield,
  Users,
  Zap,
  BarChart3,
  ShoppingCart,
  Music,
  Gift,
  MessageSquare,
  Ticket,
  Terminal,
  Palette,
  Trophy,
  Clock,
  Mic2,
  Sparkles,
  FileCode2,
  Key,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  locked?: boolean;
  phase?: number;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const navigation: NavGroup[] = [
  {
    title: 'Overview',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, locked: true, phase: 2 },
      { label: 'Setup', href: '/setup', icon: Settings },
    ],
  },
  {
    title: 'Server',
    items: [
      { label: 'Roles & Permissions', href: '/roles', icon: Shield, locked: true, phase: 2 },
      { label: 'Channels', href: '/channels', icon: MessageSquare, locked: true, phase: 2 },
      { label: 'Onboarding', href: '/onboarding', icon: Users, locked: true, phase: 3 },
      { label: 'Welcome & Goodbye', href: '/welcome', icon: Sparkles, locked: true, phase: 3 },
      { label: 'Sync', href: '/sync', icon: Zap, locked: true, phase: 2 },
    ],
  },
  {
    title: 'Moderation',
    items: [
      { label: 'Auto-Mod Rules', href: '/moderation/rules', icon: Shield, locked: true, phase: 4 },
      { label: 'Infractions', href: '/moderation/infractions', icon: FileCode2, locked: true, phase: 4 },
      { label: 'Ticket Panels', href: '/tickets', icon: Ticket, locked: true, phase: 4 },
    ],
  },
  {
    title: 'Engagement',
    items: [
      { label: 'Levels & XP', href: '/levels', icon: Trophy, locked: true, phase: 5 },
      { label: 'Reaction Roles', href: '/reaction-roles', icon: Palette, locked: true, phase: 5 },
      { label: 'Giveaways', href: '/giveaways', icon: Gift, locked: true, phase: 6 },
      { label: 'Scheduled Messages', href: '/scheduled-messages', icon: Clock, locked: true, phase: 6 },
    ],
  },
  {
    title: 'Features',
    items: [
      { label: 'Music', href: '/music', icon: Music, locked: true, phase: 7 },
      { label: 'Temp Channels', href: '/temp-channels', icon: Mic2, locked: true, phase: 8 },
      { label: 'Stats Channels', href: '/stats-channels', icon: BarChart3, locked: true, phase: 8 },
      { label: 'Embed Builder', href: '/embeds', icon: Palette, locked: true, phase: 6 },
    ],
  },
  {
    title: 'Automation',
    items: [
      { label: 'Automations', href: '/automations', icon: Zap, locked: true, phase: 9 },
      { label: 'Custom Commands', href: '/commands', icon: Terminal, locked: true, phase: 9 },
    ],
  },
  {
    title: 'Commerce',
    items: [
      { label: 'Store', href: '/store', icon: ShoppingCart, locked: true, phase: 10 },
      { label: 'Customers', href: '/customers', icon: Users, locked: true, phase: 10 },
      { label: 'License Keys', href: '/licenses', icon: Key, locked: true, phase: 10 },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-60 flex-col border-r border-discord-border-subtle bg-discord-bg-secondary">
      {/* Brand */}
      <div className="flex h-12 items-center border-b border-discord-border-subtle px-4">
        <span className="text-base font-bold text-discord-text-primary">SomniBot</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {navigation.map((group) => (
          <div key={group.title} className="mb-4">
            <h3 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted">
              {group.title}
            </h3>
            {group.items.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.locked ? '#' : item.href}
                  className={cn(
                    'group flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-sm transition-standard',
                    isActive && !item.locked
                      ? 'bg-discord-accent/20 text-white'
                      : item.locked
                        ? 'cursor-not-allowed text-discord-text-muted/50'
                        : 'text-discord-text-secondary hover:bg-discord-bg-primary/50 hover:text-discord-text-primary',
                  )}
                  onClick={item.locked ? (e) => e.preventDefault() : undefined}
                  aria-disabled={item.locked}
                >
                  <Icon
                    size={18}
                    className={cn(
                      isActive && !item.locked ? 'text-discord-accent' : '',
                      item.locked ? 'opacity-40' : '',
                    )}
                  />
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.locked && (
                    <span className="rounded-sm bg-discord-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-discord-text-muted">
                      P{item.phase}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer — user info placeholder */}
      <div className="border-t border-discord-border-subtle px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-discord-bg-tertiary" />
          <div className="flex-1 min-w-0">
            <p className="truncate text-sm font-medium text-discord-text-primary">Owner</p>
            <p className="truncate text-xs text-discord-text-muted">Online</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
