'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils/cn';
import { GuildSelector } from '@/components/guild-selector';
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
  TrendingUp,
  AlertTriangle,
  Siren,
  Workflow,
  History,
  UserCog,
  ChevronDown,
  Coins,
  Store,
  Hammer,
  Sprout,
  Fish,
  Swords,
  Brain,
  Gamepad2,
  PawPrint,
  Award,
  Pickaxe,
  BookOpen,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  requires?: 'discord' | 'paypal' | 'lavalink';
}

interface NavGroup {
  id: string;
  title: string;
  items: NavItem[];
  /** If true, this group is never collapsible (always shown) */
  alwaysOpen?: boolean;
}

const navigation: NavGroup[] = [
  {
    id: 'overview',
    title: 'Overview',
    alwaysOpen: true,
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    ],
  },
  {
    id: 'server',
    title: 'Server',
    items: [
      { label: 'Roles & Permissions', href: '/roles', icon: Shield, requires: 'discord' },
      { label: 'Channels', href: '/channels', icon: MessageSquare, requires: 'discord' },
      { label: 'Onboarding', href: '/onboarding', icon: Users, requires: 'discord' },
      { label: 'Welcome & Goodbye', href: '/welcome', icon: Sparkles, requires: 'discord' },
      { label: 'Members', href: '/members', icon: Users, requires: 'discord' },
      { label: 'Sync', href: '/sync', icon: Zap, requires: 'discord' },
    ],
  },
  {
    id: 'moderation',
    title: 'Moderation',
    items: [
      { label: 'Auto-Mod Rules', href: '/moderation/rules', icon: Shield, requires: 'discord' },
      { label: 'Infractions', href: '/moderation/infractions', icon: FileCode2, requires: 'discord' },
      { label: 'Ticket Panels', href: '/tickets', icon: Ticket, requires: 'discord' },
    ],
  },
  {
    id: 'engagement',
    title: 'Engagement',
    items: [
      { label: 'Levels & XP', href: '/levels', icon: Trophy, requires: 'discord' },
      { label: 'Reaction Roles', href: '/reaction-roles', icon: Palette, requires: 'discord' },
      { label: 'Giveaways', href: '/giveaways', icon: Gift, requires: 'discord' },
      { label: 'Scheduled Messages', href: '/scheduled-messages', icon: Clock, requires: 'discord' },
      { label: 'Economy', href: '/economy', icon: Coins, requires: 'discord' },
      { label: 'Econ Analytics', href: '/economy/analytics', icon: TrendingUp, requires: 'discord' },
      { label: 'Shop Items', href: '/economy/shop', icon: Store, requires: 'discord' },
      { label: 'Gathering', href: '/economy/gathering', icon: Pickaxe, requires: 'discord' },
      { label: 'Crafting', href: '/economy/crafting', icon: Hammer, requires: 'discord' },
      { label: 'Farming', href: '/economy/farming', icon: Sprout, requires: 'discord' },
      { label: 'Fishing', href: '/economy/fishing', icon: Fish, requires: 'discord' },
      { label: 'Adventures', href: '/economy/adventures', icon: Swords, requires: 'discord' },
      { label: 'Market', href: '/economy/market', icon: Store, requires: 'discord' },
      { label: 'Trivia', href: '/economy/trivia', icon: Brain, requires: 'discord' },
      { label: 'Heists', href: '/economy/heist', icon: Swords, requires: 'discord' },
      { label: 'Games & Lottery', href: '/economy/games', icon: Gamepad2, requires: 'discord' },
      { label: 'Pets', href: '/economy/pets', icon: PawPrint, requires: 'discord' },
      { label: 'Quests', href: '/economy/quests', icon: ScrollText, requires: 'discord' },
      { label: 'Achievements', href: '/economy/achievements', icon: Award, requires: 'discord' },
      { label: 'Tutorial', href: '/tutorial', icon: BookOpen, requires: 'discord' },
    ],
  },
  {
    id: 'features',
    title: 'Features',
    items: [
      { label: 'Polls & Predictions', href: '/polls', icon: BarChart3, requires: 'discord' },
      { label: 'Music', href: '/music', icon: Music, requires: 'lavalink' },
      { label: 'Temp Channels', href: '/temp-channels', icon: Mic2, requires: 'discord' },
      { label: 'Stats Channels', href: '/stats-channels', icon: BarChart3, requires: 'discord' },
      { label: 'Embed Builder', href: '/embeds', icon: Palette, requires: 'discord' },
    ],
  },
  {
    id: 'automation',
    title: 'Automation',
    items: [
      { label: 'Automations', href: '/automations', icon: Zap, requires: 'discord' },
      { label: 'Custom Commands', href: '/commands', icon: Terminal, requires: 'discord' },
      { label: 'Failed Actions', href: '/action-queue', icon: AlertTriangle, requires: 'discord' },
    ],
  },
  {
    id: 'commerce',
    title: 'Commerce',
    items: [
      { label: 'Analytics', href: '/analytics', icon: TrendingUp },
      { label: 'Store', href: '/store', icon: ShoppingCart, requires: 'paypal' },
      { label: 'Orders', href: '/store/orders', icon: Receipt, requires: 'paypal' },
      { label: 'Customers', href: '/customers', icon: Users, requires: 'paypal' },
      { label: 'License Keys', href: '/licenses', icon: Key, requires: 'paypal' },
      { label: 'Promotions', href: '/store/promotions', icon: Tag, requires: 'paypal' },
    ],
  },
  {
    id: 'operations',
    title: 'Operations',
    items: [
      { label: 'Incidents', href: '/incidents', icon: Siren },
      { label: 'Fraud Controls', href: '/fraud', icon: AlertTriangle },
      { label: 'Workflows', href: '/workflows', icon: Workflow },
      { label: 'Admin Changes', href: '/admin-changes', icon: History },
      { label: 'Audit Log', href: '/audit', icon: ScrollText },
      { label: 'Diagnostics', href: '/diagnostics', icon: Activity },
    ],
  },
];

