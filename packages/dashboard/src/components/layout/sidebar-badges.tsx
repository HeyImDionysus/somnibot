/**
 * SidebarBadges — Count badges for sidebar navigation items.
 *
 * Counts are server-driven: fetched from /api/counts (service role, so
 * RLS-locked tables like action_queue_dlq still work) and refreshed by
 * interval polling. Supabase Realtime is deliberately NOT used here —
 * none of the badge tables are in the supabase_realtime publication,
 * and action_queue_dlq revokes client grants entirely, so client-side
 * postgres_changes subscriptions can never receive events.
 *
 * All badges share ONE poll: SidebarBadgesProvider fetches every badge
 * table in a single batched /api/counts?tables=... request per interval
 * and hands counts to each badge via context. This avoids the thundering
 * herd of one request per badge (which, with four badges and a per-IP
 * rate limit, could self-DoS the route in shared-NAT / many-tab setups).
 *
 * GAP 4: Operator UX Polish
 */
'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** Matches the layout-banner polling cadence (bot-status-banner.tsx). */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Tables backing the pre-configured badges — fetched in one batch. */
const BADGE_TABLES = ['tickets', 'orders', 'giveaways', 'action_queue_dlq'] as const;

type CountsMap = Record<string, number>;

const SidebarBadgesContext = createContext<CountsMap>({});

interface SidebarBadgesProviderProps {
  children: ReactNode;
  /** How often to refresh the counts (ms). Defaults to 30s. */
  pollIntervalMs?: number;
}

/**
 * Fetches all badge counts in one batched request and shares them with
 * every SidebarBadge below it. Wrap the sidebar nav in this provider.
 */
export function SidebarBadgesProvider({
  children,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: SidebarBadgesProviderProps) {
  const [counts, setCounts] = useState<CountsMap>({});

  useEffect(() => {
    let cancelled = false;
    const url = `/api/counts?tables=${encodeURIComponent(BADGE_TABLES.join(','))}`;

    async function fetchCounts() {
      try {
        const res = await fetch(url);
        const json = await res.json();
        if (!cancelled && json && typeof json.counts === 'object' && json.counts !== null) {
          setCounts(json.counts as CountsMap);
        }
      } catch {
        // Non-critical — keep the last known counts
      }
    }

    fetchCounts();
    const timer = setInterval(fetchCounts, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollIntervalMs]);

  return (
    <SidebarBadgesContext.Provider value={counts}>
      {children}
    </SidebarBadgesContext.Provider>
  );
}

interface SidebarBadgeProps {
  /** Table name — must be in /api/counts ALLOWED_TABLES. Status filters are applied server-side. */
  table: string;
  className?: string;
}

/**
 * Renders the shared count for `table` (from SidebarBadgesProvider).
 * Renders nothing when the count is 0 or not yet loaded.
 */
export function SidebarBadge({ table, className }: SidebarBadgeProps) {
  const counts = useContext(SidebarBadgesContext);
  const count = counts[table] ?? 0;

  if (count === 0) return null;

  return (
    <span
      className={`ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-discord-accent px-1.5 text-[10px] font-bold text-white ${className ?? ''}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * Pre-configured badges for common sidebar items.
 */
export function OpenTicketsBadge() {
  return <SidebarBadge table="tickets" />;
}

export function PendingOrdersBadge() {
  return <SidebarBadge table="orders" />;
}

export function ActiveGiveawaysBadge() {
  return <SidebarBadge table="giveaways" />;
}

/**
 * V53 Phase 2: DLQ badge — shows count of pending failed actions
 * (acknowledged = false AND retried = false, applied server-side).
 * The DLQ count is owner-gated server-side, so non-owners always see 0.
 */
export function DlqBadge() {
  return <SidebarBadge table="action_queue_dlq" />;
}
