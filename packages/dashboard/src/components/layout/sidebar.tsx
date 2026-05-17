'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { createClient } from '@/lib/supabase/client';
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
  Receipt,
  Tag,
  ScrollText,
  Activity,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Which integration is required — if not connected, item is greyed out */
  requires?: 'discord' | 'paypal' | 'lavalink';
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const navigation: NavGroup[] = [
  {
    title: 'Overview',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    ],
  },
  {
    title: 'Server',
    items: [
      { label: 'Roles & Permissions', href: '/roles', icon: Shield, requires: 'discord' },
      { label: 'Channels', href: '/channels', icon: MessageSquare, requires: 'discord' },
      { label: 'Onboarding', href: '/onboarding', icon: Users, requires: 'discord' },
      { label: 'Welcome & Goodbye', href: '/welcome', icon: Sparkles, requires: 'discord' },
      { label: 'Sync', href: '/sync', icon: Zap, requires: 'discord' },
    ],
  },
  {
    title: 'Moderation',
    items: [
      { label: 'Auto-Mod Rules', href: '/moderation/rules', icon: Shield, requires: 'discord' },
      { label: 'Infractions', href: '/moderation/infractions', icon: FileCode2, requires: 'discord' },
      { label: 'Ticket Panels', href: '/tickets', icon: Ticket, requires: 'discord' },
    ],
  },
  {
    title: 'Engagement',
    items: [
      { label: 'Levels & XP', href: '/levels', icon: Trophy, requires: 'discord' },
      { label: 'Reaction Roles', href: '/reaction-roles', icon: Palette, requires: 'discord' },
      { label: 'Giveaways', href: '/giveaways', icon: Gift, requires: 'discord' },
      { label: 'Scheduled Messages', href: '/scheduled-messages', icon: Clock, requires: 'discord' },
    ],
  },
  {
    title: 'Features',
    items: [
      { label: 'Music', href: '/music', icon: Music, requires: 'lavalink' },
      { label: 'Temp Channels', href: '/temp-channels', icon: Mic2, requires: 'discord' },
      { label: 'Stats Channels', href: '/stats-channels', icon: BarChart3, requires: 'discord' },
      { label: 'Embed Builder', href: '/embeds', icon: Palette, requires: 'discord' },
    ],
  },
  {
    title: 'Automation',
    items: [
      { label: 'Automations', href: '/automations', icon: Zap, requires: 'discord' },
      { label: 'Custom Commands', href: '/commands', icon: Terminal, requires: 'discord' },
    ],
  },
  {
    title: 'Commerce',
    items: [
      { label: 'Store', href: '/store', icon: ShoppingCart, requires: 'paypal' },
      { label: 'Orders', href: '/store/orders', icon: Receipt, requires: 'paypal' },
      { label: 'Customers', href: '/customers', icon: Users, requires: 'paypal' },
      { label: 'License Keys', href: '/licenses', icon: Key, requires: 'paypal' },
      { label: 'Promotions', href: '/store/promotions', icon: Tag, requires: 'paypal' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { label: 'Audit Log', href: '/audit', icon: ScrollText },
      { label: 'Diagnostics', href: '/diagnostics', icon: Activity },
    ],
  },
];

interface UserInfo {
  name: string;
  avatarUrl: string | null;
}

export function Sidebar() {
  const pathname = usePathname();
  const [user, setUser] = useState<UserInfo | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const supabase = createClient();
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (authUser) {
          const meta = authUser.user_metadata;
          setUser({
            name: meta?.full_name || meta?.name || meta?.custom_claims?.global_name || 'User',
            avatarUrl: meta?.avatar_url || null,
          });
        }
      } catch {
        // Ignore — sidebar still renders
      }
    })();
  }, []);

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
              // For now, nothing is locked — all items are navigable.
              // In the future, feature gating will check integration status from context.
              const isLocked = false;

              return (
                <Link
                  key={item.href}
                  href={isLocked ? '#' : item.href}
                  className={cn(
                    'group flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-sm transition-standard',
                    isActive && !isLocked
                      ? 'bg-discord-accent/20 text-white'
                      : isLocked
                        ? 'cursor-not-allowed text-discord-text-muted/50'
                        : 'text-discord-text-secondary hover:bg-discord-bg-primary/50 hover:text-discord-text-primary',
                  )}
                  onClick={isLocked ? (e) => e.preventDefault() : undefined}
                  aria-disabled={isLocked}
                >
                  <Icon
                    size={18}
                    className={cn(
                      isActive && !isLocked ? 'text-discord-accent' : '',
                      isLocked ? 'opacity-40' : '',
                    )}
                  />
                  <span className="flex-1 truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}

        {/* Settings — always at bottom of nav */}
        <div className="mb-4">
          <h3 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted">
            System
          </h3>
          <Link
            href="/settings"
            className={cn(
              'group flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-sm transition-standard',
              pathname === '/settings'
                ? 'bg-discord-accent/20 text-white'
                : 'text-discord-text-secondary hover:bg-discord-bg-primary/50 hover:text-discord-text-primary',
            )}
          >
            <Settings
              size={18}
              className={pathname === '/settings' ? 'text-discord-accent' : ''}
            />
            <span className="flex-1 truncate">Settings</span>
          </Link>
        </div>
      </nav>

      {/* Footer — user info */}
      <div className="border-t border-discord-border-subtle px-3 py-2">
        <div className="flex items-center gap-2">
          {user?.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              className="h-8 w-8 rounded-full"
            />
          ) : (
            <div className="h-8 w-8 rounded-full bg-discord-bg-tertiary" />
          )}
          <div className="flex-1 min-w-0">
            <p className="truncate text-sm font-medium text-discord-text-primary">
              {user?.name || 'Loading...'}
            </p>
            <p className="truncate text-xs text-discord-text-muted">Online</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