const STORAGE_KEY = 'somnibot-sidebar-collapsed';

function loadCollapsed(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveCollapsed(state: Record<string, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}

interface UserInfo {
  name: string;
  avatarUrl: string | null;
}

export function Sidebar() {
  const pathname = usePathname();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setCollapsed(loadCollapsed());
  }, []);

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

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [groupId]: !prev[groupId] };
      saveCollapsed(next);
      return next;
    });
  }, []);

  /** Check if any item in a group is active (used to auto-expand) */
  const groupHasActive = useCallback(
    (group: NavGroup) =>
      group.items.some(
        (item) => pathname === item.href || pathname.startsWith(item.href + '/'),
      ),
    [pathname],
  );

  return (
    <aside className="flex h-screen w-60 flex-col border-r border-discord-border-subtle bg-discord-bg-secondary">
      {/* Brand */}
      <div className="flex h-14 items-center gap-2.5 border-b border-discord-border-subtle px-3">
        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-xl ring-1 ring-white/10">
          <Image
            src="/somnibot-logo.png"
            alt="SomniBot"
            width={36}
            height={36}
            className="h-full w-full object-cover"
          />
        </div>
        <span className="text-base font-bold text-discord-text-primary">SomniBot</span>
      </div>

      {/* Guild Selector (multi-guild — V53 Phase 4) */}
      <GuildSelector />

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {navigation.map((group) => {
          const isCollapsed = collapsed[group.id] && !group.alwaysOpen && !groupHasActive(group);

          return (
            <div key={group.id} className="mb-1">
              {/* Group header */}
              {group.alwaysOpen ? (
                <h3 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted">
                  {group.title}
                </h3>
              ) : (
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="mb-1 flex w-full items-center justify-between px-2 text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted hover:text-discord-text-secondary transition-colors"
                >
                  <span>{group.title}</span>
                  <ChevronDown
                    size={12}
                    className={cn(
                      'transition-transform duration-200',
                      isCollapsed && '-rotate-90',
                    )}
                  />
                </button>
              )}

              {/* Items — animate collapse */}
              <div
                className={cn(
                  'overflow-hidden transition-all duration-200',
                  isCollapsed ? 'max-h-0 opacity-0' : 'max-h-[500px] opacity-100',
                )}
              >
                {group.items.map((item) => {
                  const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
                  const Icon = item.icon;
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

              {/* Spacer after group */}
              <div className={cn(isCollapsed ? 'mb-1' : 'mb-3')} />
            </div>
          );
        })}

        {/* Settings — always at bottom of nav */}
        <div className="mb-4">
          <h3 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted">
            System
          </h3>
          <Link
            href="/settings/team"
            className={cn(
              'group flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-sm transition-standard',
              pathname === '/settings/team'
                ? 'bg-discord-accent/20 text-white'
                : 'text-discord-text-secondary hover:bg-discord-bg-primary/50 hover:text-discord-text-primary',
            )}
          >
            <UserCog
              size={18}
              className={pathname === '/settings/team' ? 'text-discord-accent' : ''}
            />
            <span className="flex-1 truncate">Team</span>
          </Link>
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
            <Image
              src={user.avatarUrl}
              alt=""
              width={32}
              height={32}
              unoptimized
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
